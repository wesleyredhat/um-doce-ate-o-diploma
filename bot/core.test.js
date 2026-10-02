// npm test: confere quando o bot responde e quando fica quieto (número de uso pessoal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, SESSION_TTL_MS, PAUSE_TTL_MS } from './core.js';
import { detectIntent, parseQuickOrder, samePhone } from '../supabase/functions/_shared/bot-engine.js';
import { quoteCoupon, phoneKey } from '../assets/js/coupons.js';

const PRODUCTS = [
  { id: 'p1', name: 'Brigadeiro', category: 'doces', price: 4, cost: 1.35, active: true },
  { id: 'p2', name: 'Casadinho', category: 'doces', price: 4, cost: 1.5, active: true },
  { id: 'p3', name: 'Caixinha 4 docinhos', category: 'doces', price: 15, cost: 5.9, active: true },
  { id: 'p4', name: 'Morango Cravejado', category: 'doces', price: 12, cost: 4.6, active: true },
  { id: 'p5', name: 'Empadinha de Frango com Catupiry', category: 'salgados', price: 8, cost: 3.1, active: true },
];
const ANA = '5511988887777';
const CRIS = '5511941776869';
const C = { kind: 'percent', value: 10, min_order: 0, starts_on: null, ends_on: null, max_uses: null, active: true };
const COUPONS = {
  VOLTA10: { ...C, code: 'VOLTA10' },
  DOCE5: { ...C, code: 'DOCE5', kind: 'fixed', value: 5, min_order: 30 },
  FIM1: { ...C, code: 'FIM1', max_uses: 1 },
  VELHO1: { ...C, code: 'VELHO1', ends_on: '2026-09-30' },
};
const subtotalOf = (items) => items.reduce((s, i) => s + i.qty * PRODUCTS.find((p) => p.id === i.product_id).price, 0);

function setup({ admins = [], failOrder = false, subscribed = [] } = {}) {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const rows = new Map();
  const orders = [];
  const subs = new Set(subscribed);
  const news = [];
  const used = new Map(); // código → Set de phoneKey de quem já usou
  const checkCoupon = async (code, phone, items) => {
    const c = COUPONS[String(code).toUpperCase()];
    const u = used.get(c?.code) || new Set();
    return quoteCoupon(c, { code, subtotal: subtotalOf(items), uses: u.size, usedByPhone: u.has(phoneKey(phone)), now: clock });
  };
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
    // igual ao bot: ao sair, diz se a pessoa estava inscrita
    subscribe: async (phone, _name, on) => (on ? void subs.add(phone) : subs.delete(phone)),
    checkCoupon,
    placeOrder: async (o) => {
      if (failOrder) throw new Error('banco fora do ar');
      const subtotal = subtotalOf(o.items);
      let discount = 0;
      if (o.coupon) {
        const q = await checkCoupon(o.coupon, o.phone, o.items);
        if (!q.valid) throw new Error(q.message);
        discount = q.discount;
        if (!used.has(q.code)) used.set(q.code, new Set());
        used.get(q.code).add(phoneKey(o.phone));
      }
      orders.push(o);
      return { code: 'DD-TEST', total: subtotal - discount, discount };
    },
    findOrder: async (code) => (code === 'DD-K7P2' ? { code, phone: ANA, total: 40, items: [{ qty: 10, name: 'Brigadeiro' }] } : null),
    createNews: async (n) => { news.push(n); return { id: 'n1', ...n }; },
    broadcast: async () => ({ queued: true }),
    listOpenOrders: async () => [],
    notifyHuman: async () => {},
  };
  const core = createCore({ ctx, sessions, now: () => clock, log: () => {} });
  const say = (text, phone = ANA, extra = {}) => core.handleIncoming({ phone, text, profileName: 'Ana', isGroup: false, ...extra });
  return { core, say, rows, orders, subs, news, used, tick: (ms) => { clock += ms; } };
}

