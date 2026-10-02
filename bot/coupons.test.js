// npm test: regras do cupom (as mesmas do banco, em supabase/schema.sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneKey, evaluateCoupon, quoteCoupon, couponState, couponLabel, isCouponError, todaySP } from '../assets/js/coupons.js';

const NOW = Date.parse('2026-10-02T15:00:00Z'); // 12h em Brasília
const base = { code: 'VOLTA10', kind: 'percent', value: 10, min_order: 0, starts_on: null, ends_on: null, max_uses: null, active: true };
const check = (c, opts) => evaluateCoupon({ ...base, ...c }, { subtotal: 40, now: NOW, ...opts });

test('telefone: celular com e sem o 9 é a mesma pessoa; fixo fica como está', () => {
  assert.equal(phoneKey('5511988887777'), '5511988887777');
  assert.equal(phoneKey('551188887777'), '5511988887777');
  assert.equal(phoneKey('(11) 98888-7777'), '5511988887777');
  assert.equal(phoneKey('+55 55 99999-8888'), '5555999998888', 'DDD 55 não se confunde com o código do país');
  assert.equal(phoneKey('551133334444'), '551133334444', 'fixo não ganha 9');
  assert.notEqual(phoneKey('5511988887777'), phoneKey('5521988887777'));
});

test('desconto em porcentagem e em reais', () => {
  assert.deepEqual(check({}), { valid: true, discount: 4 });
  assert.deepEqual(check({ kind: 'fixed', value: 5 }), { valid: true, discount: 5 });
  assert.deepEqual(check({ kind: 'fixed', value: 50 }), { valid: true, discount: 40 }, 'nunca passa do subtotal');
  assert.deepEqual(check({}, { subtotal: 33.35 }), { valid: true, discount: 3.34 }, 'arredonda como o banco');
  assert.deepEqual(check({ value: 12.5 }, { subtotal: 33.35 }), { valid: true, discount: 4.17 });
});

test('pedido mínimo', () => {
  assert.deepEqual(check({ min_order: 50 }), { valid: false, message: 'Vale para pedidos a partir de R$ 50,00' });
  assert.equal(check({ min_order: 40 }).valid, true, 'igual ao mínimo vale');
  assert.equal(check({ min_order: 12.3 }, { subtotal: 3 * 4.1 }).valid, true, '3 x 4,10 chega aos 12,30 (sem erro de ponto flutuante)');
});

test('vigência por dia inteiro, no horário de Brasília', () => {
  assert.equal(todaySP(Date.parse('2026-10-03T02:30:00Z')), '2026-10-02', '23h30 em Brasília ainda é dia 2');
  assert.equal(check({ ends_on: '2026-10-02' }).valid, true);
  assert.equal(check({ ends_on: '2026-10-02' }, { now: Date.parse('2026-10-03T02:59:00Z') }).valid, true, 'vale até 23h59');
  assert.equal(check({ ends_on: '2026-10-02' }, { now: Date.parse('2026-10-03T03:00:00Z') }).message, 'Cupom expirado');
  assert.equal(check({ starts_on: '2026-10-03' }).message, 'Cupom ainda não começou');
  assert.equal(check({ starts_on: '2026-10-02' }).valid, true);
});

test('cota, uma vez por WhatsApp e pausado', () => {
  assert.equal(check({ max_uses: 50 }, { uses: 49 }).valid, true);
  assert.equal(check({ max_uses: 50 }, { uses: 50 }).message, 'Cupom esgotado');
  assert.equal(check({}, { usedByPhone: true }).message, 'Você já usou este cupom');
  assert.equal(check({ active: false }).message, 'Cupom pausado');
  assert.equal(evaluateCoupon(null, { subtotal: 40 }).message, 'Cupom não encontrado');
});

test('resposta no formato do check_coupon do banco', () => {
  assert.deepEqual(quoteCoupon(base, { code: ' volta10 ', subtotal: 40, now: NOW }),
    { code: 'VOLTA10', label: '10%', min_order: 0, subtotal: 40, valid: true, discount: 4, total: 36 });
  assert.deepEqual(quoteCoupon(null, { code: 'nada', subtotal: 40, now: NOW }),
    { code: 'NADA', label: '', min_order: 0, subtotal: 40, valid: false, message: 'Cupom não encontrado' });
});

test('situação e rótulo para o painel', () => {
  assert.equal(couponState(base, 0, NOW), 'ativo');
  assert.equal(couponState({ ...base, starts_on: '2026-10-10' }, 0, NOW), 'agendado');
  assert.equal(couponState({ ...base, ends_on: '2026-10-01' }, 0, NOW), 'expirado');
  assert.equal(couponState({ ...base, max_uses: 2 }, 2, NOW), 'esgotado');
  assert.equal(couponState({ ...base, active: false }, 0, NOW), 'pausado');
  assert.equal(couponLabel({ kind: 'percent', value: 12.5 }), '12,5%');
  assert.equal(couponLabel({ kind: 'fixed', value: 5 }), 'R$ 5,00');
  assert.ok(isCouponError('Cupom esgotado'));
  assert.ok(isCouponError('Vale para pedidos a partir de R$ 30,00'));
  assert.ok(!isCouponError('Produto indisponível'));
});
