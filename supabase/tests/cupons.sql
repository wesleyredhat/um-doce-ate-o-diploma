-- Testes das regras de cupom direto no banco (place_order, check_coupon, admin_customers).
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
-- Os telefones usam DDD 00, que não existe: não se misturam com pedidos de verdade.
begin;

-- O teste faz pedidos como cliente anônimo: abre a loja só dentro desta transação (o rollback desfaz).
update settings set value = value || '{"accepting": true}' where key = 'store';

insert into products (id, name, price, cost, active) values ('00000000-0000-4000-8000-0000000000a1', 'Teste Brigadeiro', 10, 3, true);
insert into coupons (code, kind, value, min_order, starts_on, ends_on, max_uses, active) values
  ('TESTE10', 'percent', 10, 0, null, null, 2, true),
  ('TESTEFIX', 'fixed', 50, 0, null, null, null, true),
  ('TESTEMIN', 'fixed', 5, 30, null, null, null, true),
  ('TESTEOLD', 'percent', 10, 0, null, (now() at time zone 'America/Sao_Paulo')::date - 1, null, true),
  ('TESTENEW', 'percent', 10, 0, (now() at time zone 'America/Sao_Paulo')::date + 1, null, null, true),
  ('TESTEOFF', 'percent', 10, 0, null, null, null, false),
  ('TESTEHOJE', 'percent', 10, 0, (now() at time zone 'America/Sao_Paulo')::date, (now() at time zone 'America/Sao_Paulo')::date, null, true),
  ('TESTERED', 'percent', 10, 0, null, null, null, true),
  ('TESTEVENC', 'percent', 10, 100, null, (now() at time zone 'America/Sao_Paulo')::date - 1, null, true),
  ('TESTEUM', 'fixed', 1, 0, null, null, 1, true),
  ('TESTEVOLTA', 'percent', 10, 0, null, null, null, true);