test('mensagens pessoais ficam sem resposta', async () => {
  const personal = [
    'Oi filha, tudo bem?', 'oi', 'bom dia', 'kkkkk', 'Pega 1 kg de frango no mercado', 'fiz um pedido no ifood',
    'chegou a encomenda?', 'vou fazer um pedido de pizza', 'comi um brigadeiro', 'tô chegando em 5 min',
    'obrigada!', 'vou encomendar na amazon', '#tbt', 'qual o menu do jantar hoje?',
    // frases que a revisão mostrou que disparavam o bot
    'Compra 2 caixinhas de creme de leite pra mim?', 'Comprei 4 caixinhas de leite condensado', 'Quanto deu a caixinha do churrasco?',
    'Quanto tá o morango na feira?', 'Comi 2 brigadeiros da festa, tava divino!', 'sobrou 10 brigadeiros da festa',
    'Quanto tempo de Uber até a Brigadeiro?', 'comprei 6 empadinhas na padaria', 'Qual o cardápio do jantar hoje?',
    'Preciso fazer um pedido no mercado, quer algo?', 'Quero fazer um pedido de pizza hoje', 'queria encomendar as flores do casamento',
    'O menu do almoço de domingo vai ser lasanha', 'Amiga, todo mundo amou o brigadeiro. Quero te ver logo!',
    'Assim que eu receber novidades do médico te aviso', 'Te amo, beijo', 'parar de receber novidades',
  ];
  for (const text of personal) {
    const { say, rows, subs } = setup();
    assert.deepEqual(await say(text), [], `não devia responder: "${text}"`);
    assert.equal(rows.size, 0, `não devia abrir conversa: "${text}"`);
    assert.equal(subs.size, 0, `não devia inscrever: "${text}"`);
  }
});

test('mãe manda mensagem com "caixinhas": nada de pedido gravado', async () => {
  const { say, orders } = setup();
  for (const text of ['Comprei 4 caixinhas de leite condensado', 'Que pedido?? kkkk', '1']) assert.deepEqual(await say(text), []);
  assert.equal(orders.length, 0);
});

