// npm test: custo dos produtos pela receita (insumos e ficha técnica, assets/js/recipes.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeCost, costsToUpdate, pricePerBase, unitPriceText, packText, usedIn, hasRecipe } from '../assets/js/recipes.js';

const LC = { id: 'lc', name: 'Leite condensado', pack_qty: 395, unit: 'g', pack_price: 7 };
const CHOC = { id: 'choc', name: 'Chocolate 50%', pack_qty: 1, unit: 'kg', pack_price: 39.99 };
const GRAN = { id: 'gran', name: 'Granulado', pack_qty: 1, unit: 'kg', pack_price: 29.99 };
const FORMA = { id: 'forma', name: 'Forminha', pack_qty: 100, unit: 'un', pack_price: 8 };
const CREME = { id: 'creme', name: 'Creme de leite', pack_qty: 0.2, unit: 'l', pack_price: 3 };
const INGS = [LC, CHOC, GRAN, FORMA, CREME];
const BRIGADEIRO = { id: 'b', name: 'Brigadeiro', cost: 1.35, recipe: { yield: 25, items: [
  { ingredient_id: 'lc', qty: 395 }, { ingredient_id: 'choc', qty: 40 }, { ingredient_id: 'gran', qty: 60 }, { ingredient_id: 'forma', qty: 25 },
] } };

test('preço por grama, mililitro ou unidade, convertendo kg e litro', () => {
  assert.equal(pricePerBase(LC), 7 / 395);
  assert.equal(pricePerBase(CHOC), 39.99 / 1000);
  assert.equal(pricePerBase(CREME), 3 / 200);
  assert.equal(pricePerBase(FORMA), 0.08);
  assert.equal(pricePerBase({ pack_qty: 0, unit: 'g', pack_price: 5 }), 0, 'embalagem sem tamanho não divide por zero');
  assert.equal(unitPriceText(LC), 'R$ 1,77 por 100 g');
  assert.equal(unitPriceText(FORMA), 'R$ 0,08 por un');
  assert.equal(packText({ pack_qty: 1.1, unit: 'kg' }), '1,1 kg');
});

test('custo da fornada e de 1 unidade', () => {
  const r = recipeCost(BRIGADEIRO.recipe, INGS);
  // 7,00 + 1,60 (40 g de chocolate) + 1,80 (60 g de granulado) + 2,00 (25 forminhas) = 12,40 ÷ 25
  assert.equal(Math.round(r.batch * 100) / 100, 12.40);
  assert.equal(r.unit, 0.50);
  assert.equal(r.lines.length, 4);
  assert.deepEqual(r.missing, []);
});

test('insumo apagado aparece como faltando; rendimento vazio conta como 1', () => {
  const r = recipeCost({ yield: 0, items: [{ ingredient_id: 'lc', qty: 395 }, { ingredient_id: 'sumiu', qty: 10 }] }, INGS);
  assert.equal(r.unit, 7);
  assert.deepEqual(r.missing, ['sumiu']);
  assert.equal(recipeCost(null, INGS).unit, 0);
});

test('preço de insumo mudou: atualiza só os produtos com receita que usam ele', () => {
  const products = [BRIGADEIRO, { id: 'e', name: 'Empadinha', cost: 2.3, recipe: null }, { id: 'c', name: 'Casadinho', cost: 0.5, recipe: { yield: 25, items: [{ ingredient_id: 'creme', qty: 200 }] } }];
  const novo = INGS.map((i) => (i.id === 'lc' ? { ...i, pack_price: 9.5 } : i));
  assert.deepEqual(costsToUpdate(products, novo, 'lc'), [{ id: 'b', name: 'Brigadeiro', cost: 0.6, old: 1.35 }]);
  assert.deepEqual(usedIn(products, 'creme').map((p) => p.name), ['Casadinho']);
  assert.equal(hasRecipe(products[1]), false, 'sem receita: custo digitado à mão continua');
});
