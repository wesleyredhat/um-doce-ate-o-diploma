// npm test: público, texto e estimativa das campanhas (assets/js/campaigns.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneKey } from '../assets/js/coupons.js';
import { customersFromOrders, pickAudience, personalize, campaignText, finishText, spClock } from '../assets/js/campaigns.js';

const NOW = Date.parse('2026-10-02T15:00:00Z'); // 12h em Brasília
const SITE = 'https://umdoceateodiploma.com.br/';
const cust = (phone, name, orders, spent, last_order, product_ids, opted_out = false) =>
  ({ phone_key: phoneKey(phone), phone, name, orders, spent, last_order, product_ids, top_products: [], opted_out });
const ANA = cust('5511988880001', 'Ana Clara', 5, 300, '2026-09-30T12:00:00Z', ['p1']);
const BIA = cust('5511988880002', 'Bia', 1, 20, '2026-06-01T12:00:00Z', ['p2']);
const CAIO = cust('5511988880003', 'Caio', 3, 90, '2026-07-15T12:00:00Z', ['p1', 'p2'], true);
const CUSTOMERS = [ANA, BIA, CAIO];
const names = (list) => list.map((r) => r.name);

test('clientes a partir dos pedidos (igual à view admin_customers)', () => {
  const o = (phone, customer_name, total, status, created_at, items) => ({ phone, customer_name, total, status, created_at, items });
  const list = customersFromOrders([
    o('5511988887777', 'Ana', 40, 'entregue', '2026-09-01T12:00:00Z', [{ product_id: 'p1', name: 'Brigadeiro', qty: 10 }]),
    o('551188887777', 'Ana Souza', 24, 'entregue', '2026-09-20T12:00:00Z', [{ product_id: 'p2', name: 'Casadinho', qty: 6 }, { product_id: 'p1', name: 'Brigadeiro', qty: 1 }]),
    o('5511988887777', 'Ana', 99, 'cancelado', '2026-09-25T12:00:00Z', [{ product_id: 'p4', name: 'Morango', qty: 9 }]),
    o('5521977776666', 'Bia', 12, 'cancelado', '2026-09-10T12:00:00Z', [{ product_id: 'p4', name: 'Morango', qty: 1 }]),
  ], new Set(['5511988887777']));
  assert.equal(list.length, 1, 'Bia só tem pedido cancelado: não é cliente');
  assert.deepEqual(list[0], {
    phone_key: '5511988887777', phone: '551188887777', name: 'Ana Souza', orders: 2, delivered: 2, spent: 64,
    first_order: '2026-09-01T12:00:00Z', last_order: '2026-09-20T12:00:00Z',
    product_ids: ['p1', 'p2'], top_products: ['Brigadeiro', 'Casadinho'], opted_out: true, rewards_given: 0,
  });
});

test('filtros de público (quem saiu nunca entra)', () => {
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'todos' }, NOW)), ['Ana Clara', 'Bia']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'sumidos', days: 90 }, NOW)), ['Bia']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'produto', product_id: 'p1' }, NOW)), ['Ana Clara']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'fieis' }, NOW)), ['Ana Clara']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'top' }, NOW)), ['Ana Clara', 'Bia']);
  assert.deepEqual(pickAudience(CUSTOMERS, [], { type: 'todos' }, NOW)[0], { phone: ANA.phone, name: 'Ana Clara', phone_key: ANA.phone_key });
});

test('limites dos filtros: 3 pedidos entra em "3 pedidos ou mais"; os que mais gastaram param em 20', () => {
  const tres = cust('5511988880009', 'Duda', 3, 50, '2026-09-01T12:00:00Z', []);
  assert.deepEqual(names(pickAudience([...CUSTOMERS, tres], [], { type: 'fieis' }, NOW)), ['Ana Clara', 'Duda']);
  const many = Array.from({ length: 25 }, (_, i) => cust(`55119888810${String(i).padStart(2, '0')}`, `C${i}`, 1, i * 10, '2026-09-01T12:00:00Z', []));
  const top = pickAudience(many, [], { type: 'top' }, NOW);
  assert.equal(top.length, 20);
  assert.deepEqual(top.slice(0, 2).map((r) => r.name), ['C24', 'C23']);
});

test('inscritos: inclui quem nunca comprou e não repete a mesma pessoa', () => {
  const subs = [
    { phone: '551188880001', name: 'Aninha' }, // Ana sem o 9
    { phone: '5511988880001', name: 'Ana' },
    { phone: '5521977770000', name: 'Duda' },
    { phone: CAIO.phone, name: 'Caio' },
  ];
  assert.deepEqual(names(pickAudience(CUSTOMERS, subs, { type: 'inscritos' }, NOW)), ['Ana Clara', 'Duda']);
});

test('{nome} vira o primeiro nome', () => {
  assert.equal(personalize('Oi, {nome}! Tem novidade.', 'Ana Clara'), 'Oi, Ana! Tem novidade.');
  assert.equal(personalize('Oi, {nome}! Tem novidade.', ''), 'Oi! Tem novidade.');
  assert.equal(personalize('{nome}, chegou o kit', '  '), 'chegou o kit');
});

test('texto da mensagem: cupom com link, ou link do site, e sempre como sair', () => {
  const t = campaignText({ body: 'Oi, {nome}!', coupon_code: 'VOLTA10' }, 'Ana', SITE);
  assert.match(t, /^Oi, Ana!\n\n🎟️ Cupom \*VOLTA10\*/);
  assert.match(t, /https:\/\/umdoceateodiploma\.com\.br\/\?cupom=VOLTA10/);
  assert.match(t, /responda \*cupom VOLTA10\*/);
  assert.match(t, /_Para não receber mais promoções, responda \*parar promoções\*\._$/);
  assert.match(campaignText({ body: 'Oi!' }, 'Ana', SITE), /Peça pelo site: https:\/\/umdoceateodiploma\.com\.br\/\nOu responda \*menu\*/);
});

test('estimativa de término no ritmo médio', () => {
  assert.deepEqual(spClock(NOW), { day: '2026-10-02', hour: 12, minute: 0 });
  assert.equal(finishText(47, {}, { now: NOW }), 'termina hoje por volta das 12h');
  assert.equal(finishText(200, {}, { now: NOW }), 'leva 3 dias, termina dia 04/10 por volta das 9h');
  assert.equal(finishText(10, {}, { now: Date.parse('2026-10-03T00:00:00Z') }), 'termina amanhã por volta das 9h', 'às 21h já passou do horário');
  assert.equal(finishText(10, { daily_limit: 80 }, { now: NOW, sentToday: 80 }), 'termina amanhã por volta das 9h', 'limite do dia já usado');
});