test('identifica mensagens de encomenda', () => {
  const cases = {
    menu: 'keyword', 'Menu': 'keyword', 'Oi, tudo bem? Me manda o cardápio por favor': 'keyword', 'cardápio': 'keyword',
    'qual o cardápio de vocês?': 'keyword', '#pedido 6 casadinhos': 'keyword', '#pedido': 'keyword',
    'Oi! Vim pelo site e quero fazer uma encomenda 🍫': 'site', 'Oi! Acabei de fazer o pedido *DD-K7P2* pelo site 🎓': 'site',
    'Oi! Quero receber as novidades por aqui 🔔': 'subscribe',
    'parar novidades': 'unsubscribe', 'Não quero mais receber novidades': 'unsubscribe', 'quero parar de receber as novidades': 'unsubscribe',
    'me tira das novidades': 'unsubscribe',
    'queria fazer uma encomenda': 'order', 'Gostaria de fazer uma encomenda para o dia 15': 'order', 'quero fazer um pedido pra sábado': 'order',
    'vocês fazem encomenda?': 'order', 'como faço pra encomendar?': 'order',
    'quero 10 brigadeiros e 2 empadinhas': 'order', '10x brigadeiro': 'order', 'tem como fazer 50 brigadeiros pra sábado?': 'order',
    'quanto custa o brigadeiro?': 'order', 'Brigadeiro custa quanto?': 'order', 'qual o valor do casadinho': 'order',
    'quero uma caixinha de docinhos': 'order', '2 morangos cravejados': 'order', 'uma duzia de casadinhos': 'order',
    'meia dúzia de brigadeiros': 'order', 'preciso de 50 casadinhos pra sexta': 'order',
    'oi tudo bem': null, 'comprei 3 caixas de leite': null, 'faz 1 frango assado': null, 'quero uma caixinha': null,
    'cupom VOLTA10': 'coupon', 'Oi, tenho o cupom doce5': 'coupon', 'parar promoções': 'unsubscribe', 'quero receber promoções': 'subscribe',
    'qual cupom tem hoje?': null, 'tem cupom do ifood?': null,
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

test('pedido escrito direto, com ponto final', async () => {
  const { say, orders } = setup();
  const [r] = await say('Oi, quero 10 brigadeiros e 2 empadinhas.');
  assert.match(r, /10x Brigadeiro/);
  assert.match(r, /2x Empadinha/);
  await say('1'); // usa o nome do perfil
  await say('sim');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].customer_name, 'Ana');
});

test('leitura de quantidades', () => {
  const read = (t) => parseQuickOrder(t, PRODUCTS).map((x) => `${x.qty}x ${x.product.id}`).join(' ');
  assert.equal(read('quero 10 brigadeiros e 2 empadinhas.'), '10x p1 2x p5');
  assert.equal(read('um cento de brigadeiros!'), '100x p1');
  assert.equal(read('meia dúzia de casadinhos'), '6x p2');
  assert.equal(read('uma encomenda de brigadeiros'), '', '"uma encomenda" não é 1 brigadeiro');
});

test('no menu: produto citado, pergunta de preço, "ok, quero o 1", menu uma vez só', async () => {
  const { say } = setup();
  await say('menu');
  assert.match((await say('brigadeiro'))[0], /Brigadeiro\*: R\$ 4,00 cada.*Quantas/s);
  const b = setup();
  await b.say('menu');
  assert.match((await b.say('Brigadeiro custa quanto?'))[0], /R\$ 4,00 cada/);
  const c = setup();
  await c.say('menu');
  assert.match((await c.say('Ok, quero o 1'))[0], /Mande o \*número\*/);
  const d = setup();
  await d.say('Oi! Vim pelo site e quero fazer uma encomenda 🍫');
  assert.deepEqual(await d.say('como funciona?'), [], 'depois do primeiro menu, mensagem solta fica sem resposta');
  assert.deepEqual(await d.say('obrigada'), []);
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
  assert.match((await setup().say(msg, '551188887777'))[0], /10x Brigadeiro/);
  // pedido de outra pessoa: não mostra os itens
  assert.doesNotMatch((await setup().say(msg, '5521999990000'))[0], /Brigadeiro/);
});

test('telefones: celular antigo sem o 9 é o mesmo número; fixo e estrangeiro não', () => {
  assert.ok(samePhone('5511988887777', '551188887777'));
  assert.ok(!samePhone('5511941776869', '551141776869'), 'fixo 11 4177-6869 não é o celular 11 94177-6869');
  assert.ok(!samePhone('5511941776869', '11941776869'));
  assert.ok(!samePhone('', ''));
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

test('resposta pelo celular pausa o bot por 12 h; só menu, cardápio ou #pedido chamam de volta', async () => {
  const { core, say, tick } = setup();
  await say('quero 10 brigadeiros');
  assert.equal(await core.pause(ANA), true);
  assert.deepEqual(await say('Ana'), []);
  assert.deepEqual(await say('quero mais 5 casadinhos'), [], 'pedido escrito durante a pausa fica com a pessoa');
  assert.deepEqual(await say('Oi! Vim pelo site e quero fazer uma encomenda 🍫'), []);
  assert.deepEqual(await say('queria fazer uma encomenda'), []);
  assert.match((await say('menu'))[0], /Fazer encomenda/, '"menu" tira da pausa');
  assert.equal(await core.pause(ANA), true, 'nova resposta pelo celular depois do "menu" pausa de novo');
  assert.equal(await core.pause(ANA), false, 'a mesma pausa não é regravada a cada mensagem');
  assert.deepEqual(await say('1'), []);
  assert.match((await say('#pedido 2 casadinhos'))[0], /2x Casadinho/);
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
  const { say, orders, rows } = setup();
  const group = { isGroup: true };
  assert.deepEqual(await say('oi gente', ANA, group), []);
  assert.deepEqual(await say('quero 10 brigadeiros', ANA, group), [], 'em grupo precisa de #pedido');
  assert.equal(rows.size, 0);
  assert.match((await say('#pedido 6 casadinhos', ANA, group))[0], /privado/);
  await say('Ana');
  await say('1');
  assert.equal(orders[0].channel, 'grupo');
  // "#pedido" sem itens: o menu vai no privado e a resposta de lá continua a conversa
  const b = setup();
  assert.match((await b.say('#pedido', ANA, group))[0], /Fazer encomenda/);
  assert.match((await b.say('1'))[0], /Mande o \*número\*/);
});

test('novidades: inscrição pelo botão do site e saída com frases naturais', async () => {
  for (const out of ['parar novidades', 'parar de receber novidades', 'Não quero mais receber novidades', 'quero parar de receber as novidades']) {
    const { say, subs, rows } = setup();
    assert.match((await say('Oi! Quero receber as novidades por aqui 🔔'))[0], /Você vai receber/);
    assert.ok(subs.has(ANA));
    assert.equal(rows.size, 0, 'inscrição não abre conversa');
    assert.match((await say(out))[0], /não vou mais enviar/, out);
    assert.ok(!subs.has(ANA), out);
  }
  // durante a pausa, sair das novidades continua funcionando
  const { core, say, subs } = setup({ subscribed: [ANA] });
  await core.pause(ANA);
  assert.match((await say('parar novidades'))[0], /não vou mais enviar/);
  assert.ok(!subs.has(ANA));
});

test('comandos de administradora só para números autorizados, sem abrir conversa', async () => {
  const { say, news, rows } = setup({ admins: [{ phone: CRIS, name: 'Cris', can_post: true, can_manage_orders: true }] });
  assert.match((await say('#pedidos', CRIS))[0], /Nenhum pedido em aberto/);
  assert.match((await say('#novidade Kit Provas | 4 docinhos', CRIS))[0], /inscritos recebem/);
  assert.equal(news.length, 1);
  assert.equal(rows.size, 0, 'comando não abre conversa');
  assert.deepEqual(await say('oi, tudo bem?', CRIS), [], 'depois do comando, conversa pessoal continua sem resposta');
  assert.deepEqual(await say('#pedidos', ANA), [], 'cliente comum não vê pedidos');
});

test('nome muito longo ou só um emoji pede o nome de novo', async () => {
  const { say } = setup();
  await say('quero 2 brigadeiros');
  assert.match((await say('a'.repeat(81)))[0], /Me diz seu \*nome\*/);
  assert.match((await say('💛'))[0], /Me diz seu \*nome\*/);
  assert.match((await say('Ana'))[0], /Confirmar/);
});

test('erro ao gravar o pedido avisa o cliente', async () => {
  const { say } = setup({ failOrder: true });
  await say('quero 2 brigadeiros');
  await say('1');
  assert.match((await say('1'))[0], /Ops, algo deu errado/);
});

test('cupom no pedido escrito: desconto no resumo e no pedido', async () => {
  const { say, orders } = setup();
  const [r] = await say('quero 10 brigadeiros cupom volta10');
  assert.match(r, /Cupom \*VOLTA10\* anotado: 10% de desconto/);
  assert.match(r, /Desconto VOLTA10: −R\$ 4,00/);
  assert.match(r, /\*Total: R\$ 36,00\*/);
  await say('1'); // nome do perfil
  const [done] = await say('1');
  assert.match(done, /Total: \*R\$ 36,00\* \(já com R\$ 4,00 de desconto\)/);
  assert.equal(orders[0].coupon, 'VOLTA10');
});

test('"cupom X" sozinho chama o bot e fica guardado para o pedido', async () => {
  const { say, orders } = setup();
  const [r] = await say('Oi! cupom VOLTA10');
  assert.match(r, /anotado/);
  assert.match(r, /Mande \*1\* para encomendar/);
  assert.match((await say('quero 5 casadinhos'))[0], /Desconto VOLTA10: −R\$ 2,00/);
  await say('1');
  await say('1');
  assert.equal(orders[0].coupon, 'VOLTA10');
});

test('só o código, no meio da conversa, também vale', async () => {
  const { say } = setup();
  await say('quero 10 brigadeiros');
  await say('Ana');
  const [r] = await say('VOLTA10');
  assert.match(r, /\*Total: R\$ 36,00\*/);
  assert.match(r, /\*1\* ✅ Confirmar/);
});

test('cupom recusado explica o motivo', async () => {
  for (const [code, msg] of Object.entries({ VELHO1: 'Cupom expirado', NADA99: 'Cupom não encontrado' })) {
    const { say } = setup();
    await say('quero 10 brigadeiros');
    assert.match((await say(`cupom ${code}`))[0], new RegExp(msg));
  }
});

test('pedido mínimo: o cupom fica anotado e entra quando o pedido chega lá', async () => {
  const { say } = setup();
  assert.match((await say('cupom DOCE5'))[0], /R\$ 5,00 de desconto em pedidos a partir de R\$ 30,00/);
  assert.match((await say('quero 5 brigadeiros'))[0], /não aplicado: Vale para pedidos a partir de R\$ 30,00/);
  await say('Ana');
  await say('2'); // adicionar mais itens
  await say('1'); // brigadeiro
  await say('5');
  await say('0'); // finalizar
  const [r] = await say('1'); // nome do perfil
  assert.match(r, /Desconto DOCE5: −R\$ 5,00/);
  assert.match(r, /\*Total: R\$ 35,00\*/);
});

test('cupom esgotou antes de confirmar: avisa e oferece seguir sem ele', async () => {
  const { say, used, orders } = setup();
  await say('quero 10 brigadeiros cupom FIM1');
  await say('1');
  used.set('FIM1', new Set(['outra-pessoa'])); // alguém usou a última unidade
  const [r] = await say('1');
  assert.match(r, /Cupom esgotado, então tirei o cupom/);
  assert.match(r, /\*Total: R\$ 40,00\*/);
  assert.equal(orders.length, 0);
  await say('1');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].coupon, undefined);
});

test('"parar promoções" tira das campanhas e das novidades', async () => {
  const { say, subs } = setup({ subscribed: [ANA] });
  assert.match((await say('parar promoções'))[0], /não vou mais enviar novidades nem promoções/);
  assert.ok(!subs.has(ANA));
  assert.deepEqual(await setup().say('parar promoções'), [], 'quem não recebia nada fica sem resposta (pode ser conversa)');
});
