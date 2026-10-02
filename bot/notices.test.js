// npm test: avisos automáticos do pedido (Pix na confirmação, "pronto para entrega").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotices, noticeTexts, NOTICE_MAX_AGE_MS } from './notices.js';

const NOW = Date.parse('2026-10-02T18:00:00-03:00');
const ORDER = {
  id: 'o1', code: 'DD-K7P2', customer_name: 'Ana Clara', phone: '5511988887777', status: 'confirmado',
  items: [{ name: 'Brigadeiro', qty: 10 }, { name: 'Empadinha', qty: 2 }], total: 66, discount: 0,
};

function setup({ notices = [], online = true, jid = (p) => `${p}@s.whatsapp.net`, sendOk = true, claimOk = true, store = { pix_key: 'pix@doce.com' } } = {}) {
  const rows = notices.map((n, i) => ({ id: i + 1, status: 'pendente', error: null, sent_at: null, created_at: new Date(NOW - 60e3).toISOString(), ...n }));
  const sent = [];
  const db = {
    settings: async () => store,
    pending: async () => rows.filter((r) => r.status === 'pendente').sort((a, b) => a.id - b.id),
    claim: async (id) => {
      const r = claimOk && rows.find((x) => x.id === id && x.status === 'pendente');
      if (r) r.status = 'enviando';
      return !!r;
    },
    mark: async (id, patch) => Object.assign(rows.find((x) => x.id === id), patch),
  };
  const wa = { online: () => online, lookup: async (p) => jid(p), send: async (j, text) => { sent.push({ j, text }); return sendOk; } };
  const queue = createNotices({ db, wa, now: () => NOW, log: () => {} });
  return { rows, sent, tick: () => queue.tick() };
}

test('confirmação: itens e total, e o Pix Copia e Cola sozinho numa segunda mensagem', () => {
  const texts = noticeTexts('confirmado', ORDER, { pix_key: 'pix@doce.com' });
  assert.equal(texts.length, 2);
  const [a, b] = texts;
  assert.match(noticeTexts('confirmado', ORDER, { pix_key: '11941776869' })[0], /_Se preferir, a chave é celular \+55 11 94177-6869_/);
  assert.match(a, /^Oi, Ana! Seu pedido \*DD-K7P2\* está confirmado ✅/);
  assert.match(a, /• 10x Brigadeiro\n• 2x Empadinha\nTotal: \*R\$ 66,00\*/);
  assert.match(a, /💸 \*Pagamento por Pix\*\nCopie o código da próxima mensagem e cole no app do banco em \*Pix Copia e Cola\*/);
  assert.match(a, /_Se preferir, a chave é e-mail pix@doce\.com_/);
  assert.match(a, /comprovante/);
  assert.match(b, /^000201/, 'segunda mensagem: só o código');
  assert.ok(b.includes('0112pix@doce.com') && b.includes('540566.00') && b.includes('0506DDK7P2'), b);
});

test('confirmação com cupom mostra o desconto; sem chave Pix vai uma mensagem só', () => {
  const texts = noticeTexts('confirmado', { ...ORDER, total: 59.4, discount: 6.6 }, {});
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Total: \*R\$ 59,40\* \(já com R\$ 6,60 de desconto\)/);
  assert.match(texts[0], /combinamos o pagamento por aqui/);
  assert.doesNotMatch(texts[0], /Pix/);
});

test('pronto: disponível para entrega', () => {
  const [a] = noticeTexts('pronto', ORDER, {});
  assert.match(a, /^Oi, Ana! Seu pedido \*DD-K7P2\* está prontinho e disponível para entrega/);
  assert.match(a, /horário e o local/);
});

test('envia a confirmação e marca como enviada', async () => {
  const { rows, sent, tick } = setup({ notices: [{ kind: 'confirmado', order: ORDER }] });
  await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].j, '5511988887777@s.whatsapp.net');
  assert.match(sent[1].text, /^000201.*6304[0-9A-F]{4}$/);
  assert.equal(rows[0].status, 'enviada');
  assert.equal(rows[0].sent_at, new Date(NOW).toISOString());
});

