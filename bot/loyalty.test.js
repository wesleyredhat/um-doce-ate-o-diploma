// npm test: Carteirinha do Formando no painel (capelos, brinde a entregar, mensagens).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyOf, capelosText, loyaltyMessage } from '../assets/js/loyalty.js';
import { customersFromOrders } from '../assets/js/campaigns.js';

test('capelos e brinde a entregar', () => {
  assert.deepEqual(loyaltyOf({ delivered: 7, rewards_given: 0 }), { goal: 10, delivered: 7, stamps: 7, left: 3, earned: 0, pending: 0 });
  assert.deepEqual(loyaltyOf({ delivered: 10, rewards_given: 0 }), { goal: 10, delivered: 10, stamps: 0, left: 10, earned: 1, pending: 1 });
  assert.equal(loyaltyOf({ delivered: 10, rewards_given: 1 }).pending, 0, 'brinde já entregue');
  assert.equal(loyaltyOf({ delivered: 23, rewards_given: 1 }).pending, 1, 'segunda carteirinha completa');
  assert.equal(loyaltyOf({}).delivered, 0, 'banco sem a coluna nova: zero, sem erro');
});

test('texto dos capelos', () => {
  assert.equal(capelosText(loyaltyOf({ delivered: 7 })), '7/10');
  assert.equal(capelosText(loyaltyOf({ delivered: 10 })), '10/10 🎁');
  assert.equal(capelosText(loyaltyOf({ delivered: 12 })), '2/10 🎁', 'já começou outra, brinde ainda pendente');
  assert.equal(capelosText(loyaltyOf({ delivered: 10, rewards_given: 1 })), '0/10');
});

test('mensagens prontas', () => {
  assert.match(loyaltyMessage({ name: 'Ana Clara' }, loyaltyOf({ delivered: 8 })), /^Oi, Ana! 🎓 Você já tem 8 de 10 capelos.*Faltam só 2 pedidos para ganhar 1 brigadeiro de presente/);
  assert.match(loyaltyMessage({ name: 'Ana' }, loyaltyOf({ delivered: 9 })), /Falta só 1 pedido/);
  assert.match(loyaltyMessage({ name: 'Ana' }, loyaltyOf({ delivered: 10 })), /completou a Carteirinha do Formando! Seu próximo pedido vem com 1 brigadeiro de presente/);
});

test('modo demonstração: entregues e brindes por pessoa (com e sem o 9)', () => {
  const o = (phone, status) => ({ phone, customer_name: 'Ana', total: 10, status, created_at: '2026-09-01T12:00:00Z', items: [] });
  const [c] = customersFromOrders([o('5511988887777', 'entregue'), o('551188887777', 'entregue'), o('5511988887777', 'pronto')], new Set(), [{ phone_key: '5511988887777' }]);
  assert.equal(c.delivered, 2);
  assert.equal(c.orders, 3);
  assert.equal(c.rewards_given, 1);
});
