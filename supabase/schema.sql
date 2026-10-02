-- Um Doce Até o Diploma: schema de produção (Supabase / Postgres)
-- Execute no SQL Editor do Supabase. Idempotente: pode rodar de novo com segurança.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------
-- Tabelas
-- ------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null default 'Administradora',
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'doces' check (category in ('doces', 'salgados')),
  description text not null default '',
  price numeric(10, 2) not null check (price >= 0),
  cost numeric(10, 2) not null default 0 check (cost >= 0),
  image text not null default '',
  badge text not null default '',
  active boolean not null default true,
  featured boolean not null default false,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  customer_name text not null check (char_length(customer_name) between 2 and 80),
  phone text not null check (phone ~ '^[0-9]{12,13}$'),
  items jsonb not null,            -- [{product_id, name, qty, unit_price, unit_cost}] (snapshot do momento da compra)
  total numeric(10, 2) not null,
  cost_total numeric(10, 2) not null,
  channel text not null default 'web' check (channel in ('web', 'whatsapp', 'grupo', 'balcao')),
  status text not null default 'novo' check (status in ('novo', 'confirmado', 'producao', 'pronto', 'entregue', 'cancelado')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_created_idx on public.orders (created_at desc);
create index if not exists orders_phone_idx on public.orders (phone);
create index if not exists orders_status_idx on public.orders (status);

create table if not exists public.news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  image text not null default '',
  channels text[] not null default '{site}',
  published boolean not null default true,
  author text not null default '',
  wa_sent_at timestamptz,         -- preenchido pelo bot quando a novidade sai no WhatsApp
  created_at timestamptz not null default now()
);
alter table public.news add column if not exists wa_sent_at timestamptz;

create table if not exists public.bot_admins (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name text not null,
  can_post boolean not null default true,
  can_manage_orders boolean not null default false
);

create table if not exists public.subscribers (
  phone text primary key,
  name text,
  created_at timestamptz not null default now()
);

create table if not exists public.bot_sessions (
  phone text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null default '{}'
);

-- ------------------------------------------------------------------
-- Funções
-- ------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders for each row execute function public.touch_updated_at();

-- Cria o pedido calculando preço e custo NO SERVIDOR (o cliente nunca define valores).
create or replace function public.place_order(
  p_name text, p_phone text, p_items jsonb, p_channel text default 'web', p_notes text default ''
) returns json
-- "extensions": no Supabase o pgcrypto (gen_random_bytes, usado no código do pedido) fica nesse esquema.
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_cost numeric := 0;
  v_code text;
  r record;
  v_accepting boolean;
begin
  select coalesce((value->>'accepting')::boolean, true) into v_accepting from settings where key = 'store';
  if v_accepting is false and not is_admin() then
    raise exception 'Não estamos aceitando encomendas no momento';
  end if;
  if p_channel not in ('web', 'whatsapp', 'grupo', 'balcao') then raise exception 'canal inválido'; end if;
  if p_channel = 'balcao' and not is_admin() then raise exception 'canal inválido'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then
    raise exception 'itens inválidos';
  end if;

  for r in
    select p.id, p.name, p.price, p.cost, least(greatest((i->>'qty')::int, 1), 500) as qty
    from jsonb_array_elements(p_items) i
    join products p on p.id = (i->>'product_id')::uuid and p.active
  loop
    v_items := v_items || jsonb_build_object('product_id', r.id, 'name', r.name, 'qty', r.qty, 'unit_price', r.price, 'unit_cost', r.cost);
    v_total := v_total + r.qty * r.price;
    v_cost := v_cost + r.qty * r.cost;
  end loop;
  if jsonb_array_length(v_items) = 0 then raise exception 'Produto indisponível'; end if;

  loop
    v_code := 'DD-' || upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=0O1Il', ''), 1, 4));
    exit when length(v_code) = 7 and not exists (select 1 from orders where code = v_code);
  end loop;

  insert into orders (code, customer_name, phone, items, total, cost_total, channel, notes)
  values (v_code, trim(p_name), regexp_replace(p_phone, '\D', '', 'g'), v_items, v_total, v_cost, p_channel, left(coalesce(p_notes, ''), 300));

  return json_build_object('code', v_code, 'total', v_total);