test('Pix vale enquanto o pedido anda na esteira; cancelado pula', async () => {
  const { rows, sent, tick } = setup({ notices: [
    { kind: 'confirmado', order: { ...ORDER, status: 'pronto' } },
    { kind: 'confirmado', order: { ...ORDER, id: 'o2', status: 'cancelado' } },
  ] });
  await tick();
  assert.deepEqual(rows.map((r) => r.status), ['enviada', 'pulada']);
  assert.equal(sent.length, 2);
});

test('pedido que voltou atrás espera; "pronto" de pedido já entregue pula', async () => {
  const { rows, sent, tick } = setup({ notices: [
    { kind: 'confirmado', order: { ...ORDER, status: 'novo' } },
    { kind: 'pronto', order: { ...ORDER, status: 'producao' } },
    { kind: 'pronto', order: { ...ORDER, status: 'entregue' } },
  ] });
  await tick();
  assert.deepEqual(rows.map((r) => r.status), ['pendente', 'pendente', 'pulada']);
  assert.equal(sent.length, 0);
});

test('aviso de mais de 1 dia (bot desligado esse tempo todo) pula', async () => {
  const old = new Date(NOW - NOTICE_MAX_AGE_MS - 1).toISOString();
  const { rows, sent, tick } = setup({ notices: [{ kind: 'pronto', order: { ...ORDER, status: 'pronto' }, created_at: old }] });
  await tick();
  assert.equal(rows[0].status, 'pulada');
  assert.match(rows[0].error, /antigo/);
  assert.equal(sent.length, 0);
});

test('número sem WhatsApp e erro de envio ficam como "falhou"', async () => {
  const a = setup({ notices: [{ kind: 'pronto', order: { ...ORDER, status: 'pronto' } }], jid: () => null });
  await a.tick();
  assert.equal(a.rows[0].status, 'falhou');
  assert.equal(a.rows[0].error, 'Número sem WhatsApp');
  const b = setup({ notices: [{ kind: 'pronto', order: { ...ORDER, status: 'pronto' } }], sendOk: false });
  await b.tick();
  assert.equal(b.rows[0].status, 'falhou');
  assert.equal(b.rows[0].error, 'Erro ao enviar');
});

test('bot desconectado não mexe na fila', async () => {
  const { rows, sent, tick } = setup({ notices: [{ kind: 'confirmado', order: ORDER }], online: false });
  assert.equal(await tick(), 'offline');
  assert.equal(rows[0].status, 'pendente');
  assert.equal(sent.length, 0);
});

test('aviso que outra cópia já pegou não é enviado de novo', async () => {
  const { rows, sent, tick } = setup({ notices: [{ kind: 'confirmado', order: ORDER }], claimOk: false });
  await tick();
  assert.equal(rows[0].status, 'pendente');
  assert.equal(sent.length, 0);
});

test('entrega no ponto: confirmação e pronto citam o lugar e o dia', () => {
  const store = { pix_key: 'pix@doce.com', delivery_spot: { label: 'Na faculdade, em dia de aula', days: [1, 2, 3, 5] } };
  const o = { ...ORDER, delivery: 'ponto', delivery_date: '2026-10-09' };
  assert.match(noticeTexts('confirmado', o, store)[0], /Total: \*R\$ 66,00\*\n📍 Entrega: Na faculdade, em dia de aula · sexta, 09\/10\n\n💸/);
  const [ready] = noticeTexts('pronto', o, store);
  assert.match(ready, /prontinho 🎓🍫\n📍 Entrega: Na faculdade, em dia de aula · sexta, 09\/10/);
  assert.doesNotMatch(ready, /combina/);
  assert.doesNotMatch(noticeTexts('confirmado', ORDER, store)[0], /Entrega/, 'combinar: sem linha de entrega');
});

test('pronto com observação do pedido: repete o que a cliente escreveu em vez de perguntar', () => {
  const [a] = noticeTexts('pronto', { ...ORDER, notes: 'retirar quinta às 10h' }, {});
  assert.match(a, /📝 Você escreveu: "retirar quinta às 10h"\nSe algo mudou, me avisa por aqui/);
  assert.doesNotMatch(a, /Me conta o melhor horário/);
  assert.match(noticeTexts('pronto', { ...ORDER, notes: '  ' }, {})[0], /Me conta o melhor horário/, 'observação em branco não conta');
});
