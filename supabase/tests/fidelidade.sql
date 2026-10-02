-- Testes da Carteirinha do Formando (capelos = pedidos entregues; brindes entregues em loyalty_rewards).
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
-- Os telefones usam DDD 00, que não existe: não se misturam com clientes de verdade.
begin;

-- p_phone: pedidos com e sem o 9 são a mesma pessoa
create function pg_temp.order(p_phone text, p_status text) returns void language sql as $$
  insert into orders (code, customer_name, phone, items, total, cost_total, status)
  values ('TF-' || substr(md5(random()::text), 1, 6), 'Fernanda Teste', p_phone, '[]', 10, 3, p_status)
$$;

do $$
declare
  c record;
begin
  -- 6 entregues com o 9, 4 entregues sem o 9, 1 cancelado e 1 em produção: 10 capelos
  for i in 1..6 loop perform pg_temp.order('5500988776655', 'entregue'); end loop;
  for i in 1..4 loop perform pg_temp.order('550088776655', 'entregue'); end loop;
  perform pg_temp.order('5500988776655', 'cancelado');
  perform pg_temp.order('550088776655', 'producao');

  assert loyalty_stamps('5500988776655') = 10 and loyalty_stamps('(00) 8877-6655') = 10, 'capelos somam com e sem o 9: ' || loyalty_stamps('5500988776655');

  select * into c from admin_customers where phone_key = phone_key('5500988776655');
  assert c.delivered = 10 and c.orders = 11 and c.rewards_given = 0, format('cliente: %s entregues, %s pedidos, %s brindes', c.delivered, c.orders, c.rewards_given);

  -- brinde entregue
  insert into loyalty_rewards (phone_key) values (phone_key('550088776655'));
  select * into c from admin_customers where phone_key = phone_key('5500988776655');
  assert c.rewards_given = 1, 'brinde registrado pela mesma pessoa: ' || c.rewards_given;
end $$;

rollback;
