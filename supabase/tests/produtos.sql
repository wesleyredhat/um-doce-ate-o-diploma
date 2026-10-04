-- Testes de produtos e insumos: o site (anônimo) não vê custo nem receita; insumos são só da loja.
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
begin;

insert into products (id, name, price, cost, active, sold_by, recipe)
values ('00000000-0000-4000-8000-0000000000c1', 'Teste Produto', 15, 5.9, true, 'caixinha', '{"yield": 1, "items": []}');
insert into ingredients (name, pack_qty, unit, pack_price) values ('Teste Insumo', 395, 'g', 7);

set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  ok boolean;
begin
  -- o que o site mostra continua visível
  assert (select price = 15 and sold_by = 'caixinha' from products where id = '00000000-0000-4000-8000-0000000000c1'), 'site lê preço e "vendido por"';
  -- custo e receita não
  begin
    perform cost from products limit 1;
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'o site não pode ler o custo dos produtos';
  begin
    perform recipe from products limit 1;
    ok := false;
  exception when insufficient_privilege then ok := true;
  end;
  assert ok, 'o site não pode ler a receita';
  assert (select count(*) from ingredients) = 0, 'insumos só para a loja';
end $$;
reset role;

-- unidade fora da lista e embalagem vazia são recusadas
do $$
begin
  begin
    insert into ingredients (name, pack_qty, unit, pack_price) values ('Errado', 1, 'xicara', 1);
    raise exception using errcode = 'P0004', message = 'unidade "xicara" devia ser recusada';
  exception when check_violation then null;
  end;
  begin
    insert into ingredients (name, pack_qty, unit, pack_price) values ('Errado', 0, 'g', 1);
    raise exception using errcode = 'P0004', message = 'embalagem com 0 devia ser recusada';
  exception when check_violation then null;
  end;
end $$;

rollback;
