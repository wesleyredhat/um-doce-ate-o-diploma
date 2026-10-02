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
alter table public.orders add column if not exists coupon_code text;
alter table public.orders add column if not exists discount numeric(10, 2) not null default 0;
-- Entrega: 'ponto' = lugar fixo com dia marcado (settings.store.delivery_spot), 'combinar' = outro local ou retirada.
alter table public.orders add column if not exists delivery text not null default 'combinar' check (delivery in ('ponto', 'combinar'));
alter table public.orders add column if not exists delivery_date date;

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

-- Cupons de desconto. Regras em coupon_discount(); espelho em JS: assets/js/coupons.js.
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{3,20}$'),
  kind text not null default 'percent' check (kind in ('percent', 'fixed')),
  value numeric(10, 2) not null,
  min_order numeric(10, 2) not null default 0 check (min_order >= 0),
  starts_on date,
  ends_on date,
  max_uses int check (max_uses > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (value > 0 and (kind = 'fixed' or value <= 100)),
  check (ends_on >= starts_on)
);

-- Quem respondeu "parar promoções" ou "parar novidades": não recebe campanhas nem novidades.
create table if not exists public.optouts (
  phone_key text primary key,
  phone text not null,
  created_at timestamptz not null default now()
);

-- Campanhas pelo WhatsApp: cada pessoa vira uma linha em campaign_sends, que o bot envia aos poucos (bot/sender.js).
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  coupon_id uuid references public.coupons (id) on delete set null,
  audience jsonb not null default '{}',
  status text not null default 'pausada' check (status in ('enviando', 'pausada', 'concluida', 'cancelada')),
  pause_reason text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.campaign_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  phone text not null,
  phone_key text not null,
  name text not null default '',
  status text not null default 'pendente' check (status in ('pendente', 'enviando', 'enviada', 'falhou', 'pulada')),
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (campaign_id, phone_key)
);
create index if not exists campaign_sends_queue_idx on public.campaign_sends (campaign_id, status);
create index if not exists campaign_sends_sent_idx on public.campaign_sends (sent_at) where status = 'enviada';

