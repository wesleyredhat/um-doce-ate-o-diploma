// Motor de conversa do bot de encomendas.
// JavaScript puro, sem dependências: roda no navegador (simulador do painel)
// e no Deno (Edge Function que recebe o webhook do WhatsApp Cloud API).
//
// handleMessage(msg, ctx) -> Promise<string[]>  (respostas a enviar, em ordem)
//   msg: { phone, text, profileName, isGroup }
//   ctx: adaptador de dados (ver README / whatsapp-bot/index.ts; findOrder é opcional)

const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const singular = (w) => w.replace(/(oes|aes)$/, 'ao').replace(/s$/, '');

const NUM_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  doze: 12, quinze: 15, vinte: 20, trinta: 30, cinquenta: 50, cem: 100, duzia: 12 };
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'e', 'a', 'o']);

export function matchProduct(fragment, products) {
  const words = norm(fragment).split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(singular);
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    // só palavras de verdade do nome: "deles" não casa com o "de" de "Empadinha de Frango"
    const pw = norm(p.name).split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOP.has(x)).map(singular);
    const score = words.filter((w) => pw.some((x) => x.startsWith(w) || w.startsWith(x))).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

// "meia dúzia de", "duas dúzias de", "um cento de"… viram número antes de ler o pedido
const amounts = (t) => t.replace(/\b(?:(meia|meio|uma|um|duas|dois|tres|quatro|cinco|seis|\d{1,2})\s+)?(duzias?|centos?) (?:de|do|da|dos|das)\b/g, (_, n, unit) => {
  const k = !n ? 1 : n === 'meia' || n === 'meio' ? 0.5 : /^\d+$/.test(n) ? Number(n) : NUM_WORDS[n];
  return `${Math.round((unit.startsWith('duzia') ? 12 : 100) * k)} `;
});

const QTY = '\\d{1,3}|uma|um|duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|cinquenta|cem';
// "quero 10 brigadeiros e 2 empadinhas." -> [{product, qty}]
// A primeira palavra depois da quantidade precisa ser de um produto ("uma encomenda de brigadeiros" não é 1 brigadeiro),
// "nenhum" não é "um", e o número do nome não é quantidade ("1 caixinha de 4 docinhos" é 1 caixinha).
export function parseQuickOrder(text, products) {
  let t = amounts(norm(text));
  for (const x of productPatterns(products).parts) if (x.inner) t = t.replace(x.inner, '$1');
  const re = new RegExp(`\\b(${QTY})(?:\\s*x\\b|\\b)\\s*(?:de\\s+)?([a-z][a-z ]*?)(?=\\s*(?:,|\\be\\b|\\+|;|$|\\d|[^a-z\\s]))`, 'g');
  const out = [];
  for (const m of t.matchAll(re)) {
    const qty = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1]];
    const p = matchProduct(m[2].trim().split(/\s+/)[0], products) && matchProduct(m[2], products);
    if (p && qty > 0) {
      const found = out.find((x) => x.product.id === p.id);
      if (found) found.qty += qty;
      else out.push({ product: p, qty });
    }
  }
  return out;
}

