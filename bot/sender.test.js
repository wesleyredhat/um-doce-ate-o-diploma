// npm test: ritmo e regras do envio de campanhas (sender.js), com banco e WhatsApp falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSender, STALE_MS } from './sender.js';

const at = (iso) => Date.parse(iso);
const NOON = at('2026-10-02T15:00:00Z'); // 12h em Brasília
const iso = (ms) => new Date(ms).toISOString();

function setup({ people = 3, settings = {}, optedOut = [], noWa = [], failSend = () => false } = {}) {
  let clock = NOON;
  let online = true;
  const campaigns = [{ id: 'c1', name: 'Volta', body: 'Oi, {nome}! Tem novidade.', coupon_code: 'VOLTA10', status: 'enviando', pause_reason: null }];
  const sends = Array.from({ length: people }, (_, i) => ({
    id: `s${i}`, campaign_id: 'c1', phone: `551198888000${i}`, phone_key: `k${i}`, name: `Pessoa${i} Silva`,
    status: 'pendente', error: null, claimed_at: null, sent_at: null,
  }));
  const sent = [];
  const db = {
    settings: async () => settings,
    requeueStale: async (before) => sends.filter((s) => s.status === 'enviando' && s.claimed_at < before).forEach((s) => { s.status = 'pendente'; }),
    sentSince: async (since) => sends.filter((s) => s.status === 'enviada' && s.sent_at >= since).length,
    nextCampaign: async () => campaigns.find((c) => c.status === 'enviando') || null,
    claim: async (campaignId, now) => {
      const s = sends.find((x) => x.campaign_id === campaignId && x.status === 'pendente');
      if (s) Object.assign(s, { status: 'enviando', claimed_at: now });
      return s || null;
    },
    isOptedOut: async (key) => optedOut.includes(key),
    mark: async (id, patch) => { Object.assign(sends.find((s) => s.id === id), patch); },
    pause: async (id, reason) => { Object.assign(campaigns.find((c) => c.id === id), { status: 'pausada', pause_reason: reason }); },
    finish: async (id) => {
      if (sends.some((s) => s.campaign_id === id && ['pendente', 'enviando'].includes(s.status))) return false;
      Object.assign(campaigns.find((c) => c.id === id), { status: 'concluida' });
      return true;
    },
  };
  const wa = {
    online: () => online,
    lookup: async (phone) => (noWa.includes(phone) ? null : `${phone}@s.whatsapp.net`),
    send: async (jid, text) => { if (failSend(jid)) return false; sent.push({ jid, text }); return true; },
  };
  const sender = createSender({ db, wa, siteUrl: 'https://umdoceateodiploma.com.br/', now: () => clock, random: () => 0.5, log: () => {} });
  return {
    tick: () => sender.tick(), sends, sent, campaigns,
    wait: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; }, setOnline: (v) => { online = v; },
  };
}

test('envia uma por vez e espera entre uma e outra', async () => {
  const { tick, wait, sent } = setup();
  assert.equal(await tick(), 'enviada');
  assert.equal(await tick(), 'aguardando', 'logo em seguida ainda não');
  wait(40e3); // random 0,5 → 40 s
  assert.equal(await tick(), 'enviada');
  assert.match(sent[0].text, /^Oi, Pessoa0! Tem novidade\./);
  assert.match(sent[0].text, /\?cupom=VOLTA10/);
  assert.match(sent[0].text, /parar promoções/);
  assert.equal(sent[0].jid, '5511988880000@s.whatsapp.net');
});

test('só no horário de Brasília', async () => {
  const { tick, setClock } = setup();
  setClock(at('2026-10-02T11:30:00Z')); // 8h30
  assert.equal(await tick(), 'fora do horário');
  setClock(at('2026-10-02T22:59:00Z')); // 19h59
  assert.equal(await tick(), 'enviada');
  setClock(at('2026-10-02T23:00:00Z')); // 20h
  assert.equal(await tick(), 'fora do horário');
});

test('limite do dia, e no dia seguinte continua', async () => {
  const { tick, wait, setClock } = setup({ people: 5, settings: { daily_limit: 2 } });
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'limite do dia');
  setClock(at('2026-10-03T12:00:00Z')); // 9h do dia seguinte
  assert.equal(await tick(), 'enviada');
});

test('pula quem saiu e marca número sem WhatsApp, sem travar a fila', async () => {
  const { tick, sends } = setup({ optedOut: ['k0'], noWa: ['5511988880001'] });
  assert.equal(await tick(), 'pulada');
  assert.equal(await tick(), 'sem whatsapp');
  assert.equal(await tick(), 'enviada');
  assert.deepEqual(sends.map((s) => s.status), ['pulada', 'falhou', 'enviada']);
  assert.equal(sends[1].error, 'Número sem WhatsApp');
});

test('5 erros de envio seguidos pausam a campanha', async () => {
  const { tick, wait, campaigns } = setup({ people: 6, failSend: () => true });
  for (let i = 0; i < 5; i++) {
    assert.equal(await tick(), 'falhou');
    wait(40e3);
  }
  assert.equal(campaigns[0].status, 'pausada');
  assert.match(campaigns[0].pause_reason, /5 envios seguidos falharam/);
  assert.equal(await tick(), 'sem campanha');
});

test('mensagem presa em "enviando" volta para a fila; campanha só conclui no fim', async () => {
  const { tick, wait, sends, campaigns } = setup({ people: 2 });
  Object.assign(sends[0], { status: 'enviando', claimed_at: iso(NOON - STALE_MS - 1000) }); // bot caiu há mais de 5 min
  Object.assign(sends[1], { status: 'enviando', claimed_at: iso(NOON - 60e3) }); // ainda pode estar saindo
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'aguardando', 'não conclui com mensagem ainda em envio');
  wait(STALE_MS);
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'concluída');
  assert.equal(campaigns[0].status, 'concluida');
});

test('WhatsApp desconectado: a fila só espera', async () => {
  const { tick, setOnline, sent } = setup();
  setOnline(false);
  assert.equal(await tick(), 'offline');
  assert.equal(sent.length, 0);
});
