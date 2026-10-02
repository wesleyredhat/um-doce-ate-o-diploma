// npm test: confere quando o bot responde e quando fica quieto (número de uso pessoal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, SESSION_TTL_MS, PAUSE_TTL_MS } from './core.js';
import { detectIntent, parseQuickOrder, samePhone } from '../supabase/functions/_shared/bot-engine.js';

const PRODUCTS = [
  { id: 'p1', name: 'Brigadeiro', category: 'doces', price: 4, cost: 1.35, active: true },
  { id: 'p2', name: 'Casadinho', category: 'doces', price: 4, cost: 1.5, active: true },
  { id: 'p3', name: 'Caixinha 4 docinhos', category: 'doces', price: 15, cost: 5.9, active: true },
  { id: 'p4', name: 'Morango Cravejado', category: 'doces', price: 12, cost: 4.6, active: true },
  { id: 'p5', name: 'Empadinha de Frango com Catupiry', category: 'salgados', price: 8, cost: 3.1, active: true },
];
const ANA = '5511988887777';
const CRIS = '5511941776869';

function setup({ admins = [], failOrder = false, subscribed = [] } = {}) {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const rows = new Map();
  const orders = [];
  const subs = new Set(subscribed);
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
    // igual ao bot: ao sair, diz se a pessoa estava inscrita
    subscribe: async (phone, _name, on) => (on ? void subs.add(phone) : subs.delete(phone)),
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
    // frases que a revisão mostrou que disparavam o bot
    'Compra 2 caixinhas de creme de leite pra mim?', 'Comprei 4 caixinhas de leite condensado', 'Quanto deu a caixinha do churrasco?',
    'Quanto tá o morango na feira?', 'Comi 2 brigadeiros da festa, tava divino!', 'sobrou 10 brigadeiros da festa',
    'Quanto tempo de Uber até a Brigadeiro?', 'comprei 6 empadinhas na padaria', 'Qual o cardápio do jantar hoje?',
    'Preciso fazer um pedido no mercado, quer algo?', 'Quero fazer um pedido de pizza hoje', 'queria encomendar as flores do casamento',
    'O menu do almoço de domingo vai ser lasanha', 'Amiga, todo mundo amou o brigadeiro. Quero te ver logo!',
    'Assim que eu receber novidades do médico te aviso', 'Te amo, beijo', 'parar de receber novidades',
    // segunda revisão: comentário que começa com quantidade, "nenhum", avenida, receita, outras lojas
    '10 brigadeiros por 50 reais na padaria 😱', '6 empadinhas por 30 reais?? absurdo', '3 brigadeiros e já tô passando mal kkkk',
    '2 casadinhos sobraram, quer que eu guarde?', '1 brigadeiro e meio já me deixa enjoada', 'Não quero nenhum brigadeiro, tô de dieta 😅',
    'Preciso de algum brigadeiro pra sobreviver a essa semana', 'Queria tanto um brigadeiro agora', 'Quanto custa um brigadeiro no Starbucks? Vi 12 reais',
    'Preciso ir na Brigadeiro amanhã cedo, consulta no Hospital Alemão', 'O uber até a Brigadeiro fica quanto?', 'Aluguel na Brigadeiro tá quanto hoje em dia?',
    'Faria Lima com Brigadeiro, chego em 10 min', 'Preciso de um Uber pra Brigadeiro agora', 'Como faz brigadeiro de colher? O meu sempre empedra',
    'Tem como fazer brigadeiro sem leite condensado? Minha filha é intolerante', 'Brigadeiro fica quanto tempo fora da geladeira?',
    'Quero a receita do brigadeiro, por favor!', 'Vou pedir brigadeiro no iFood pra sobremesa', 'Quero fazer um pedido pra sexta no Habib\'s, topa?',
    'Gostaria de fazer uma encomenda pro dia das crianças na Ri Happy, sabe?', 'Preciso comprar uma caixinha de 4 pilhas pro controle da TV',
    'Para de me mandar novidades da novela, eu não assisti ainda kkkk', 'Me liga quando sair daqui, quero saber as novidades',
    'Chega de novidades ruins por hoje 😭', 'Qual o cardápio hoje?', 'Preciso de brigadeiro urgente, dia horrível no trabalho 😭',
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
    'meia dúzia de brigadeiros': 'order', 'preciso de 50 casadinhos pra sexta': 'order', 'quanto é o cento de brigadeiro?': 'order',
    '10 brigadeiros de pistache pra sábado': 'order', 'manda o cardápio': 'keyword', 'pode me mandar o cardápio?': 'keyword',
    'oi tudo bem': null, 'comprei 3 caixas de leite': null, 'faz 1 frango assado': null, 'quero uma caixinha de leite': null,
    'quero uma caixinha': 'order', 'Me vê 2 caixinhas': 'order', 'Quero 20 empadas': 'order',
    // formas comuns de cliente que a segunda revisão mostrou sem resposta
    'Vocês têm cardápio?': 'keyword', 'Poderia me enviar o cardápio, por gentileza?': 'keyword', 'Oi! Tem o cardápio com os preços?': 'keyword',
    'Vc faz encomenda?': 'order', 'Aceita encomenda pra essa semana?': 'order', 'Oi! Vi no Instagram, vocês fazem encomenda?': 'order',
    'Como faço o pedido?': 'order', 'Ainda dá tempo de encomendar pra sábado?': 'order', 'Quero fazer uma encomenda pro aniversário da minha filha': 'order',
    'Oi, gostaria de um orçamento para 200 brigadeiros': 'order', 'Bom dia! Vocês fazem casadinho?': 'order', 'Quanto é o cento do brigadeiro?': 'order',
    'Qto custa o brigadeiro': 'order', 'Quanto você cobra pelo cento de brigadeiro?': 'order', 'Preço?': 'order', 'Brigadeiro quanto?': 'order',
    'kero 50 brigadeiros': 'order', 'oi qero encomenda': 'order',
    'Uma amiga do trabalho perguntou se você faz brigadeiro pra fora, passei seu número': null, 'Quero um orçamento da reforma do banheiro': null,
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
  await say('1');
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

test('segunda revisão: nada vira opção do menu, nome ou confirmação por acaso', async () => {
  const a = setup();
  await a.say('menu');
  assert.deepEqual(await a.say('Topo! Umas 4?'), [], '"umas 4" não é a opção 4');
  assert.equal(a.subs.size, 0);
  assert.deepEqual(await a.say('chego em 5 min'), [], '"5 min" não é a opção 5');
  assert.match((await a.say('me manda o menu'))[0], /Fazer encomenda/, 'pedido explícito de menu sempre responde');
  const b = setup();
  await b.say('quero 2 brigadeiros');
  assert.match((await b.say('Que pedido?? kkkk'))[0], /Me diz seu \*nome\*/);
  await b.say('Ana');
  assert.match((await b.say('sim'))[0], /Confirmar/, '"sim" solto não confirma');
  assert.equal(b.orders.length, 0);
  assert.match((await b.say('1'))[0], /Pedido \*DD-TEST\* recebido/);
});

test('segunda revisão: leitura dos itens', () => {
  const read = (t) => parseQuickOrder(t, PRODUCTS).map((x) => `${x.qty}x ${x.product.id}`).join(' ');
  assert.equal(read('1 caixinha de 4 docinhos'), '1x p3', 'o 4 do nome não é quantidade');
  assert.equal(read('duas dúzias de casadinho'), '24x p2');
  assert.equal(read('quero 10 brigadeiros 😋'), '10x p1');
  assert.equal(read('uma empadinha e 10 brigadeiros'), '1x p5 10x p1');
  assert.equal(read('10 de brigadeiro e 10 de casadinho'), '10x p1 10x p2');
  assert.equal(read('Não quero nenhum brigadeiro'), '', '"nenhum" não é "um"');
  assert.equal(read('Quanto custa um deles?'), '', '"deles" não é Empadinha de Frango');
});