// Número de uso pessoal: o bot só entra na conversa quando a mensagem é claramente sobre encomenda.
//   'keyword'     → "menu", "cardápio", "#pedido" (também chamam o bot de volta depois de uma pausa)
//   'unsubscribe' → pedido para sair das novidades (funciona sempre)
//   'subscribe'   → botão "Quero receber as novidades" do site
//   'site'        → outras mensagens prontas do site ("Vim pelo site…", "Acabei de fazer o pedido DD-XXXX")
//   'order'       → pedido escrito: verbo de compra junto do produto, lista de itens ou pergunta curta de preço
//   null          → conversa pessoal: o bot fica em silêncio
// Primeira palavra do nome comum demais no dia a dia: só vale junto de outra palavra do nome
// ("caixinha de docinhos", "morango cravejado"; "caixinha de leite" e "morango na feira" não).
const GENERIC = new Set(['caixinha', 'caixa', 'kit', 'combo', 'pote', 'copo', 'fatia', 'mini', 'morango', 'uva', 'coco', 'leite', 'chocolate', 'bolo', 'torta']);
const stem = (w) => w.slice(0, Math.max(4, w.length - 1)).replace(/[^a-z0-9]/g, '');
const wordRe = (w) => (/^\d+$/.test(w) ? w : `${stem(singular(w))}[a-z]*`);
// "empadinha" também casa com "empada", "empadas"
const headRe = (w) => (/inha$/.test(singular(w)) ? `(?:${wordRe(w)}|${singular(w).replace(/inha$/, '')}(?:a|as|ao|oes)\\b)` : wordRe(w));
const END = '(?=(?: (?:por favor|pf|pfv|pfvr|pra [a-z0-9]+|para [a-z0-9]+))*$)';
const productRe = new WeakMap();
function productPatterns(products) {
  if (productRe.has(products)) return productRe.get(products);
  const parts = products.map((p) => {
    const tokens = norm(p.name).split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
    if (!tokens.length || (!/^\d+$/.test(tokens[0]) && tokens[0].length < 4)) return null;
    // "na Brigadeiro", "até a Brigadeiro" é a avenida; o doce é "o brigadeiro"
    const head = `${/o$/.test(singular(tokens[0])) ? '(?<!\\b(?:a|na|da|pela|numa|duma)\\s)' : ''}${headRe(tokens[0])}`;
    const rest = tokens.slice(1).filter((w) => !/^\d+$/.test(w));
    const others = rest.length ? rest : tokens.slice(1);
    const src = !GENERIC.has(singular(tokens[0])) || !others.length ? head
      : `(?:${head}(?:\\s+[a-z0-9]+){0,2}?\\s+(?:${others.map(wordRe).join('|')})|${head}${END})`;
    const n = tokens.findIndex((w, i) => i > 0 && /^\d+$/.test(w));
    const inner = n > 0 && tokens[n + 1] ? new RegExp(`\\b(${wordRe(tokens[0])})(?:\\s+(?:de|com))?\\s+${tokens[n]}\\s+${wordRe(tokens[n + 1])}`, 'g') : null;
    return { p, src, re: new RegExp(`\\b${src}\\b`), inner };
  }).filter(Boolean);
  const out = { parts, src: parts.length ? `(?:${parts.map((x) => x.src).join('|')})\\b` : '(?!)' };
  productRe.set(products, out);
  return out;
}
const productPattern = (products) => productPatterns(products).src;
const clean = (t) => amounts(t.replace(/[^a-z0-9#]+/g, ' ').trim()); // sem pontuação nem emoji
// Produto citado na mensagem com a mesma regra da identificação ("caixinha de leite" não conta).
const mentionedProduct = (text, products) => productPatterns(products).parts.find((x) => x.re.test(clean(norm(text))))?.p || null;

const GREETING = /^(?:(?:oi+e?|ola|opa|bom dia|boa tarde|boa noite|e ai|eai|hey|tudo bem|td bem|tudo bom|cris|moca|amiga|gente)\b\s*)+/;
const LAUGH = /\b(?:k{3,}|kk+[a-z]*k|(?:ha){2,}h?|(?:he){2,}|(?:rs)+)\b/;
const NEG = /\b(?:nao (?:quero|queria|preciso|vou|gosto)|nenhum|nenhuma)\b/;
const TAIL = '(?: (?:por favor|pf|pfv|pfvr|por gentileza|com voces?|com vcs?|ai|aqui))*';
const WHEN = '(?: (?:pra|para|pro) (?:o |a )?(?:dia \\d{1,2}|hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana que vem|proxima semana|essa semana|esse mes|festa|aniversario|formatura|evento|cha|janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: [a-z0-9]+){0,3})?';
const KW_LEAD = '(?:ver|abre|abrir|mostra|mostrar|manda|mande|envia|envie|passa|passe|me (?:manda|mande|envia|envie|passa|passe|mostra)|pode (?:me )?(?:mandar|enviar|passar|mostrar)|poderia (?:me )?(?:mandar|enviar|passar|mostrar)|qual(?: e)?|quero ver|queria ver|gostaria de ver|tem|(?:voces|vcs|vc|voce) tem)';
const KW_TAIL = '(?: (?:por favor|pf|pfv|pfvr|por gentileza|ai|aqui|completo|de voces|da loja|dos doces|de doces|com os precos|com precos))*';
const KEYWORD = new RegExp(`^(?:#(?:pedido|cardapio|menu)\\b.*|(?:${KW_LEAD}(?: o)? |o )?(?:menu|cardapio)${KW_TAIL})$`);
export const UNSUBSCRIBE = /^(?:(?:quero|queria|pode|por favor|pfv?)\s+)?(?:me\s+)?(?:parar|pare|para|sair|cancelar|cancela|descadastrar|descadastra|remover|remove|tirar|tira|nao quero mais|nao desejo mais)(?:\s+de)?(?:\s+(?:receber|mandar|me mandar|enviar|me enviar))?(?:\s+(?:as|das|dessas|essas|suas))?\s+novidades(?:\s+(?:por favor|pf|pfv|aqui|daqui|de voces))?$/;
const SUBSCRIBE = /^(?:quero|queria|gostaria de) receber (?:as )?novidades(?: (?:por aqui|aqui|de voces))?$/;
const QTYW = '(?:\\d{1,3}|uma|um|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|cinquenta|cem)';
const FILL = '(?:o|a|os|as|um|uma|uns|umas|mais|de|do|da|dos|das|pelo|pela|em|x|\\d{1,3}x?|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|cinquenta|cem)';
const QUERO = '(?:quero|queria|kero|qro|qero|qria|keria|qeria)';
const BUY = `(?:${QUERO}|gostaria(?: de)?|vou querer|me ve|me separa|me reserva|separa|reserva|encomendar|encomendo|pode (?:separar|reservar|fazer|me ver))`;
const ASK_PRICE = '(?:(?:quanto|qto|qnto|qt)(?: que)? (?:custa|custam|e|sai|saem|fica|ficam|ta|esta|cobra|cobram|seria|ta saindo|esta saindo)|quanto (?:voce|vc|voces|vcs) (?:cobra|cobram|cobraria|cobrariam)|qual (?:e )?o (?:valor|preco)|valor|preco|precos)';
const WANT = `(?:${QUERO}|gostaria de|preciso|posso|como (?:eu )?faco (?:para|pra))`;
const ENC = '(?:fazer (?:um |uma |1 )?(?:pedido|encomenda)s?|encomendar|pedir|(?:uma |1 )?encomendas?)';
// pedido com quantidade: "tem como fazer 50 brigadeiros?", "preciso de 30 casadinhos" ("preciso de brigadeiro urgente" não)
const ASK_QTY = '(?:preciso de|precisaria de|vou precisar de|tem como fazer|da pra fazer|consegue fazer|conseguem fazer|voces fazem|vcs fazem|voce faz|vc faz)';
const DOCES = '(?:doces?|docinhos?|salgados?)';
const PRICE_Q = /\b(?:quanto|qto|qnto|valor|valores|preco|precos)\b/;

export function detectIntent(text, products) {
  const t = norm(text);
  const c = clean(t);
  const body = c.replace(GREETING, '').trim(); // sem "oi, tudo bem?" no começo
  if (UNSUBSCRIBE.test(body)) return 'unsubscribe';
  if (/^#pedido\b/.test(body) && LAUGH.test(c)) return null; // "#pedido de desculpas kkk"
  if (KEYWORD.test(body)) return 'keyword';
  if (SUBSCRIBE.test(body)) return 'subscribe';
  if (/\bvim pelo site\b.*\bencomenda\b/.test(c) || /\bpedido\b.*\bdd-[a-z0-9]{4}\b/.test(t)) return 'site';
  // risada, "não quero", textão: é conversa, não encomenda
  const words = body ? body.split(' ').length : 0;
  if (LAUGH.test(c) || NEG.test(c) || words > 22) return null;
  const P = productPattern(products);
  const ITEM = `${QTYW}\\s*(?:x\\s*)?(?:de\\s+)?${P}(?:\\s+de\\s+[a-z]+)?`;
  const order = [
    // "quero fazer uma encomenda (pra sábado)"; "um pedido pra sexta no Habib's" não
    new RegExp(`^${WANT} ${ENC}${TAIL}${WHEN}$`),
    new RegExp(`^${WANT} ${ENC} (?:de |d |com )?(?:${FILL}\\s+){0,2}(?:${DOCES}|${P})`),
    // "vocês fazem encomenda?", "aceita encomenda pra essa semana?", "vi no Instagram, vocês fazem encomenda?"
    new RegExp(`(?:^|\\b(?:voces|vcs|vc|voce) )(?:ainda )?(?:faz|fazem|aceita|aceitam|pega|pegam|trabalha com|trabalham com|esta aceitando|estao aceitando|ta aceitando|tao aceitando) (?:encomendas?|pedidos?)${TAIL}${WHEN}$`),
    new RegExp(`^(?:ainda )?(?:da|tem) tempo de (?:encomendar|pedir|fazer (?:a |uma )?encomenda)${TAIL}${WHEN}$`),
    new RegExp(`^como (?:eu )?(?:faco|faz|funciona)(?: para| pra)? (?:o |a |um |uma )?(?:pedidos?|encomendas?|encomendar|pedir)${TAIL}$`),
    // orçamento: "gostaria de um orçamento para 200 brigadeiros"; "um orçamento da reforma" não
    new RegExp(`^(?:${WANT}|gostaria|pode me passar|me passa) (?:de )?(?:um |o |uma )?orcamento(?:${TAIL}$|(?: [a-z0-9]+){0,3}? (?:${DOCES}|${P}))`),
    // verbo de compra com no máximo artigo ou quantidade antes do produto: "quero 10 brigadeiros", "me vê 3 empadinhas"
    new RegExp(`\\b${BUY}(?:\\s+${FILL}){0,3}\\s+${P}`),
    new RegExp(`\\b${ASK_QTY}\\s+${QTYW}\\s*(?:x\\s*)?(?:de\\s+)?${P}`),
    // a mensagem inteira é a lista: "10 brigadeiros e 2 empadinhas (pra sábado)"; "10 brigadeiros por 50 reais" não
    new RegExp(`^${ITEM}(?:\\s*(?:e|mais)?\\s*${ITEM})*${TAIL}${WHEN}$`),
  ];
  if (order.some((re) => re.test(body))) return 'order';
  // pergunta curta: "vocês fazem casadinho?", "vcs têm brigadeiro de ninho?"
  if (words <= 10 && new RegExp(`\\b(?:voces|vcs|vc|voce) (?:fazem|faz|tem|vendem|vende)(?: [a-z]+)? ${P}`).test(body)) return 'order';
  // pergunta curta de preço: "quanto custa o brigadeiro?", "brigadeiro custa quanto?"
  if (words <= 8 && (new RegExp(`\\b${ASK_PRICE}(?:\\s+${FILL}){0,3}\\s+${P}`).test(body)
    || new RegExp(`^(?:${FILL}\\s+)?${P}(?:\\s+[a-z]+)?\\s+(?:custa|custam|sai|saem|fica|ficam|e|ta|esta) quanto(?: (?:cada|a unidade|o cento))?$`).test(body)
    || new RegExp(`^${P} quanto(?: (?:custa|e|cada))?$`).test(body)
    // "preço?", "qual o valor do cento?", "me passa os valores por favor"
    || /^(?:(?:me passa|me manda|pode me passar|gostaria de saber|queria saber|quero saber|qual|quais) )?(?:o |os |a |as )?(?:valor|valores|preco|precos)(?: (?:do cento|da duzia|dos doces|dos docinhos|dos salgados|de voces|por favor|pf))*$/.test(body))) return 'order';
  return null;
}

// "obrigada", "ok", "valeu 👍", "ok, obrigada 😘": agradecimento solto não repete o menu
const ACK_WORDS = new Set(['obrigado', 'obrigada', 'obrigados', 'obrigadas', 'brigado', 'brigada', 'valeu', 'vlw', 'ok', 'okay', 'beleza', 'blz',
  'show', 'top', 'perfeito', 'otimo', 'joia', 'massa', 'certo', 'combinado', 'amei', 'de', 'bola', 'nada', 'tmj', 'muito', 'mto', 'mt', 'ta', 'bom', 'entendi', 'cris']);
const isAck = (t) => { const w = clean(t).split(' ').filter(Boolean); return w.length <= 4 && w.every((x) => ACK_WORDS.has(x)); };

// O WhatsApp às vezes guarda celulares antigos sem o 9 (55 11 8888-7777); o site sempre grava com o 9.
// Só celular (8 dígitos começando com 6 a 9) ganha o 9: fixo e número estrangeiro ficam como estão.
const brKey = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (!/^55\d{10,11}$/.test(d)) return d;
  const n = d.slice(2);
  return n.length === 10 && /[6-9]/.test(n[2]) ? `55${n.slice(0, 2)}9${n.slice(2)}` : d;
};
export const samePhone = (a, b) => !!a && !!b && brKey(a) === brKey(b);

const cartText = (cart) => cart.map((it) => `• ${it.qty}x ${it.name}: ${brl(it.qty * it.price)}`).join('\n');
const cartTotal = (cart) => cart.reduce((s, it) => s + it.qty * it.price, 0);

function menuText(settings, name) {
  const hi = settings.bot_greeting || 'Oi! 🎓🍫';
  return `${hi}${name ? `\nQue bom te ver, *${name.split(' ')[0]}*!` : ''}

Como posso adoçar seu dia?
*1* 🛍️ Fazer encomenda
*2* 📋 Ver cardápio
*3* ✨ Novidades
*4* 🔔 Receber novidades por aqui
*5* 💬 Falar com a gente

_Dica: pode mandar direto, tipo "quero 10 brigadeiros e 2 empadinhas"._`;
}

function catalogText(products) {
  const groups = {};
  products.forEach((p, i) => (groups[p.category] ||= []).push(`*${i + 1}* ${p.name}: ${brl(p.price)}`));
  return Object.entries(groups)
    .map(([cat, lines]) => `*${cat === 'salgados' ? '🥧 Salgados' : '🍫 Doces'}*\n${lines.join('\n')}`)
    .join('\n\n');
}

const cardapioText = (products) =>
  `📋 *Cardápio*\n\n${products.map((p) => `*${p.name}*: ${brl(p.price)}\n_${p.description || ''}_`).join('\n\n')}\n\nMande *1* para encomendar.`;

function addToCart(cart, product, qty) {
  const it = cart.find((x) => x.product_id === product.id);
  if (it) it.qty += qty;
  else cart.push({ product_id: product.id, name: product.name, price: Number(product.price), qty });
}

function confirmText(s) {
  return `Seu pedido até aqui:\n${cartText(s.cart)}\n*Total: ${brl(cartTotal(s.cart))}*\n\n*1* ✅ Confirmar\n*2* ➕ Adicionar mais itens\n*3* ❌ Cancelar`;
}

async function adminCommand(text, admin, ctx) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = text.trim().slice(cmd.length).trim();
  switch (norm(cmd)) {
    case '#novidade': {
      if (!admin.can_post) return ['Você não tem permissão para postar novidades. Peça para a administradora liberar no painel.'];
      if (!arg) return ['Use: *#novidade Título | texto da novidade*'];
      const [title, ...body] = arg.split('|');
      const news = await ctx.createNews({ title: title.trim(), body: body.join('|').trim(), author: admin.name, channels: ['site', 'whatsapp'] });
      const r = await ctx.broadcast(news);
      const wa = r?.sent ? ` e enviada para ${r.sent} cliente(s)` : r?.queued ? ' e os inscritos recebem pelo WhatsApp em instantes' : '';
      return [`✨ Novidade publicada no site${wa}!\n\n*${news.title}*\n${news.body || ''}`];
    }
    case '#pedidos': {
      if (!admin.can_manage_orders) return ['Sem permissão para ver pedidos.'];
      const open = await ctx.listOpenOrders();
      if (!open.length) return ['Nenhum pedido em aberto. Hora do café ☕'];
      return [`📦 *${open.length} pedido(s) em aberto*\n\n` + open.slice(0, 15).map((o) =>
        `*${o.code}* · ${o.customer_name} · ${o.status}\n${o.items.map((i) => `  ${i.qty}x ${i.name}`).join('\n')}`).join('\n\n')];
    }
    case '#producao': {
      if (!admin.can_manage_orders) return ['Sem permissão para ver pedidos.'];
      const open = await ctx.listOpenOrders();
      const sum = {};
      open.filter((o) => o.status !== 'pronto').forEach((o) => o.items.forEach((i) => (sum[i.name] = (sum[i.name] || 0) + i.qty)));
      const lines = Object.entries(sum).sort((a, b) => b[1] - a[1]).map(([n, q]) => `• ${q}x ${n}`);
      return [lines.length ? `👩‍🍳 *Para produzir*\n${lines.join('\n')}` : 'Nada para produzir agora.'];
    }
    default:
      return [`Comandos de administradora:\n*#novidade Título | texto*: publica no site e envia aos inscritos\n*#pedidos*: pedidos em aberto\n*#producao*: o que produzir agora`];
  }
}

export async function handleMessage(msg, ctx) {
  const text = String(msg.text || '').trim();
  const t = norm(text);
  const phone = msg.phone;

  // Comandos de administradora (só para números autorizados no painel)
  if (text.startsWith('#') && !/^#pedido\b/i.test(text)) {
    const admin = await ctx.isAdmin(phone);
    if (admin) return adminCommand(text, admin, ctx);
    if (msg.isGroup) return [];
  }

  // Em grupos o bot só fala quando chamado com #pedido
  if (msg.isGroup) {
    if (!/^#pedido\b/i.test(text)) return [];
  }

  const settings = (await ctx.getSettings?.()) || {};
  const products = await ctx.listProducts();
  let s = (await ctx.getSession(phone)) || { state: 'menu', cart: [] };
  const save = (next) => ctx.saveSession(phone, next);

  const kind = detectIntent(text, products);
  if (msg.isGroup && kind !== 'keyword') return []; // "#pedido de desculpas kkk" no grupo não é pedido
  // "menu", "me manda o menu", "#pedido" sem itens: sempre mostra o menu; "oi" no meio da conversa não repete
  const greet = ['oi', 'ola', 'oie', 'bom dia', 'boa tarde', 'boa noite', 'inicio', 'voltar'].includes(t);
  const askMenu = kind === 'keyword' && !/\bcardapio\b/.test(t)
    && !(/^#pedido\b/.test(t) && parseQuickOrder(text.replace(/^#pedido/i, ''), products).length);
  if (askMenu || (greet && !s.menuShown)) {
    await save({ state: 'menu', cart: s.cart || [], menuShown: true });
    return [menuText(settings, msg.profileName)];
  }
  if (greet) return [];
  if (kind === 'keyword' && /\bcardapio\b/.test(t)) return [cardapioText(products)];
  if (['cancelar', 'sair', 'parar'].includes(t)) {
    await save(null);
    return ['Tudo bem, cancelei por aqui. Quando bater a vontade, é só mandar *oi* 💛'];
  }
  if (kind === 'unsubscribe') {
    // false = a pessoa nem estava inscrita: fica quieto (pode ser só conversa)
    const was = await ctx.subscribe(phone, msg.profileName, false);
    return was === false ? [] : ['Ok, não vou mais enviar novidades. 💛'];
  }
  if (kind === 'subscribe') {
    await ctx.subscribe(phone, msg.profileName, true);
    return ['Pronto! 🔔 Você vai receber nossas novidades por aqui. Para sair, mande *parar novidades*.'];
  }

  // Mensagem pronta do site depois de pedir ("Acabei de fazer o pedido DD-XXXX"): o pedido já existe,
  // então só confirma; sem isso os itens da mensagem virariam um segundo pedido.
  const code = /\bdd-[a-z0-9]{4}\b/.exec(t)?.[0].toUpperCase();
  if (code) {
    await save(null);
    const o = await ctx.findOrder?.(code);
    if (!o || !samePhone(o.phone, phone)) return [`Recebi sua mensagem sobre o pedido *${code}* 💛 Já vamos conferir e te respondemos por aqui!`];
    const pix = settings.pix_key ? `\n\n💸 Pix: *${settings.pix_key}*` : '';
    return [`🎓 Pedido *${o.code}* recebido! ✅\n${o.items.map((i) => `• ${i.qty}x ${i.name}`).join('\n')}\nTotal: *${brl(o.total)}*${pix}\n\nTe aviso por aqui quando estiver pronto 💛`];
  }
  if (s.state === 'human') return []; // atendimento humano em andamento

  if (settings.accepting === false && ['menu', 'product', 'qty'].includes(s.state) && (t === '1' || /\d/.test(t))) {
    return [`No momento estamos com a agenda cheia 🥲 ${settings.notice || ''}\nMande *3* para ver as novidades.`];
  }

  // Atalho: pedido em linguagem natural ("quero 10 brigadeiros e 2 empadinhas"), também em grupos com #pedido
  const quick = parseQuickOrder(text.replace(/^#pedido/i, ''), products);
  if (quick.length && ['menu', 'product', 'more'].includes(s.state)) {
    const cart = s.cart || [];
    quick.forEach(({ product, qty }) => addToCart(cart, product, qty));
    s = { ...s, cart, state: 'name', fromGroup: !!msg.isGroup || s.fromGroup };
    await save(s);
    const intro = msg.isGroup ? `Anotado, ${msg.profileName || 'pessoal'}! Vou continuar com você no privado 😉\n\n` : '';
    return [`${intro}${confirmText(s).replace(/\n\n\*1\*[\s\S]*$/, '')}\n\nPara quem é o pedido? Mande seu *nome*${msg.profileName ? ` ou *1* para usar "${msg.profileName}"` : ''}.`];
  }

  switch (s.state) {
    case 'menu': {
      // só o número da opção ("1", "opção 1", "ok, quero o 1"); "umas 4?" ou "chego em 5 min" não
      const choice = /^(?:(?:ok|quero|queria|a|o|opcao|numero|n|e|pode ser)\s+){0,3}([1-5])$/.exec(clean(t))?.[1];
      if (choice === '1') {
        await save({ ...s, state: 'product' });
        return [`O que vai ser? Mande o *número* do produto:\n\n${catalogText(products)}`];
      }
      // "brigadeiro", "quanto custa o brigadeiro?": já pergunta a quantidade
      const mp = !choice && mentionedProduct(text, products);
      if (mp) {
        await save({ ...s, state: 'qty', pending: mp.id, menuShown: true });
        return [`*${mp.name}*: ${brl(mp.price)} cada.\nQuantas unidades? Mande só o número, tipo *10* (ou *menu* para ver as opções).`];
      }
      if (choice === '2' || /\bcardapio\b/.test(t) || PRICE_Q.test(t)) return [cardapioText(products)];
      if (choice === '3') {
        const news = (await ctx.listNews()).slice(0, 3);
        if (!news.length) return ['Ainda não temos novidades, mas vem coisa boa por aí 👀'];
        return [news.map((n) => `✨ *${n.title}*\n${n.body}`).join('\n\n') + '\n\nMande *1* para encomendar.'];
      }
      if (choice === '4') {
        await ctx.subscribe(phone, msg.profileName, true);
        return ['Pronto! 🔔 Você vai receber nossas novidades por aqui. Para sair, mande *parar novidades*.'];
      }
      if (choice === '5') {
        await save({ ...s, state: 'human' });
        await ctx.notifyHuman?.(phone, msg.profileName);
        return ['Chamei a Cris! Ela responde assim que sair do forno 👩‍🍳 (para voltar ao menu, mande *menu*)'];
      }
      // menu no máximo uma vez por conversa; agradecimento ou mensagem solta depois disso: silêncio
      if (isAck(t) || s.menuShown) return [];
      await save({ ...s, state: 'menu', cart: s.cart || [], menuShown: true });
      return [menuText(settings, msg.profileName)];
    }

    case 'product':
    case 'more': {
      const n = parseInt(t, 10);
      const p = Number.isInteger(n) ? products[n - 1] : matchProduct(text, products);
      if (s.state === 'more' && t === '0') {
        await save({ ...s, state: 'name' });
        return ['Para quem é o pedido? Mande seu *nome*' + (msg.profileName ? ` ou *1* para usar "${msg.profileName}"` : '') + '.'];
      }
      if (!p) return [`Não achei esse 🤔 Mande o *número* do produto:\n\n${catalogText(products)}`];
      await save({ ...s, state: 'qty', pending: p.id });
      return [`*${p.name}*: ${brl(p.price)} cada.\nQuantas unidades?`];
    }

    case 'qty': {
      const qty = /^\d+$/.test(t) ? parseInt(t, 10) : NUM_WORDS[t];
      const p = products.find((x) => x.id === s.pending);
      if (!p) { await save({ state: 'product', cart: s.cart }); return ['Ops, perdi o produto. Escolha de novo, por favor.']; }
      if (!qty || qty < 1 || qty > 500) return ['Me manda só o número, tipo *6* 🙂'];
      const cart = s.cart || [];
      addToCart(cart, p, qty);
      await save({ state: 'more', cart });
      return [`Anotado: ${qty}x ${p.name} ✅\n\nQuer mais alguma coisa? Mande o *número* de outro produto ou *0* para finalizar.\n\n${catalogText(products)}`];
    }

    case 'name': {
      const name = (t === '1' && msg.profileName ? msg.profileName : text).trim();
      const size = [...name].length; // emoji conta como 1, igual ao banco (nome de 2 a 80 letras)
      // "Que pedido?? kkkk" não é nome: pergunta, risada ou sem nenhuma letra
      if (size < 2 || size > 80 || /^\d+$/.test(name) || name.includes('?') || LAUGH.test(clean(norm(name))) || !/[a-z]/.test(norm(name))) {
        return ['Me diz seu *nome*, por favor 🙂'];
      }
      const next = { ...s, state: 'confirm', name };
      await save(next);
      return [confirmText(next)];
    }

    case 'confirm': {
      // só "1" ou "confirmar": um "sim" solto de conversa não grava pedido
      if (['1', 'confirmar', 'confirmo', 'confirma'].includes(clean(t))) {
        const r = await ctx.placeOrder({
          customer_name: s.name, phone, channel: s.fromGroup ? 'grupo' : 'whatsapp',
          items: s.cart.map((i) => ({ product_id: i.product_id, qty: i.qty })),
        });
        await save(null);
        const pix = settings.pix_key ? `\n\n💸 Pix: *${settings.pix_key}*` : '';
        return [`🎓 Pedido *${r.code}* recebido!\nTotal: *${brl(r.total)}*${pix}\n\nTe aviso por aqui quando estiver pronto. Obrigada, ${s.name.split(' ')[0]}! 💛`];
      }
      if (t === '2') {
        await save({ ...s, state: 'more' });
        return [`Bora! Mande o número do produto:\n\n${catalogText(products)}`];
      }
      if (t === '3') {
        await save(null);
        return ['Pedido cancelado. Quando quiser, é só mandar *oi* 💛'];
      }
      return [confirmText(s)];
    }

    default:
      await save({ state: 'menu', cart: [], menuShown: true });
      return [menuText(settings, msg.profileName)];
  }
}
