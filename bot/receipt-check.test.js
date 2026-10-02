// npm test: conferência do texto do comprovante (valor ou código do pedido, e data depois do pedido).
import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, datesIn, checkReceipt } from './receipt-check.js';

const ORDER = { code: 'DD-FHWA', total: 10, created_at: '2026-10-02T22:40:00Z' }; // 19:40 em Brasília
const NOW = Date.parse('2026-10-02T23:30:00Z');
const sp = (s) => Date.parse(`${s}-03:00`);

// textos como os bancos mostram (lidos pelo OCR, com os tropeços de sempre)
const NUBANK = 'Comprovante de transferência\n02 OUT 2026 - 19:47:12\nValor\nR$ 10,00\nTipo de transferência\nPix\ndentificador DDFHWA';
const ITAU = 'Pix efetuado\nR$ 10,00\npara Wesley F Silva\n02/10/2026 às 19:47:12';
const INTER = 'Pix enviado\nValor\n10,00\nData e hora\n02/10/2026 19:47';
const MERCADO_PAGO = 'Comprovante de transferência\nSexta-feira, 2 de outubro de 2026, às 19:47:12\nR$ 10';
const PICPAY = 'Pagamento realizado\n02/10/2026 às 19h47\nR$ 10,00';
const BRADESCO = 'Data: 02/10/2026\nHorário: 19:47:12\nValor: R$ 10,00';

test('valores em centavos', () => {
  assert.deepEqual(amountsIn(NUBANK), [1000]);
  assert.deepEqual(amountsIn(INTER), [1000], '"10,00" logo abaixo de "Valor"');
  assert.deepEqual(amountsIn(MERCADO_PAGO), [1000], '"R$ 10" sem centavos');
  assert.deepEqual(amountsIn('Total R$ 1.234,56 e taxa R$0,00'), [123456, 0]);
});

test('datas e horas de vários bancos, no horário de Brasília', () => {
  const at = sp('2026-10-02T19:47:12');
  assert.deepEqual(datesIn(NUBANK), [{ ms: at, withTime: true }]);
  assert.deepEqual(datesIn(ITAU), [{ ms: at, withTime: true }]);
  assert.deepEqual(datesIn(MERCADO_PAGO), [{ ms: at, withTime: true }]);
  assert.deepEqual(datesIn(BRADESCO), [{ ms: at, withTime: true }], 'data e hora em linhas separadas');
  assert.deepEqual(datesIn(INTER), [{ ms: sp('2026-10-02T19:47:00'), withTime: true }]);
  assert.deepEqual(datesIn(PICPAY), [{ ms: sp('2026-10-02T19:47:00'), withTime: true }], '"19h47"');
  assert.deepEqual(datesIn('Data 02/10/26'), [{ ms: sp('2026-10-02T00:00:00'), withTime: false }], 'ano com 2 dígitos, sem hora');
});

test('comprovantes dos bancos batem com o pedido', () => {
  for (const [bank, text] of Object.entries({ NUBANK, ITAU, INTER, MERCADO_PAGO, PICPAY, BRADESCO })) {
    assert.ok(checkReceipt(text, ORDER, NOW).ok, `${bank}: ${checkReceipt(text, ORDER, NOW).reason}`);
  }
  assert.equal(checkReceipt(NUBANK, ORDER, NOW).reason, 'valor e data conferidos');
});

test('só o código do pedido (valor ilegível) também vale', () => {
  const r = checkReceipt('Pix enviado\n02/10/2026 19:47\nIdentificador: DDFHWA\nR$ ??', ORDER, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'código DD-FHWA e data conferidos');
});

test('não confere: outro valor, data antes do pedido, sem data, ilegível', () => {
  assert.equal(checkReceipt(NUBANK.replace('R$ 10,00', 'R$ 8,00').replace('DDFHWA', 'XYZ'), ORDER, NOW).reason, 'não achei o valor do pedido nem o código DD-FHWA');
  assert.equal(checkReceipt(ITAU.replace('19:47:12', '18:10:00'), ORDER, NOW).reason, 'a data do pagamento é de antes do pedido');
  assert.equal(checkReceipt(ITAU.replace('02/10/2026', '01/10/2026'), ORDER, NOW).reason, 'a data do pagamento é de antes do pedido');
  assert.equal(checkReceipt('Pix\nR$ 10,00', ORDER, NOW).reason, 'não achei a data do pagamento');
  assert.equal(checkReceipt('', ORDER, NOW).reason, 'não consegui ler o comprovante');
  assert.ok(!checkReceipt(ITAU.replace('02/10/2026', '05/10/2026'), ORDER, NOW).ok, 'data no futuro');
});

test('pagamento no mesmo minuto do pedido (o comprovante só mostra hora e minuto)', () => {
  assert.ok(checkReceipt('R$ 10,00\n02/10/2026 19:39', ORDER, NOW).ok, 'até 3 min antes, pelo relógio do celular');
  assert.ok(!checkReceipt('R$ 10,00\n02/10/2026 19:30', ORDER, NOW).ok);
});
