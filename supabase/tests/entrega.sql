-- Testes da forma de entrega no place_order (entrega no ponto com dia marcado ou "combinar") e do "já pago" do balcão.
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
-- Os telefones usam DDD 00, que não existe: não se misturam com pedidos de verdade.
begin;

-- Loja aberta e ponto em segunda, terça, quarta e sexta, só dentro desta transação (o rollback desfaz).
update settings set value = value || '{"accepting": true, "delivery_spot": {"label": "Ponto de teste", "days": [1, 2, 3, 5]}}' where key = 'store';
insert into products (id, name, price, cost, active) values ('00000000-0000-4000-8000-0000000000b1', 'Teste Entrega', 10, 3, true);

create function pg_temp.items() returns jsonb language sql as
  $$ select '[{"product_id": "00000000-0000-4000-8000-0000000000b1", "qty": 1}]'::jsonb $$;
create function pg_temp.today() returns date language sql as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
-- n-ésimo dia a partir de amanhã que cai em um destes dias da semana (0 = domingo)
create function pg_temp.next_day(p_dows int[], p_from int default 1) returns date language sql as $$
  select d::date from generate_series(pg_temp.today() + p_from, pg_temp.today() + 30, interval '1 day') d
  where extract(dow from d)::int = any (p_dows) order by d limit 1
$$;

-- Faz o pedido e exige que seja recusado com exatamente esta mensagem.
create function pg_temp.fails_with(p_delivery text, p_date date, p_msg text) returns void language plpgsql as $$
begin
  perform place_order('Teste', '5500988880000', pg_temp.items(), 'web', '', null, p_delivery, p_date);
  raise exception using errcode = 'P0004', message = format('esperava "%s" para %s em %s, mas o pedido passou', p_msg, p_delivery, p_date);
exception when raise_exception then
  if sqlerrm <> p_msg then
    raise exception using errcode = 'P0004', message = format('esperava "%s", veio "%s"', p_msg, sqlerrm);
  end if;
end $$;

do $$
declare
  r json;
  d date := pg_temp.next_day(array[1, 2, 3, 5]);
begin
  -- no ponto, num dia marcado: grava a forma e a data
  r := place_order('Ana Teste', '5500988881111', pg_temp.items(), 'web', '', null, 'ponto', d);
  assert r->>'delivery' = 'ponto' and (r->>'delivery_date')::date = d, 'ponto: ' || r::text;
  assert (select delivery = 'ponto' and delivery_date = d from orders where code = r->>'code'), 'pedido gravado com a entrega';

  -- combinar: a data é ignorada
  r := place_order('Bia Teste', '5500988882222', pg_temp.items(), 'web', '', null, 'combinar', d);
  assert (select delivery = 'combinar' and delivery_date is null from orders where code = r->>'code'), 'combinar sem data: ' || r::text;

  -- chamada antiga (site e bot antes da atualização): vira "combinar"
  r := place_order('Caio Teste', '5500988883333', pg_temp.items(), 'whatsapp', '');
  assert (select delivery = 'combinar' and delivery_date is null from orders where code = r->>'code'), 'chamada antiga: ' || r::text;

  -- datas recusadas: hoje (precisa de 1 dia), quinta (não marcado), sem data, depois de 14 dias
  perform pg_temp.fails_with('ponto', pg_temp.today(), 'Escolha um dos dias de entrega disponíveis');
  perform pg_temp.fails_with('ponto', pg_temp.next_day(array[4]), 'Escolha um dos dias de entrega disponíveis');
  perform pg_temp.fails_with('ponto', null, 'Escolha um dos dias de entrega disponíveis');
  perform pg_temp.fails_with('ponto', pg_temp.next_day(array[1, 2, 3, 5], 15), 'Escolha um dos dias de entrega disponíveis');
  perform pg_temp.fails_with('casa', null, 'Forma de entrega inválida');

  -- "já pago" só vale para a loja: pelo site (anônimo) é ignorado
  r := place_order('Dani Teste', '5500988884444', pg_temp.items(), 'web', '', null, 'combinar', null, true);
  assert (select not paid from orders where code = r->>'code'), 'cliente não marca o próprio pedido como pago';
  if exists (select 1 from admins) then
    perform set_config('request.jwt.claim.sub', (select user_id::text from admins limit 1), true);
    r := place_order('Edu Teste', '5500988885555', pg_temp.items(), 'balcao', '', null, 'combinar', null, true);
    assert (select paid and channel = 'balcao' from orders where code = r->>'code'), 'pedido do balcão pago na hora';
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- sem ponto em Ajustes, entrega no ponto não vale
  update settings set value = value - 'delivery_spot' where key = 'store';
  perform pg_temp.fails_with('ponto', d, 'Escolha um dos dias de entrega disponíveis');
end $$;

rollback;
