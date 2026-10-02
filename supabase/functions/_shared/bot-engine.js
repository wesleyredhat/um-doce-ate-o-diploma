// Motor de conversa do bot de encomendas.
// JavaScript puro, sem dependências: roda no navegador (simulador do painel)
// e no Deno (Edge Function que recebe o webhook do WhatsApp Cloud API).
//
// handleMessage(msg, ctx) -> Promise<string[]>  (respostas a enviar, em ordem)
//   msg: { phone, text, profileName, isGroup }
//   ctx: adaptador de dados (ver README / whatsapp-bot/index.ts)

const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const singular = (w) => w.replace(/(oes|aes)$/, 'ao').replace(/s$/, '');

const NUM_WORDS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  doze: 12, quinze: 15, vinte: 20, trinta: 30, cinquenta: 50, cem: 100, duzia: 12 };

export function matchProduct(fragment, products) {
  const words = norm(fragment).split(/[^a-z0-9]+/).filter((w) => w.length > 2).map(singular);
  if (!words.length) return null;
  let best = null;
  let bestScore = 0;
  for (const p of products) {
    const pw = norm(p.name).split(/[^a-z0-9]+/).map(singular);
    const score = words.filter((w) => pw.some((x) => x.startsWith(w) || w.startsWith(x))).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

// "quero 10 brigadeiros e 2 empadinhas" -> [{product, qty}]
export function parseQuickOrder(text, products) {
  const t = norm(text).replace(/\b(uma? )?duzias? de\b/g, '12 ');
  const re = /(\d{1,3}|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|doze|quinze|vinte|trinta|cinquenta|cem)\s*(?:x\s*)?([a-z][a-z ]*?)(?=\s*(?:,|\be\b|\+|;|$|\d))/g;
  const out = [];
  for (const m of t.matchAll(re)) {
    const qty = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORDS[m[1]];
    const p = matchProduct(m[2], products);
    if (p && qty > 0) {
      const found = out.find((x) => x.product.id === p.id);
      if (found) found.qty += qty;
      else out.push({ product: p, qty });
    }
  }
  return out;
}

const cartText = (cart) => cart.map((it) => `• ${it.qty}x ${it.name} — ${brl(it.qty * it.price)}`).join('\n');
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
  products.forEach((p, i) => (groups[p.category] ||= []).push(`*${i + 1}* ${p.name} — ${brl(p.price)}`));
  return Object.entries(groups)
    .map(([cat, lines]) => `*${cat === 'salgados' ? '🥧 Salgados' : '🍫 Doces'}*\n${lines.join('\n')}`)
    .join('\n\n');
}

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
      return [`✨ Novidade publicada no site${r?.sent ? ` e enviada para ${r.sent} cliente(s)` : ''}!\n\n*${news.title}*\n${news.body || ''}`];
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
      return [`Comandos de administradora:\n*#novidade Título | texto* — publica no site e envia aos inscritos\n*#pedidos* — pedidos em aberto\n*#producao* — o que produzir agora`];
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

  if (['menu', 'oi', 'ola', 'oie', 'bom dia', 'boa tarde', 'boa noite', 'inicio', 'voltar'].includes(t)) {
    await save({ state: 'menu', cart: s.cart || [] });
    return [menuText(settings, msg.profileName)];
  }
  if (['cancelar', 'sair', 'parar'].includes(t)) {
    await save(null);
    return ['Tudo bem, cancelei por aqui. Quando bater a vontade, é só mandar *oi* 💛'];
  }
  if (s.state === 'human') return []; // atendimento humano em andamento

  if (settings.accepting === false && ['menu', 'product', 'qty'].includes(s.state) && (t === '1' || /\d/.test(t))) {
    return [`No momento estamos com a agenda cheia 🥲 ${settings.notice || ''}\nMande *3* para ver as novidades.`];
  }

  // Atalho: pedido em linguagem natural ("quero 10 brigadeiros e 2 empadinhas") — também em grupos com #pedido
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
      if (t === '1') {
        await save({ ...s, state: 'product' });
        return [`O que vai ser? Mande o *número* do produto:\n\n${catalogText(products)}`];
      }
      if (t === '2') {
        return [`📋 *Cardápio*\n\n${products.map((p) => `*${p.name}* — ${brl(p.price)}\n_${p.description || ''}_`).join('\n\n')}\n\nMande *1* para encomendar.`];
      }
      if (t === '3') {
        const news = (await ctx.listNews()).slice(0, 3);
        if (!news.length) return ['Ainda não temos novidades, mas vem coisa boa por aí 👀'];
        return [news.map((n) => `✨ *${n.title}*\n${n.body}`).join('\n\n') + '\n\nMande *1* para encomendar.'];
      }
      if (t === '4') {
        await ctx.subscribe(phone, msg.profileName, true);
        return ['Pronto! 🔔 Você vai receber nossas novidades por aqui. Para sair, mande *parar novidades*.'];
      }
      if (t === 'parar novidades') {
        await ctx.subscribe(phone, msg.profileName, false);
        return ['Ok, não vou mais enviar novidades. 💛'];
      }
      if (t === '5') {
        await save({ ...s, state: 'human' });
        await ctx.notifyHuman?.(phone, msg.profileName);
        return ['Chamei a Cris! Ela responde assim que sair do forno 👩‍🍳 (para voltar ao menu, mande *menu*)'];
      }
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
      return [`*${p.name}* — ${brl(p.price)} cada.\nQuantas unidades?`];
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
      const name = t === '1' && msg.profileName ? msg.profileName : text;
      if (name.length < 2 || /^\d+$/.test(name)) return ['Me diz seu *nome*, por favor 🙂'];
      const next = { ...s, state: 'confirm', name };
      await save(next);
      return [confirmText(next)];
    }

    case 'confirm': {
      if (t === '1' || t === 'sim' || t === 'confirmar') {
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
      await save({ state: 'menu', cart: [] });
      return [menuText(settings, msg.profileName)];
  }
}
