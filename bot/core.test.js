// npm test: confere quando o bot responde e quando fica quieto (número de uso pessoal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, SESSION_TTL_MS, PAUSE_TTL_MS } from './core.js';
import { detectIntent, samePhone } from '../supabase/functions/_shared/bot-engine.js';

const PRODUCTS = [
  { id: 'p1', name: 'Brigadeiro', category: 'doces', price: 4, cost: 1.35, active: true },
  { id: 'p2', name: 'Casadinho', category: 'doces', price: 4, cost: 1.5, active: true },
  { id: 'p3', name: 'Caixinha 4 docinhos', category: 'doces', price: 15, cost: 5.9, active: true },
  { id: 'p4', name: 'Morango Cravejado', category: 'doces', price: 12, cost: 4.6, active: true },
  { id: 'p5', name: 'Empadinha de Frango com Catupiry', category: 'salgados', price: 8, cost: 3.1, active: true },
];
const ANA = '5511988887777';
const CRIS = '5511941776869';

function setup({ admins = [], failOrder = false } = {}) {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const rows = new Map();
  const orders = [];
  const subs = new Set();
  const news = [];
  const sessions = {
    get: async (phone) => rows.get(phone) ?? null,
    save: async (phone, data) => {
      if (data) rows.set(phone, { data: structuredClone(data), updated_at: new Date(clock).toISOString() });
      else rows.delete(phone);
    },
  };
  const ctx = {
    listProducts: async () => PRODUCTS,
    getSettings: async () => ({ pix_key: 'pix@doce.com' }),
    isAdmin: async (phone) => admins.find((a) => samePhone(a.phone, phone)) || null,
    listNews: async () => [],
    subscribe: async (phone, _name, on) => (on ? subs.add(phone) : subs.delete(phone)),
    placeOrder: async (o) => {
      if (failOrder) throw new Error('banco fora do ar');
      orders.push(o);
      return { code: 'DD-TEST', total: o.items.reduce((s, i) => s + i.qty * 4, 0) };
    },
    findOrder: async (code) => (code === 'DD-K7P2' ? { code, phone: ANA, total: 40, items: [{ qty: 10, name: 'Brigadeiro' }] } : null),
    createNews: async (n) => { news.push(n); return { id: 'n1', ...n }; },
    broadcast: async () => ({ queued: true }),
    listOpenOrders: async () => [],
    notifyHuman: async () => {},
  };
  const core = createCore({ ctx, sessions, now: () => clock, log: () => {} });
  const say = (text, phone = ANA, extra = {}) => core.handleIncoming({ phone, text, profileName: 'Ana', isGroup: false, ...extra });
  return { core, say, rows, orders, subs, news, tick: (ms) => { clock += ms; } };
}

test('mensagens pessoais ficam sem resposta', async () => {
  const personal = [
    'Oi filha, tudo bem?', 'oi', 'bom dia', 'kkkkk', 'Pega 1 kg de frango no mercado', 'fiz um pedido no ifood',
    'chegou a encomenda?', 'vou fazer um pedido de pizza', 'comi um brigadeiro', 'tô chegando em 5 min',
    'obrigada!', 'vou encomendar na amazon', '#tbt', 'qual o menu do jantar hoje?',
  ];
  for (const text of personal) {
    const { say, rows } = setup();
    assert.deepEqual(await say(text), [], `não devia responder: "${text}"`);
    assert.equal(rows.size, 0, `não devia abrir conversa: "${text}"`);
  }
});

test('identifica mensagens de encomenda', () => {
  const cases = {
    menu: 'explicit', 'Menu': 'explicit', 'me manda o cardápio': 'explicit', '#pedido 6 casadinhos': 'explicit',
    'Oi! Vim pelo site e quero fazer uma encomenda 🍫': 'explicit', 'Oi! Quero receber as novidades por aqui 🔔': 'explicit',
    'parar novidades': 'explicit', 'queria fazer uma encomenda': 'explicit', 'Oi! Acabei de fazer o pedido *DD-K7P2* pelo site 🎓': 'explicit',
    'quero 10 brigadeiros e 2 empadinhas': 'order', '10x brigadeiro': 'order', 'tem como fazer 50 brigadeiros pra sábado?': 'order',
    'quanto custa o brigadeiro?': 'order', 'quero uma caixinha': 'order', 'uma duzia de casadinhos': 'order',
    'oi tudo bem': null, 'comprei 3 caixas de leite': null, 'faz 1 frango assado': null,
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(detectIntent(text, PRODUCTS), want, text);
});

test('"menu" abre o atendimento e o pedido completo chega na plataforma', async () => {
  const { say, rows, orders } = setup();
  assert.match((await say('menu'))[0], /Fazer encomenda/);
  assert.match((await say('1'))[0], /Mande o \*número\*/);
  assert.match((await say('1'))[0], /Brigadeiro.*Quantas/s);
  assert.match((await say('10'))[0], /Anotado: 10x Brigadeiro/);
  assert.match((await say('0'))[0], /Para quem é o pedido/);
  assert.match((await say('Ana Souza'))[0], /\*Total: R\$ 40,00\*/);
  assert.match((await say('1'))[0], /Pedido \*DD-TEST\* recebido/);
  assert.deepEqual(orders, [{ customer_name: 'Ana Souza', phone: ANA, channel: 'whatsapp', items: [{ product_id: 'p1', qty: 10 }] }]);
  assert.equal(rows.size, 0, 'conversa encerrada depois do pedido');
  assert.deepEqual(await say('obrigada!'), [], 'agradecimento depois do pedido não reabre o menu');
});

test('pedido escrito direto ("quero 10 brigadeiros e 2 empadinhas")', async () => {
  const { say, orders } = setup();
  const [r] = await say('Oi, quero 10 brigadeiros e 2 empadinhas');
  assert.match(r, /10x Brigadeiro/);
  assert.match(r, /2x Empadinha/);
  await say('1'); // usa o nome do perfil
  await say('sim');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].customer_name, 'Ana');
});

