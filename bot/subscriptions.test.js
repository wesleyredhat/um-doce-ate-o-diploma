// npm test: entrada e saída das novidades e das campanhas (subscriptions.js), com banco falso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptions } from './subscriptions.js';

const NOW = Date.parse('2026-10-02T15:00:00Z');

function setup({ subscribers = [], sent = [] } = {}) {
  const subs = new Map(subscribers.map((p) => [p, 'Inscrita']));
  const optouts = new Map();
  const db = {
    addSubscriber: async (phone, name) => { subs.set(phone, name); },
    removeSubscriber: async (phone) => subs.delete(phone),
    addOptout: async (key, phone) => { optouts.set(key, phone); },
    removeOptout: async (key) => { optouts.delete(key); },
    sentCount: async (key, since) => sent.filter((x) => x.key === key && (!since || x.at >= since)).length,
  };
  return { subs, optouts, s: createSubscriptions(db, () => NOW) };
}

test('sair grava a lista de saída pela chave do telefone (com o 9)', async () => {
  const { s, optouts, subs } = setup({ subscribers: ['551188887777'] });
  assert.equal(await s.subscribe('551188887777', 'Ana', false), true, 'era inscrita: o bot confirma');
  assert.equal(optouts.get('5511988887777'), '551188887777');
  assert.ok(!subs.has('551188887777'));
});

test('quem só recebeu campanha também recebe a confirmação; quem não recebia nada, não', async () => {
  const camp = setup({ sent: [{ key: '5511988887777', at: '2026-09-01T12:00:00.000Z' }] });
  assert.equal(await camp.s.subscribe('5511988887777', 'Ana', false), true);
  const none = setup();
  assert.equal(await none.s.subscribe('5521977776666', 'Bia', false), false, 'pode ser só conversa: o bot fica quieto');
  assert.ok(none.optouts.has('5521977776666'), 'mesmo assim sai das campanhas');
});

test('"quero receber novidades" tira da lista de saída e inscreve de novo', async () => {
  const { s, optouts, subs } = setup();
  await s.subscribe('5511988887777', 'Ana', false);
  await s.subscribe('5511988887777', 'Ana', true);
  assert.ok(!optouts.has('5511988887777'));
  assert.equal(subs.get('5511988887777'), 'Ana');
});

test('"parar" sozinho só vale para quem recebeu campanha nos últimos 30 dias', async () => {
  const { s } = setup({ sent: [{ key: '5511988887777', at: '2026-09-10T12:00:00.000Z' }, { key: '5521977776666', at: '2026-08-01T12:00:00.000Z' }] });
  assert.equal(await s.gotCampaign('551188887777'), true, 'sem o 9 é a mesma pessoa');
  assert.equal(await s.gotCampaign('5521977776666'), false, 'campanha de mais de 30 dias');
  assert.equal(await s.gotCampaign('5531966665555'), false);
});
