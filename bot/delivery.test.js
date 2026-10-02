// npm test: forma de entrega (datas com entrega no ponto, textos).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryDates, dayLabel, deliveryText, spotOf, COMBINE_LABEL } from '../supabase/functions/_shared/delivery.js';

const SPOT = { delivery_spot: { label: 'Na faculdade, em dia de aula', days: [1, 2, 3, 5] } };
const FRI_NOON = Date.parse('2026-10-02T12:00:00-03:00'); // sexta-feira

test('próximas datas: a partir de amanhã, só nos dias marcados', () => {
  assert.deepEqual(deliveryDates(SPOT, FRI_NOON), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09']);
  assert.deepEqual(deliveryDates(SPOT, FRI_NOON, 2), ['2026-10-05', '2026-10-06']);
});

test('o dia vira à meia-noite de Brasília, não de Londres', () => {
  // sexta 23h em Brasília = sábado 02h em UTC: amanhã ainda é sábado, então a primeira data é segunda
  assert.equal(deliveryDates(SPOT, Date.parse('2026-10-02T23:00:00-03:00'))[0], '2026-10-05');
  // domingo 23h: amanhã é segunda, que já vale
  assert.equal(deliveryDates(SPOT, Date.parse('2026-10-04T23:00:00-03:00'))[0], '2026-10-05');
  // segunda 00h30: a própria segunda não vale (precisa de 1 dia), a primeira é terça
  assert.equal(deliveryDates(SPOT, Date.parse('2026-10-05T00:30:00-03:00'))[0], '2026-10-06');
});

test('sem ponto configurado (ou sem dias), não pergunta', () => {
  assert.equal(spotOf({}), null);
  assert.equal(spotOf({ delivery_spot: { label: 'Faculdade', days: [] } }), null);
  assert.equal(spotOf({ delivery_spot: { label: ' ', days: [1] } }), null);
  assert.deepEqual(deliveryDates({}, FRI_NOON), []);
});

test('textos', () => {
  assert.equal(dayLabel('2026-10-05'), 'segunda, 05/10');
  assert.equal(dayLabel('2026-10-09'), 'sexta, 09/10');
  assert.equal(deliveryText({ delivery: 'ponto', delivery_date: '2026-10-09' }, SPOT), 'Na faculdade, em dia de aula · sexta, 09/10');
  assert.equal(deliveryText({ delivery: 'combinar' }, SPOT), COMBINE_LABEL);
  assert.equal(deliveryText({}, SPOT), COMBINE_LABEL);
});
