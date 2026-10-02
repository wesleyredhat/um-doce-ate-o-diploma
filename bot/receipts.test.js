// npm test: comprovante do Pix pelo WhatsApp (foto ou PDF conferidos leva o pedido para a produção).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceipts, looksLikeReceipt, RECEIPT_WINDOW_MS } from './receipts.js';

const NOW = Date.parse('2026-10-02T20:30:00-03:00');
const ANA = '5511988887777';
const GOOD = 'Pix enviado\nR$ 10,00\n02/10/2026 às 19:47:12'; // pedido feito às 19:40, de R$ 10,00
const order = (o) => ({ id: 'o1', code: 'DD-K7P2', customer_name: 'Ana Clara', phone: ANA, status: 'confirmado', paid: false, total: 10, created_at: '2026-10-02T22:40:00Z', receipt_at: null, ...o });

function setup(confirmations = [{ sent_at: new Date(NOW - 3600e3).toISOString(), order: order() }]) {
  const moved = [];
  const flagged = [];
  const db = {
    recentConfirmations: async (since) => confirmations.filter((c) => c.sent_at >= since),
    advance: async (id, at, note) => {
      const c = confirmations.find((x) => x.order.id === id && x.order.status === 'confirmado');
      if (!c) return false;
      Object.assign(c.order, { status: 'producao', receipt_at: at, receipt_ok: true, receipt_note: note });
      moved.push(id);
      return true;
    },
    flag: async (id, at, note) => {
      Object.assign(confirmations.find((x) => x.order.id === id).order, { receipt_at: at, receipt_ok: false, receipt_note: note });
      flagged.push(note);
    },
  };
  return { moved, flagged, confirmations, r: createReceipts({ db, now: () => NOW, log: () => {} }) };
}
const photo = (text) => ({ phone: ANA, media: true, text: '', read: async () => text });

test('o que conta como aviso de pagamento em texto', () => {
  for (const text of ['segue o comprovante', 'Comprovante', 'comprovante do pix', 'Paguei!', 'já paguei', 'fiz o pix', 'pix feito ✅', 'Pix enviado', 'pagamento realizado', 'transferi agora']) {
    assert.ok(looksLikeReceipt({ text }), text);
  }
  for (const text of ['vou mandar o comprovante', 'ainda não paguei', 'não fiz o pix', 'vou fazer o pix amanhã', 'quanto fica o pix?', 'obrigada!', '']) {
    assert.ok(!looksLikeReceipt({ text }), text);
  }
});

test('comprovante que confere: pedido vai para a produção', async () => {
  const { moved, confirmations, r } = setup();
  const reply = await r.handle(photo(GOOD));
  assert.equal(reply, 'Recebi seu comprovante 🧾 Conferi o pagamento de *R$ 10,00*. Obrigada, Ana! O pedido *DD-K7P2* já foi para a produção 👩‍🍳');
  assert.deepEqual(moved, ['o1']);
  assert.equal(confirmations[0].order.receipt_note, 'valor e data conferidos');
  assert.equal(await r.handle(photo(GOOD)), null, 'segunda foto: pedido já está em produção, sem resposta');
});

test('foto qualquer ou comprovante errado: não avança, a loja confere', async () => {
  const { moved, flagged, confirmations, r } = setup();
  assert.equal(await r.handle(photo('foto de um bolo de aniversário')), 'Recebi seu comprovante 🧾 Vou conferir aqui e já te confirmo, Ana 💛');
  assert.deepEqual(moved, []);
  assert.equal(confirmations[0].order.status, 'confirmado');
  assert.deepEqual(flagged, ['não achei o valor do pedido nem o código DD-K7P2']);
  assert.equal(await r.handle(photo('R$ 10,00 01/10/2026 10:00')), null, 'segunda tentativa que não confere: sem repetir a resposta');
  assert.equal(flagged[1], 'a data do pagamento é de antes do pedido');
  assert.match(await r.handle(photo(GOOD)), /já foi para a produção/, 'depois manda o certo: confere e avança');
});

test('"paguei" sem anexo: pede o comprovante e não muda nada', async () => {
  const { moved, flagged, r } = setup();
  assert.equal(await r.handle({ phone: ANA, text: 'paguei' }), 'Que bom, Ana! Me manda o comprovante por aqui (foto ou PDF) que eu confiro e já coloco o pedido *DD-K7P2* na produção 🧾');
  assert.deepEqual(moved, []);
  assert.deepEqual(flagged, []);
});

test('mesma pessoa pelo número sem o 9; outra pessoa não', async () => {
  assert.ok(await setup().r.handle({ ...photo(GOOD), phone: '551188887777' }));
  assert.equal(await setup().r.handle({ ...photo(GOOD), phone: '5521999990000' }), null);
});

test('sem pedido esperando pagamento, nada acontece (foto segue para a conversa)', async () => {
  const cases = [
    [{ sent_at: new Date(NOW - RECEIPT_WINDOW_MS - 1).toISOString(), order: order() }], // confirmação antiga
    [{ sent_at: new Date(NOW - 60e3).toISOString(), order: order({ paid: true }) }], // pago na hora (balcão)
    [{ sent_at: new Date(NOW - 60e3).toISOString(), order: order({ status: 'producao' }) }], // já andou
    [],
  ];
  for (const c of cases) {
    const { moved, flagged, r } = setup(c);
    assert.equal(await r.handle(photo(GOOD)), null);
    assert.deepEqual([moved, flagged], [[], []]);
  }
  assert.equal(await setup().r.handle({ phone: ANA, text: 'oi, tudo bem?' }), null, 'texto comum segue para a conversa');
});

test('dois pedidos esperando: vale a confirmação mais recente', async () => {
  const { moved, r } = setup([
    { sent_at: new Date(NOW - 7200e3).toISOString(), order: order({ id: 'velho', code: 'DD-AAAA' }) },
    { sent_at: new Date(NOW - 600e3).toISOString(), order: order({ id: 'novo', code: 'DD-BBBB' }) },
  ]);
  assert.match(await r.handle(photo(GOOD)), /DD-BBBB/);
  assert.deepEqual(moved, ['novo']);
});

test('erro ao ler o arquivo conta como ilegível', async () => {
  const { flagged, r } = setup();
  assert.match(await r.handle({ phone: ANA, media: true, read: async () => { throw new Error('ocr fora do ar'); } }), /Vou conferir/);
  assert.deepEqual(flagged, ['não consegui ler o comprovante']);
});
