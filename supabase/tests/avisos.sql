-- Testes dos avisos automáticos do pedido (gatilho orders_notice: Pix na confirmação, "pronto para entrega", agradecimento).
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
-- Os telefones usam DDD 00, que não existe: o bot nunca chega a enviar nada (e o rollback apaga os avisos).
begin;

create function pg_temp.new_order(p_code text) returns uuid language sql as $$
  insert into orders (code, customer_name, phone, items, total, cost_total)
  values (p_code, 'Teste Aviso', '5500988887777', '[{"name": "Brigadeiro", "qty": 1}]', 5, 2) returning id
$$;
create function pg_temp.kinds(p_id uuid) returns text language sql as $$
  select coalesce(string_agg(kind, ',' order by id), '') from order_notices where order_id = p_id
$$;

do $$
declare
  a uuid := pg_temp.new_order('TA-0001');
  b uuid := pg_temp.new_order('TA-0002');
  c uuid := pg_temp.new_order('TA-0003');
  d uuid;
begin
  -- pedido novo não gera aviso; mudar outro campo também não
  update orders set notes = 'sem açúcar' where id = a;
  assert pg_temp.kinds(a) = '', 'sem mudança de status, sem aviso: ' || pg_temp.kinds(a);

  -- confirmar gera o aviso com o Pix; andar na esteira até pronto só acrescenta o "pronto"
  update orders set status = 'confirmado' where id = a;
  assert pg_temp.kinds(a) = 'confirmado', 'confirmado: ' || pg_temp.kinds(a);
  update orders set status = 'producao' where id = a;
  update orders set status = 'pronto' where id = a;
  assert pg_temp.kinds(a) = 'confirmado,pronto', 'pronto: ' || pg_temp.kinds(a);

  -- voltar e chegar de novo em pronto não repete; entregue manda o agradecimento, uma vez só
  update orders set status = 'producao' where id = a;
  update orders set status = 'pronto' where id = a;
  update orders set status = 'entregue' where id = a;
  assert pg_temp.kinds(a) = 'confirmado,pronto,entregue', 'entregue: ' || pg_temp.kinds(a);
  update orders set status = 'pronto' where id = a;
  update orders set status = 'entregue' where id = a;
  assert pg_temp.kinds(a) = 'confirmado,pronto,entregue', 'sem repetir: ' || pg_temp.kinds(a);

  -- arrastado de novo direto para pronto: Pix e pronto, nessa ordem
  update orders set status = 'pronto' where id = b;
  assert pg_temp.kinds(b) = 'confirmado,pronto', 'direto para pronto: ' || pg_temp.kinds(b);

  -- balcão: de novo direto para entregue, só o agradecimento (sem Pix nem "pronto")
  d := pg_temp.new_order('TA-0004');
  update orders set status = 'entregue' where id = d;
  assert pg_temp.kinds(d) = 'entregue', 'direto para entregue: ' || pg_temp.kinds(d);

  -- cancelado e reaberto, confirmado de novo: o Pix não sai duas vezes
  update orders set status = 'confirmado' where id = c;
  update orders set status = 'cancelado' where id = c;
  update orders set status = 'novo' where id = c;
  update orders set status = 'confirmado' where id = c;
  assert pg_temp.kinds(c) = 'confirmado', 'reaberto: ' || pg_temp.kinds(c);
  assert (select count(*) from order_notices where order_id in (a, b, c, d) and status = 'pendente') = 7, 'tudo pendente para o bot';
end $$;

rollback;
