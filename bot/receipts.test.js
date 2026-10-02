// npm test: comprovante do Pix pelo WhatsApp (foto, PDF ou "paguei") leva o pedido para a produção.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceipts, looksLikeReceipt, RECEIPT_WINDOW_MS } from './receipts.js';

const NOW = Date.parse('2026-10-02T20:00:00-03:00');
const ANA = '5511988887777';
const order = (o) => ({ id: 'o1', code: 'DD-K7P2', customer_name: 'Ana Clara', phone: ANA, status: 'confirmado', paid: false, ...o });

function setup(confirmations = [{ sent_at: new Date(NOW - 3600e3).toISOString(), order: order() }]) {
  const moved = [];
  const db = {
    recentConfirmations: async (since) => confirmations.filter((c) => c.sent_at >= since),
    advance: async (id, at) => {
      const c = confirmations.find((x) => x.order.id === id && x.order.status === 'confirmado');
      if (!c) return false;
      Object.assign(c.order, { status: 'producao', receipt_at: at });
      moved.push(id);
      return true;
    },
  };
  return { moved, confirmations, r: createReceipts({ db, now: () => NOW, log: () => {} }) };
}

test('o que conta como comprovante', () => {
  for (const text of ['segue o comprovante', 'Comprovante', 'comprovante do pix', 'Paguei!', 'já paguei', 'fiz o pix', 'pix feito ✅', 'Pix enviado', 'pagamento realizado', 'transferi agora']) {
    assert.ok(looksLikeReceipt({ text }), text);
  }
  for (const text of ['vou mandar o comprovante', 'ainda não paguei', 'não fiz o pix', 'vou fazer o pix amanhã', 'quanto fica o pix?', 'obrigada!', '']) {
    assert.ok(!looksLikeReceipt({ text }), text);
  }
  assert.ok(looksLikeReceipt({ media: true, text: '' }), 'foto ou PDF sem legenda');
});

test('foto do comprovante: pedido vai para a produção e a cliente recebe a resposta', async () => {
  const { moved, confirmations, r } = setup();
  const reply = await r.handle({ phone: ANA, media: true, text: '' });
  assert.equal(reply, 'Recebi seu comprovante 🧾 Obrigada, Ana! O pedido *DD-K7P2* já foi para a produção 👩‍🍳');
  assert.deepEqual(moved, ['o1']);
  assert.equal(confirmations[0].order.receipt_at, new Date(NOW).toISOString());
  assert.equal(await r.handle({ phone: ANA, media: true, text: '' }), null, 'segunda foto: pedido já está em produção, sem resposta');
});

test('mesma pessoa pelo número sem o 9; outra pessoa não', async () => {
  assert.ok(await setup().r.handle({ phone: '551188887777', media: true }));
  assert.equal(await setup().r.handle({ phone: '5521999990000', media: true }), null);
});

test('sem pedido esperando pagamento, nada acontece', async () => {
  const cases = [
    [{ sent_at: new Date(NOW - RECEIPT_WINDOW_MS - 1).toISOString(), order: order() }], // confirmação antiga
    [{ sent_at: new Date(NOW - 60e3).toISOString(), order: order({ paid: true }) }], // pago na hora (balcão)
    [{ sent_at: new Date(NOW - 60e3).toISOString(), order: order({ status: 'producao' }) }], // já andou
    [],
  ];
  for (const c of cases) {
    const { moved, r } = setup(c);
    assert.equal(await r.handle({ phone: ANA, media: true }), null);
    assert.deepEqual(moved, []);
  }
  assert.equal(await setup().r.handle({ phone: ANA, text: 'oi, tudo bem?' }), null, 'texto comum segue para a conversa');
});

test('dois pedidos esperando: o comprovante vale para a confirmação mais recente', async () => {
  const { moved, r } = setup([
    { sent_at: new Date(NOW - 7200e3).toISOString(), order: order({ id: 'velho', code: 'DD-AAAA' }) },
    { sent_at: new Date(NOW - 600e3).toISOString(), order: order({ id: 'novo', code: 'DD-BBBB' }) },
  ]);
  assert.match(await r.handle({ phone: ANA, text: 'paguei' }), /DD-BBBB/);
  assert.deepEqual(moved, ['novo']);
});