end $$;

-- Cartão fidelidade: retorna só a contagem (não expõe pedidos).
create or replace function public.loyalty_stamps(p_phone text) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from orders where phone = regexp_replace(p_phone, '\D', '', 'g') and status = 'entregue';
$$;

grant execute on function public.place_order(text, text, jsonb, text, text) to anon, authenticated;
grant execute on function public.loyalty_stamps(text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ------------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------------
alter table public.admins enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.news enable row level security;
alter table public.bot_admins enable row level security;
alter table public.subscribers enable row level security;
alter table public.bot_sessions enable row level security;
alter table public.settings enable row level security;

drop policy if exists "admins read self" on public.admins;
create policy "admins read self" on public.admins for select using (user_id = auth.uid());

drop policy if exists "products public read" on public.products;
create policy "products public read" on public.products for select using (active or public.is_admin());
drop policy if exists "products admin write" on public.products;
create policy "products admin write" on public.products for all using (public.is_admin()) with check (public.is_admin());

-- Pedidos: ninguém lê nem insere diretamente, exceto admin. Clientes usam place_order().
drop policy if exists "orders admin" on public.orders;
create policy "orders admin" on public.orders for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "news public read" on public.news;
create policy "news public read" on public.news for select using ((published and 'site' = any (channels)) or public.is_admin());
drop policy if exists "news admin write" on public.news;
create policy "news admin write" on public.news for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "bot_admins admin" on public.bot_admins;
create policy "bot_admins admin" on public.bot_admins for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "subscribers admin" on public.subscribers;
create policy "subscribers admin" on public.subscribers for select using (public.is_admin());
-- bot_sessions: apenas service role (Edge Function). Sem políticas = sem acesso pelo navegador.

drop policy if exists "settings public read" on public.settings;
create policy "settings public read" on public.settings for select using (key = 'store');
drop policy if exists "settings admin write" on public.settings;
create policy "settings admin write" on public.settings for all using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------------
-- Dados iniciais
-- ------------------------------------------------------------------
insert into public.settings (key, value) values
  ('store', '{"accepting": true, "notice": "Encomendas com 1 dia de antecedência", "pix_key": "", "bot_greeting": "Oi! 🎓🍫 Aqui é a Um Doce Até o Diploma."}')
on conflict (key) do nothing;

insert into public.products (name, category, description, price, cost, image, badge, featured, sort)
select * from (values
  ('Brigadeiro', 'doces', 'Chocolate nobre e granulado crocante. O clássico que nunca falha!', 4.00, 1.35, 'assets/img/brigadeiro.jpg', 'O clássico', false, 0),
  ('Casadinho', 'doces', 'Metade brigadeiro, metade beijinho com toque de morango. Um casamento perfeito.', 4.00, 1.50, 'assets/img/casadinho.jpg', '', false, 1),
  ('Caixinha 4 docinhos', 'doces', '2 brigadeiros + 2 casadinhos na caixinha. Perfeita para presentear.', 15.00, 5.90, 'assets/img/brigadeiro-casadinho.jpg', 'Mais pedido', true, 2),
  ('Morango Cravejado', 'doces', 'Morango fresco envolto em chocolate branco com pedaços de morango. Crocante por fora, irresistível por dentro!', 12.00, 4.60, 'assets/img/morango-cravejado.jpg', 'Novidade', true, 3),
  ('Empadinha de Frango com Catupiry', 'salgados', 'Massa macia que derrete, recheio bem temperado e muito Catupiry.', 8.00, 3.10, 'assets/img/empadinha.jpg', '', true, 4)
) as v(name, category, description, price, cost, image, badge, featured, sort)
where not exists (select 1 from public.products);

-- Depois de criar a usuária em Authentication → Users, libere o acesso ao painel:
--   insert into public.admins (user_id, name) select id, 'Cris' from auth.users where email = 'email-da-cris@exemplo.com';
