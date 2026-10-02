-- Testes das regras de cupom direto no banco (place_order, check_coupon, admin_customers).
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
-- A loja precisa estar aceitando encomendas (painel → Ajustes → Aceitando encomendas).
begin;

insert into products (id, name, price, cost, active) values ('00000000-0000-4000-8000-0000000000a1', 'Teste Brigadeiro', 10, 3, true);
insert into coupons (code, kind, value, min_order, starts_on, ends_on, max_uses, active) values
  ('TESTE10', 'percent', 10, 0, null, null, 2, true),
  ('TESTEFIX', 'fixed', 50, 0, null, null, null, true),
  ('TESTEMIN', 'fixed', 5, 30, null, null, null, true),
  ('TESTEOLD', 'percent', 10, 0, null, (now() at time zone 'America/Sao_Paulo')::date - 1, null, true),
  ('TESTENEW', 'percent', 10, 0, (now() at time zone 'America/Sao_Paulo')::date + 1, null, null, true),
  ('TESTEOFF', 'percent', 10, 0, null, null, null, false);

create function pg_temp.items(q int) returns jsonb language sql as
  $$ select jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a1', 'qty', q)) $$;

-- Faz o pedido e exige que seja recusado com exatamente esta mensagem.
create function pg_temp.fails_with(p_phone text, p_coupon text, p_qty int, p_msg text) returns void language plpgsql as $$
begin
  perform place_order('Teste', p_phone, pg_temp.items(p_qty), 'web', '', p_coupon);
  raise exception using errcode = 'P0004', message = format('esperava "%s" com o cupom %s, mas o pedido passou', p_msg, p_coupon);
exception when raise_exception then
  if sqlerrm <> p_msg then
    raise exception using errcode = 'P0004', message = format('esperava "%s", veio "%s"', p_msg, sqlerrm);
  end if;
end $$;

do $$
declare
  r json;
  j jsonb;
  n int;
begin
  -- 10% de R$ 30, código com espaço e minúsculas
  r := place_order('Ana Teste', '5511988887777', pg_temp.items(3), 'web', '', ' teste10 ');
  assert (r->>'subtotal')::numeric = 30 and (r->>'discount')::numeric = 3 and (r->>'total')::numeric = 27 and r->>'coupon' = 'TESTE10', 'percentual: ' || r::text;
  assert (select discount = 3 and total = 27 and coupon_code = 'TESTE10' from orders where code = r->>'code'), 'pedido gravado com o desconto';

  -- o mesmo WhatsApp sem o 9 já usou
  perform pg_temp.fails_with('551188887777', 'TESTE10', 3, 'Você já usou este cupom');

  -- cota de 2: o segundo cliente usa, o terceiro não
  perform place_order('Bia Teste', '5521977776666', pg_temp.items(3), 'web', '', 'TESTE10');
  perform pg_temp.fails_with('5531966665555', 'TESTE10', 3, 'Cupom esgotado');

  -- pedido cancelado devolve a cota
  update orders set status = 'cancelado' where code = r->>'code';
  perform place_order('Caio Teste', '5531966665555', pg_temp.items(3), 'web', '', 'TESTE10');

  -- valor fixo nunca passa do subtotal
  r := place_order('Ana Teste', '5511988887777', pg_temp.items(3), 'web', '', 'TESTEFIX');
  assert (r->>'discount')::numeric = 30 and (r->>'total')::numeric = 0, 'teto no subtotal: ' || r::text;

  -- pedido mínimo de R$ 30
  perform pg_temp.fails_with('5541955554444', 'TESTEMIN', 2, 'Vale para pedidos a partir de R$ 30,00');
  perform place_order('Davi Teste', '5541955554444', pg_temp.items(3), 'web', '', 'TESTEMIN');

  -- vigência, pausado e inexistente
  perform pg_temp.fails_with('5551944443333', 'TESTEOLD', 3, 'Cupom expirado');
  perform pg_temp.fails_with('5551944443333', 'TESTENEW', 3, 'Cupom ainda não começou');
  perform pg_temp.fails_with('5551944443333', 'TESTEOFF', 3, 'Cupom pausado');
  perform pg_temp.fails_with('5551944443333', 'NAOEXISTE', 3, 'Cupom não encontrado');

  -- sem cupom: desconto zero
  r := place_order('Eva Teste', '5561933332222', pg_temp.items(1), 'web', '', null);
  assert (r->>'discount')::numeric = 0 and (r->>'total')::numeric = 10, 'sem cupom: ' || r::text;

  -- check_coupon só confere, não grava nada
  select count(*) into n from orders;
  j := check_coupon('teste10', '5571922221111', pg_temp.items(5));
  assert j->>'valid' = 'false' and j->>'message' = 'Cupom esgotado', 'check esgotado: ' || j::text;
  j := check_coupon('TESTEMIN', '5571922221111', pg_temp.items(5));
  assert (j->>'valid')::boolean and (j->>'discount')::numeric = 5 and (j->>'total')::numeric = 45 and j->>'label' = 'R$ 5,00', 'check válido: ' || j::text;
  j := check_coupon('TESTEMIN', '', pg_temp.items(1));
  assert j->>'message' = 'Vale para pedidos a partir de R$ 30,00' and (j->>'min_order')::numeric = 30, 'check mínimo: ' || j::text;
  j := check_coupon('TESTE10', '', '[]');
  assert j->>'label' = '10%', 'rótulo em porcentagem: ' || j::text;
  assert (select count(*) from orders) = n, 'check_coupon não grava pedidos';

  -- telefone com e sem o 9 é a mesma pessoa
  assert phone_key('5511988887777') = '5511988887777' and phone_key('551188887777') = '5511988887777' and phone_key('551133334444') = '551133334444', 'phone_key';

  -- clientes: Ana aparece uma vez e o pedido cancelado não conta
  select count(*) into n from admin_customers where phone_key = '5511988887777';
  assert n = 1, 'Ana aparece uma vez só';
  assert (select orders = 1 and spent = 0 and 'Teste Brigadeiro' = any (top_products) from admin_customers where phone_key = '5511988887777'), 'resumo da Ana';
end $$;

rollback;
