// Custo dos produtos pela receita (ficha técnica). Insumo = o que se compra, com o tamanho da embalagem e o
// preço pago; receita = quanto de cada insumo vai numa fornada e quantas unidades ela rende.
//   insumo  { id, name, pack_qty: 395, unit: 'g' | 'kg' | 'ml' | 'l' | 'un', pack_price: 7 }
//   receita { yield: 25, items: [{ ingredient_id, qty }] }  (qty na unidade base do insumo: g, ml ou un)
// O custo de 1 unidade vai para products.cost (é ele que entra no pedido e no Financeiro).
export const UNITS = { g: ['g', 1], kg: ['g', 1000], ml: ['ml', 1], l: ['ml', 1000], un: ['un', 1] };
// Como o produto é vendido: aparece no site depois do preço ("R$ 15,00 /caixinha").
export const SOLD_BY = ['un', 'caixinha', 'cento', 'pote', 'fatia', 'kit', 'pacote'];

const unitOf = (ing) => UNITS[ing?.unit] || UNITS.un;
export const baseUnit = (ing) => unitOf(ing)[0];
export const packBase = (ing) => (Number(ing?.pack_qty) || 0) * unitOf(ing)[1];
export const pricePerBase = (ing) => (packBase(ing) > 0 ? (Number(ing.pack_price) || 0) / packBase(ing) : 0);
export const hasRecipe = (p) => Array.isArray(p?.recipe?.items) && p.recipe.items.length > 0;
const num = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');
export const packText = (ing) => `${num(Number(ing.pack_qty) || 0)} ${ing.unit}`;

// "R$ 1,77 por 100 g" (g e ml: por 100, que é a medida das receitas) ou "R$ 0,08 por un".
export function unitPriceText(ing) {
  const each = pricePerBase(ing);
  const brl = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;
  return baseUnit(ing) === 'un' ? `${brl(each)} por un` : `${brl(each * 100)} por 100 ${baseUnit(ing)}`;
}

// { batch, unit, lines: [{ ingredient, qty, cost }], missing: [ids de insumo que não existem mais] }
export function recipeCost(recipe, ingredients) {
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const lines = [];
  const missing = [];
  for (const it of recipe?.items || []) {
    const ing = byId.get(it.ingredient_id);
    if (!ing) { missing.push(it.ingredient_id); continue; }
    const qty = Number(it.qty) || 0;
    lines.push({ ingredient: ing, qty, cost: qty * pricePerBase(ing) });
  }
  const batch = lines.reduce((s, l) => s + l.cost, 0);
  const portions = Math.max(1, Number(recipe?.yield) || 1);
  return { batch, unit: Math.round((batch / portions) * 100) / 100, lines, missing };
}

// Produtos com receita que usam o insumo e cujo custo muda com o preço novo: [{ id, name, cost }].
export function costsToUpdate(products, ingredients, ingredientId) {
  return products
    .filter((p) => hasRecipe(p) && p.recipe.items.some((it) => it.ingredient_id === ingredientId))
    .map((p) => ({ id: p.id, name: p.name, cost: recipeCost(p.recipe, ingredients).unit, old: Number(p.cost) }))
    .filter((p) => p.cost !== p.old);
}

export const usedIn = (products, ingredientId) => products.filter((p) => hasRecipe(p) && p.recipe.items.some((it) => it.ingredient_id === ingredientId));