-- Avisos automáticos do pedido pelo WhatsApp (bot/notices.js): Pix na confirmação e "pronto para entrega".
-- O gatilho orders_notice cria a linha quando o status muda; uma por pedido e tipo, então não repete.
create table if not exists public.order_notices (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  kind text not null check (kind in ('confirmado', 'pronto')),
  status text not null default 'pendente' check (status in ('pendente', 'enviando', 'enviada', 'falhou', 'pulada')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (order_id, kind)
);
create index if not exists order_notices_pending_idx on public.order_notices (id) where status = 'pendente';

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

-- Mesma pessoa com e sem o 9 do celular: o número antigo ganha o 9; fixo fica como está.
-- Igual a phoneKey (assets/js/coupons.js) e a samePhone (bot-engine.js).
create or replace function public.phone_key(p text) returns text
language sql immutable set search_path = public as $$
  with a as (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d),
       b as (select case when length(d) in (10, 11) then '55' || d else d end as d from a)
  select case when d ~ '^55[0-9]{10}$' and substr(d, 5, 1) between '6' and '9' then left(d, 4) || '9' || substr(d, 5) else d end from b;
$$;

-- Regras do cupom (espelho em JS: assets/js/coupons.js). Devolve o desconto ou recusa com a mensagem para o cliente.
-- p_lock trava a linha do cupom até o fim da transação: dois pedidos ao mesmo tempo não passam da cota.
create or replace function public.coupon_discount(p_code text, p_phone text, p_subtotal numeric, p_lock boolean default false)
returns numeric language plpgsql set search_path = public as $$
declare
  c coupons;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if p_lock then
    select * into c from coupons where code = upper(trim(p_code)) for update;
  else
    select * into c from coupons where code = upper(trim(p_code));
  end if;
  if not found then raise exception 'Cupom não encontrado'; end if;
  if not c.active then raise exception 'Cupom pausado'; end if;
  if c.starts_on is not null and v_today < c.starts_on then raise exception 'Cupom ainda não começou'; end if;
  if c.ends_on is not null and v_today > c.ends_on then raise exception 'Cupom expirado'; end if;
  if c.max_uses is not null
     and (select count(*) from orders where coupon_code = c.code and status <> 'cancelado') >= c.max_uses then
    raise exception 'Cupom esgotado';
  end if;
  if exists (select 1 from orders where coupon_code = c.code and status <> 'cancelado' and phone_key(phone) = phone_key(p_phone)) then
    raise exception 'Você já usou este cupom';
  end if;
  if p_subtotal < c.min_order then
    raise exception 'Vale para pedidos a partir de R$ %', replace(to_char(c.min_order, 'FM999990.00'), '.', ',');
  end if;
  return round(least(p_subtotal, case when c.kind = 'percent' then p_subtotal * c.value / 100 else c.value end), 2);
end $$;

-- Cria o pedido calculando preço, custo e desconto NO SERVIDOR (o cliente nunca define valores).
drop function if exists public.place_order(text, text, jsonb, text, text);
drop function if exists public.place_order(text, text, jsonb, text, text, text);
create or replace function public.place_order(
  p_name text, p_phone text, p_items jsonb, p_channel text default 'web', p_notes text default '', p_coupon text default null,
  p_delivery text default 'combinar', p_delivery_date date default null
) returns json
-- "extensions": no Supabase o pgcrypto (gen_random_bytes, usado no código do pedido) fica nesse esquema.
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_cost numeric := 0;
  v_coupon text := nullif(upper(trim(coalesce(p_coupon, ''))), '');
  v_discount numeric := 0;
  v_code text;
  r record;
  v_accepting boolean;
  v_spot jsonb;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select coalesce((value->>'accepting')::boolean, true), value->'delivery_spot' into v_accepting, v_spot from settings where key = 'store';
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

  -- Entrega no ponto: um dos dias marcados em Ajustes, de amanhã até 14 dias (mesma regra de delivery.js).
  if coalesce(p_delivery, 'combinar') not in ('ponto', 'combinar') then raise exception 'Forma de entrega inválida'; end if;
  if p_delivery = 'ponto' and (p_delivery_date is null or p_delivery_date <= v_today or p_delivery_date > v_today + 14
     or not coalesce(v_spot->'days' @> to_jsonb(extract(dow from p_delivery_date)::int), false)) then
    raise exception 'Escolha um dos dias de entrega disponíveis';
  end if;

  if v_coupon is not null then
    v_discount := coupon_discount(v_coupon, p_phone, v_total, true);
  end if;

  loop
    v_code := 'DD-' || upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=0O1Il', ''), 1, 4));
    exit when length(v_code) = 7 and not exists (select 1 from orders where code = v_code);
  end loop;

  insert into orders (code, customer_name, phone, items, total, cost_total, channel, notes, coupon_code, discount, delivery, delivery_date)
  values (v_code, trim(p_name), regexp_replace(p_phone, '\D', '', 'g'), v_items, v_total - v_discount, v_cost, p_channel,
          left(coalesce(p_notes, ''), 300), v_coupon, v_discount, coalesce(p_delivery, 'combinar'),
          case when p_delivery = 'ponto' then p_delivery_date end);

  return json_build_object('code', v_code, 'total', v_total - v_discount, 'subtotal', v_total, 'discount', v_discount, 'coupon', v_coupon,
                           'delivery', coalesce(p_delivery, 'combinar'), 'delivery_date', case when p_delivery = 'ponto' then p_delivery_date end);
end $$;

-- Cartão fidelidade: retorna só a contagem (não expõe pedidos).
create or replace function public.loyalty_stamps(p_phone text) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from orders where phone = regexp_replace(p_phone, '\D', '', 'g') and status = 'entregue';
$$;

-- Reabrir pedido cancelado com cupom (no painel) confere de novo a cota e o "uma vez por WhatsApp":
-- o cancelamento devolveu o uso, que pode ter sido ocupado por outro pedido.
create or replace function public.orders_coupon_reopen() returns trigger
language plpgsql set search_path = public as $$
declare
  c coupons;
begin
  if old.status = 'cancelado' and new.status <> 'cancelado' and new.coupon_code is not null then
    select * into c from coupons where code = new.coupon_code for update;
    if found and c.max_uses is not null
       and (select count(*) from orders where coupon_code = c.code and status <> 'cancelado' and id <> new.id) >= c.max_uses then
      raise exception 'Não dá para reabrir: o cupom % esgotou depois do cancelamento', new.coupon_code;
    end if;
    if exists (select 1 from orders where coupon_code = new.coupon_code and status <> 'cancelado' and id <> new.id
               and phone_key(phone) = phone_key(new.phone)) then
      raise exception 'Não dá para reabrir: este WhatsApp já usou o cupom % em outro pedido', new.coupon_code;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists orders_coupon_reopen on public.orders;
create trigger orders_coupon_reopen before update of status on public.orders for each row execute function public.orders_coupon_reopen();

-- Saiu de "novo" para a esteira (confirmado, ou arrastado direto para produção ou pronto): aviso com o Pix.
-- Chegou em "pronto": aviso de disponível para entrega. Reabrir e confirmar de novo não repete (unique).
create or replace function public.orders_notice() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'novo' and new.status in ('confirmado', 'producao', 'pronto') then
    insert into order_notices (order_id, kind) values (new.id, 'confirmado') on conflict do nothing;
  end if;
  if new.status = 'pronto' and old.status is distinct from 'pronto' then
    insert into order_notices (order_id, kind) values (new.id, 'pronto') on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists orders_notice on public.orders;
create trigger orders_notice after update of status on public.orders for each row execute function public.orders_notice();

-- Prévia do cupom para o site e o bot: as mesmas regras de place_order, sem gravar nada.
create or replace function public.check_coupon(p_code text, p_phone text default '', p_items jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c coupons;
  v_subtotal numeric := 0;
  v_discount numeric;
  v_out jsonb;
begin
  select * into c from coupons where code = upper(trim(coalesce(p_code, '')));
  if jsonb_typeof(p_items) = 'array' then
    select coalesce(sum(least(greatest((i->>'qty')::int, 1), 500) * p.price), 0) into v_subtotal
    from jsonb_array_elements(p_items) i
    join products p on p.id = (i->>'product_id')::uuid and p.active;
  end if;
  v_out := jsonb_build_object(
    'code', upper(trim(coalesce(p_code, ''))),
    'subtotal', v_subtotal,
    'min_order', coalesce(c.min_order, 0),
    'label', case
      when c.id is null then ''
      when c.kind = 'percent' then replace(rtrim(rtrim(c.value::text, '0'), '.'), '.', ',') || '%'
      else 'R$ ' || replace(to_char(c.value, 'FM999990.00'), '.', ',')
    end);
  begin
    v_discount := coupon_discount(p_code, coalesce(p_phone, ''), v_subtotal);
  exception when raise_exception then
    return v_out || jsonb_build_object('valid', false, 'message', sqlerrm);
  end;
  return v_out || jsonb_build_object('valid', true, 'discount', v_discount, 'total', v_subtotal - v_discount);
end $$;

-- Clientes = quem já comprou (pedido não cancelado), agrupado por phone_key.
-- security_invoker: vale a RLS de orders, então só admin enxerga. Espelho em JS: customersFromOrders (assets/js/campaigns.js).
drop view if exists public.admin_customers;
create view public.admin_customers with (security_invoker = true) as
with valid as (
  select o.*, phone_key(o.phone) as k from orders o where o.status <> 'cancelado'
), base as (
  select k,
    (array_agg(phone order by created_at desc))[1] as phone,
    (array_agg(customer_name order by created_at desc))[1] as name,
    count(*)::int as orders,
    sum(total) as spent,
    min(created_at) as first_order,
    max(created_at) as last_order
  from valid group by k
), lines as (
  select k, i->>'product_id' as product_id, (array_agg(i->>'name' order by created_at desc))[1] as name, sum((i->>'qty')::int) as qty
  from valid, jsonb_array_elements(items) i
  group by k, i->>'product_id'
), prods as (
  select k, array_agg(product_id order by qty desc) as product_ids, (array_agg(name order by qty desc))[1:3] as top_products
  from lines group by k
)
select b.k as phone_key, b.phone, b.name, b.orders, b.spent, b.first_order, b.last_order,
  coalesce(p.product_ids, '{}') as product_ids,
  coalesce(p.top_products, '{}') as top_products,
  exists (select 1 from optouts x where x.phone_key = b.k) as opted_out
from base b left join prods p on p.k = b.k;

grant execute on function public.place_order(text, text, jsonb, text, text, text, text, date) to anon, authenticated;
grant execute on function public.check_coupon(text, text, jsonb) to anon, authenticated;
-- coupon_discount só é chamada por place_order e check_coupon.
revoke execute on function public.coupon_discount(text, text, numeric, boolean) from public, anon, authenticated;
revoke all on public.admin_customers from anon;
grant select on public.admin_customers to authenticated;
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
alter table public.coupons enable row level security;
alter table public.optouts enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_sends enable row level security;
alter table public.order_notices enable row level security;

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

-- Cupons, campanhas e a lista de quem saiu: só admin pelo navegador. O bot usa a chave secreta.
drop policy if exists "coupons admin" on public.coupons;
create policy "coupons admin" on public.coupons for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "optouts admin" on public.optouts;
create policy "optouts admin" on public.optouts for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "campaigns admin" on public.campaigns;
create policy "campaigns admin" on public.campaigns for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "campaign_sends admin" on public.campaign_sends;
create policy "campaign_sends admin" on public.campaign_sends for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "order_notices admin" on public.order_notices;
create policy "order_notices admin" on public.order_notices for all using (public.is_admin()) with check (public.is_admin());

-- ------------------------------------------------------------------
-- Dados iniciais
-- ------------------------------------------------------------------
insert into public.settings (key, value) values
  ('store', '{"accepting": true, "notice": "Encomendas com 1 dia de antecedência", "pix_key": "", "bot_greeting": "Oi! 🎓🍫 Aqui é a Um Doce Até o Diploma."}')
on conflict (key) do nothing;

-- Entrega com dia marcado (segunda, terça, quarta e sexta): só preenche se ainda não existe; depois vale o que estiver em Ajustes.
update public.settings set value = value || '{"delivery_spot": {"label": "Na faculdade, em dia de aula", "days": [1, 2, 3, 5]}}'
where key = 'store' and not (value ? 'delivery_spot');

insert into public.settings (key, value) values
  ('campaigns', '{"daily_limit": 80, "start_hour": 9, "end_hour": 20}')
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