insert into products (id, name, price, cost, active) values ('00000000-0000-4000-8000-0000000000a2', 'Teste Quebrado', 6.67, 2, true);

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
  r := place_order('Ana Teste', '5500988887777', pg_temp.items(3), 'web', '', ' teste10 ');
  assert (r->>'subtotal')::numeric = 30 and (r->>'discount')::numeric = 3 and (r->>'total')::numeric = 27 and r->>'coupon' = 'TESTE10', 'percentual: ' || r::text;
  assert (select discount = 3 and total = 27 and coupon_code = 'TESTE10' from orders where code = r->>'code'), 'pedido gravado com o desconto';

  -- o mesmo WhatsApp sem o 9 já usou
  perform pg_temp.fails_with('550088887777', 'TESTE10', 3, 'Você já usou este cupom');

  -- cota de 2: o segundo cliente usa, o terceiro não
  perform place_order('Bia Teste', '5500977776666', pg_temp.items(3), 'web', '', 'TESTE10');
  perform pg_temp.fails_with('5500966665555', 'TESTE10', 3, 'Cupom esgotado');

  -- pedido cancelado devolve a cota
  update orders set status = 'cancelado' where code = r->>'code';
  perform place_order('Caio Teste', '5500966665555', pg_temp.items(3), 'web', '', 'TESTE10');

  -- valor fixo nunca passa do subtotal
  r := place_order('Ana Teste', '5500988887777', pg_temp.items(3), 'web', '', 'TESTEFIX');
  assert (r->>'discount')::numeric = 30 and (r->>'total')::numeric = 0, 'teto no subtotal: ' || r::text;

  -- pedido mínimo de R$ 30
  perform pg_temp.fails_with('5500955554444', 'TESTEMIN', 2, 'Vale para pedidos a partir de R$ 30,00');
  perform place_order('Davi Teste', '5500955554444', pg_temp.items(3), 'web', '', 'TESTEMIN');

  -- vigência, pausado e inexistente
  perform pg_temp.fails_with('5500944443333', 'TESTEOLD', 3, 'Cupom expirado');
  perform pg_temp.fails_with('5500944443333', 'TESTENEW', 3, 'Cupom ainda não começou');
  perform pg_temp.fails_with('5500944443333', 'TESTEOFF', 3, 'Cupom pausado');
  perform pg_temp.fails_with('5500944443333', 'NAOEXISTE', 3, 'Cupom não encontrado');

  -- sem cupom: desconto zero
  r := place_order('Eva Teste', '5500933332222', pg_temp.items(1), 'web', '', null);
  assert (r->>'discount')::numeric = 0 and (r->>'total')::numeric = 10, 'sem cupom: ' || r::text;

  -- check_coupon só confere, não grava nada
  select count(*) into n from orders;
  j := check_coupon('teste10', '5500922221111', pg_temp.items(5));
  assert j->>'valid' = 'false' and j->>'message' = 'Cupom esgotado', 'check esgotado: ' || j::text;
  j := check_coupon('TESTEMIN', '5500922221111', pg_temp.items(5));
  assert (j->>'valid')::boolean and (j->>'discount')::numeric = 5 and (j->>'total')::numeric = 45 and j->>'label' = 'R$ 5,00', 'check válido: ' || j::text;
  j := check_coupon('TESTEMIN', '', pg_temp.items(1));
  assert j->>'message' = 'Vale para pedidos a partir de R$ 30,00' and (j->>'min_order')::numeric = 30, 'check mínimo: ' || j::text;
  j := check_coupon('TESTE10', '', '[]');
  assert j->>'label' = '10%', 'rótulo em porcentagem: ' || j::text;
  assert (select count(*) from orders) = n, 'check_coupon não grava pedidos';

  -- vigência: vale no primeiro e no último dia (cupom de um dia só: hoje, em Brasília)
  r := place_order('Fábio Teste', '5500911110000', pg_temp.items(1), 'web', '', 'TESTEHOJE');
  assert (r->>'discount')::numeric = 1, 'cupom de hoje vale: ' || r::text;

  -- centavos: 5 x R$ 6,67 = R$ 33,35; 10% = 3,335, que vira 3,34
  r := place_order('Gil Teste', '5500911110001', jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a2', 'qty', 5)), 'web', '', 'TESTERED');
  assert (r->>'discount')::numeric = 3.34 and (r->>'total')::numeric = 30.01, 'arredondamento: ' || r::text;

  -- ordem das recusas: vencido com pedido mínimo alto diz "expirado"; cota cheia diz "esgotado" até para quem já usou
  perform pg_temp.fails_with('5500911110002', 'TESTEVENC', 1, 'Cupom expirado');
  perform place_order('Hugo Teste', '5500911110003', pg_temp.items(1), 'web', '', 'TESTEUM');
  perform pg_temp.fails_with('5500911110003', 'TESTEUM', 1, 'Cupom esgotado');

  -- pedido cancelado libera a mesma pessoa (até pelo número sem o 9)
  r := place_order('Íris Teste', '5500988881111', pg_temp.items(1), 'web', '', 'TESTEVOLTA');
  update orders set status = 'cancelado' where code = r->>'code';
  perform place_order('Íris Teste', '550088881111', pg_temp.items(1), 'whatsapp', '', 'TESTEVOLTA');

  -- reabrir o pedido cancelado não fura o "uma vez por WhatsApp" (ela já usou de novo) nem a cota
  begin
    update orders set status = 'novo' where code = r->>'code';
    raise exception using errcode = 'P0004', message = 'reabrir devia ser recusado (WhatsApp já usou)';
  exception when raise_exception then
    assert sqlerrm like 'Não dá para reabrir: este WhatsApp já usou o cupom TESTEVOLTA%', sqlerrm;
  end;
  update orders set status = 'cancelado' where customer_name = 'Hugo Teste';
  perform place_order('Juca Teste', '5500911110004', pg_temp.items(1), 'web', '', 'TESTEUM');
  begin
    update orders set status = 'novo' where customer_name = 'Hugo Teste';
    raise exception using errcode = 'P0004', message = 'reabrir devia ser recusado (cota cheia)';
  exception when raise_exception then
    assert sqlerrm like 'Não dá para reabrir: o cupom TESTEUM esgotou%', sqlerrm;
  end;

  -- telefone com e sem o 9 é a mesma pessoa
  assert phone_key('5500988887777') = '5500988887777' and phone_key('550088887777') = '5500988887777' and phone_key('551133334444') = '551133334444', 'phone_key';

  -- clientes: Ana com e sem o 9 aparece uma vez só, e o pedido cancelado não conta
  perform place_order('Ana pelo Zap', '550088887777', pg_temp.items(1), 'whatsapp', '', null);
  -- dentro da transação todos os pedidos têm a mesma hora: este passa a ser o mais recente
  update orders set created_at = created_at + interval '1 minute' where customer_name = 'Ana pelo Zap';
  select count(*) into n from admin_customers where phone_key in ('5500988887777', '550088887777');
  assert n = 1, 'Ana aparece uma vez só';
  assert (select orders = 2 and spent = 10 and name = 'Ana pelo Zap' and 'Teste Brigadeiro' = any (top_products)
          from admin_customers where phone_key = '5500988887777'), 'resumo da Ana';
end $$;

rollback;