test('mensagem do site com código não duplica o pedido', async () => {
  const { say, orders } = setup();
  const msg = 'Oi! Acabei de fazer o pedido *DD-K7P2* pelo site 🎓\n\n• 10x Brigadeiro\n\nTotal: *R$ 40,00*\nNome: Ana';
  const [r] = await say(msg);
  assert.match(r, /Pedido \*DD-K7P2\* recebido/);
  assert.match(r, /Pix/);
  assert.doesNotMatch(r, /Para quem é o pedido/);
  assert.equal(orders.length, 0);
  // celular antigo sem o 9 no WhatsApp: ainda reconhece que o pedido é da mesma pessoa
  const [r2] = await setup().say(msg, '551188887777');
  assert.match(r2, /10x Brigadeiro/);
  // pedido de outra pessoa: não mostra os itens
  const [r3] = await setup().say(msg, '5521999990000');
  assert.doesNotMatch(r3, /Brigadeiro/);
});

test('conversa parada há mais de 30 min expira', async () => {
  const { say, tick } = setup();
  await say('menu');
  tick(SESSION_TTL_MS - 60e3);
  assert.match((await say('2'))[0], /Cardápio/, 'ainda dentro dos 30 min');
  tick(SESSION_TTL_MS - 60e3);
  assert.match((await say('1'))[0], /Mande o \*número\*/, 'resposta renova o prazo');
  tick(SESSION_TTL_MS + 1);
  assert.deepEqual(await say('3'), [], 'depois de 30 min parado, "3" é mensagem comum');
});

test('resposta pelo celular pausa o bot por 12 h; "menu" chama de volta', async () => {
  const { core, say, tick } = setup();
  await say('quero 10 brigadeiros');
  await core.pause(ANA);
  assert.deepEqual(await say('Ana'), []);
  assert.deepEqual(await say('quero mais 5 casadinhos'), [], 'pedido escrito durante a pausa fica com a pessoa');
  assert.match((await say('menu'))[0], /Fazer encomenda/, '"menu" tira da pausa');
  await core.pause(ANA);
  tick(PAUSE_TTL_MS + 1);
  assert.match((await say('quero 5 casadinhos'))[0], /5x Casadinho/, 'pausa acaba depois de 12 h');
});

test('opção 5 (falar com a gente) deixa o bot quieto', async () => {
  const { say } = setup();
  await say('menu');
  assert.match((await say('5'))[0], /Chamei a Cris/);
  assert.deepEqual(await say('1'), []);
  assert.match((await say('cardápio'))[0], /Cardápio/);
});

test('áudio ou figurinha só recebe aviso no meio de um pedido', async () => {
  const { say } = setup();
  assert.deepEqual(await say(''), []);
  await say('menu');
  assert.match((await say(''))[0], /só entendo texto/);
});

test('grupo: só #pedido, e a conversa continua no privado', async () => {
  const { say, orders } = setup();
  const group = { isGroup: true };
  assert.deepEqual(await say('oi gente', ANA, group), []);
  assert.deepEqual(await say('quero 10 brigadeiros', ANA, group), [], 'em grupo precisa de #pedido');
  assert.match((await say('#pedido 6 casadinhos', ANA, group))[0], /privado/);
  await say('Ana');
  await say('1');
  assert.equal(orders[0].channel, 'grupo');
});

test('novidades: inscrição pelo botão do site e "parar novidades"', async () => {
  const { say, subs, tick } = setup();
  assert.match((await say('Oi! Quero receber as novidades por aqui 🔔'))[0], /novidades/);
  assert.ok(subs.has(ANA));
  tick(SESSION_TTL_MS + 1);
  await say('parar novidades');
  assert.ok(!subs.has(ANA));
});

test('comandos de administradora só para números autorizados', async () => {
  const { say, news } = setup({ admins: [{ phone: CRIS, name: 'Cris', can_post: true, can_manage_orders: true }] });
  assert.match((await say('#pedidos', CRIS))[0], /Nenhum pedido em aberto/);
  assert.match((await say('#novidade Kit Provas | 4 docinhos', CRIS))[0], /inscritos recebem/);
  assert.equal(news.length, 1);
  assert.deepEqual(await say('#pedidos', ANA), [], 'cliente comum não vê pedidos');
});

test('erro ao gravar o pedido avisa o cliente', async () => {
  const { say } = setup({ failOrder: true });
  await say('quero 2 brigadeiros');
  await say('1');
  assert.match((await say('1'))[0], /Ops, algo deu errado/);
});
