// Bot de encomendas no WhatsApp comum (sem API Business): conecta lendo o QR Code,
// como o WhatsApp Web. Usa o mesmo motor de conversa do simulador do painel.
//
//   cp .env.example .env    (preencha a chave secreta do Supabase)
//   npm install && npm start      (ou ./instalar-servico-mac.sh para ficar sempre ligado)
//
// O QR Code aparece no terminal e no painel (aba Bot WhatsApp). Quando o bot responde
// e quando fica quieto está em core.js. A sessão do WhatsApp fica em ./auth.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import makeWASocket, { Browsers, DisconnectReason, isJidGroup, isLidUser, jidNormalizedUser, normalizeMessageContent, useMultiFileAuthState } from 'baileys';
import { createClient } from '@supabase/supabase-js';
import QRCode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import { detectIntent, samePhone } from '../supabase/functions/_shared/bot-engine.js';
import { createCore, PAUSE_TTL_MS } from './core.js';
import { createSender } from './sender.js';
import { phoneKey } from '../assets/js/coupons.js';

process.umask(0o077); // sessão do WhatsApp, log e trava só legíveis pelo próprio usuário

const env = (k, d = '') => process.env[k] ?? d;
for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
  if (!env(k)) { console.error(`Falta ${k} no arquivo .env`); process.exit(1); }
}
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
const SITE_URL = env('SITE_URL');
const OWNER_PHONE = env('OWNER_PHONE').replace(/\D/g, '');
const AUTH_DIR = new URL('./auth', import.meta.url).pathname;
const TICK_MS = 30_000;
const CAMPAIGN_TICK_MS = 5_000; // o ritmo de verdade (20 a 60 s entre mensagens) fica em sender.js
const LOCK = new URL('./bot.pid', import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const toJid = (phone) => `${phone}@s.whatsapp.net`;
const log = (...a) => console.log(new Date().toLocaleString('pt-BR'), ...a);

let sock;
let online = false;
let attempt = 0;
const sentIds = new Set(); // mensagens do próprio bot: não contam como "alguém respondeu pelo celular"
let queue = Promise.resolve();

async function sendText(jid, text) {
  try {
    const m = await sock.sendMessage(jid, { text });
    if (m?.key?.id) {
      sentIds.add(m.key.id);
      if (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value);
    }
    return true;
  } catch (e) {
    console.error('falha ao enviar', jid, e.message);
    return false;
  }
}

// Status lido pela aba "Bot WhatsApp" do painel: online, QR Code para conectar, última vez visto.
let status = {};
async function setStatus(patch = {}) {
  status = { ...status, ...patch, last_seen: new Date().toISOString() };
  const { error } = await db.from('settings').upsert({ key: 'bot', value: status });
  if (error) console.error('erro ao gravar status do bot', error.message);
}

let products = { at: 0, list: [] };
async function listProducts() {
  if (Date.now() - products.at > 60e3) {
    const { data, error } = await db.from('products').select('*').eq('active', true).order('sort');
    if (error) throw new Error(error.message);
    products = { at: Date.now(), list: data ?? [] };
  }
  return products.list;
}

// Envio em massa com pausa aleatória: o WhatsApp comum bloqueia números que disparam rápido demais.
async function broadcast(news) {
  const { data: subs } = await db.from('subscribers').select('phone');
  const text = `✨ *${news.title}*\n${news.body}${SITE_URL ? `\n\nPeça já: ${SITE_URL}` : ''}\n\n_Para sair, responda "parar novidades"._`;
  let sent = 0;
  for (const s of subs ?? []) {
    if (await sendText(toJid(s.phone), text)) sent++;
    await sleep(4000 + Math.random() * 4000);
  }
  log(`novidade "${news.title}" enviada para ${sent} cliente(s)`);
}

const ctx = {
  listProducts,
  getSettings: async () => (await db.from('settings').select('value').eq('key', 'store').maybeSingle()).data?.value ?? {},
  // Compara sem o 9 extra: o painel grava 55 11 9xxxx-xxxx, o WhatsApp às vezes usa o número antigo.
  isAdmin: async (phone) => ((await db.from('bot_admins').select('*')).data ?? []).find((a) => samePhone(a.phone, phone)) || null,
  listNews: async () => (await db.from('news').select('*').eq('published', true).order('created_at', { ascending: false }).limit(3)).data ?? [],
  // "parar novidades/promoções" vale para tudo: sai dos inscritos e entra na lista de quem não quer receber.
  // Devolve false quando a pessoa nem era inscrita nem recebeu campanha: o motor fica quieto (pode ser só conversa).
  subscribe: async (phone, name, on) => {
    const key = phoneKey(phone);
    if (on) {
      await db.from('subscribers').upsert({ phone, name });
      await db.from('optouts').delete().eq('phone_key', key);
      return;
    }
    const { data } = await db.from('subscribers').delete().eq('phone', phone).select('phone');
    const { count } = await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('phone_key', key).eq('status', 'enviada');
    await db.from('optouts').upsert({ phone_key: key, phone });
    return !!data?.length || count > 0;
  },
  checkCoupon: async (code, phone, items) => {
    const { data, error } = await db.rpc('check_coupon', { p_code: code, p_phone: phone, p_items: items });
    if (error) throw new Error(error.message);
    return data;
  },
  placeOrder: async (o) => {
    // Sem cupom, a chamada é a mesma de antes do schema novo (pedido funciona mesmo com o banco desatualizado).
    const { data, error } = await db.rpc('place_order', {
      p_name: o.customer_name, p_phone: o.phone, p_items: o.items, p_channel: o.channel, p_notes: '', ...(o.coupon ? { p_coupon: o.coupon } : {}),
    });
    if (error) throw new Error(error.message);
    return data;
  },
  findOrder: async (code) => (await db.from('orders').select('code, phone, total, items').eq('code', code).maybeSingle()).data,
  // #novidade pelo WhatsApp: só grava; o envio fica com sendPendingNews para não travar as conversas.
  createNews: async (n) => {
    const { data, error } = await db.from('news').insert({ ...n, published: true }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },
  broadcast: async () => ({ queued: true }),
  listOpenOrders: async () =>
    (await db.from('orders').select('*').in('status', ['novo', 'confirmado', 'producao', 'pronto']).order('created_at')).data ?? [],
  notifyHuman: async (phone, name) => {
    if (OWNER_PHONE) await sendText(toJid(OWNER_PHONE), `💬 ${name || 'Cliente'} (+${phone}) pediu atendimento humano no bot.`);
  },
};

const sessions = {
  get: async (phone) => {
    const { data, error } = await db.from('bot_sessions').select('data, updated_at').eq('phone', phone).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  save: async (phone, data) => {
    const { error } = data
      ? await db.from('bot_sessions').upsert({ phone, data, updated_at: new Date().toISOString() })
      : await db.from('bot_sessions').delete().eq('phone', phone);
    if (error) throw new Error(error.message);
  },
};
const core = createCore({ ctx, sessions });

// Fila das campanhas (tabelas campaigns e campaign_sends). Ritmo e regras ficam em sender.js.
const must = ({ data, error, count }) => {
  if (error) throw new Error(error.message);
  return count ?? data;
};
const campaignDb = {
  settings: async () => must(await db.from('settings').select('value').eq('key', 'campaigns').maybeSingle())?.value ?? {},
  requeueStale: async (before) => must(await db.from('campaign_sends').update({ status: 'pendente' }).eq('status', 'enviando').lt('claimed_at', before)),
  sentSince: async (since) => must(await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('status', 'enviada').gte('sent_at', since)) || 0,
  nextCampaign: async () => {
    const c = must(await db.from('campaigns').select('id, name, body, coupons(code)').eq('status', 'enviando').order('created_at').limit(1).maybeSingle());
    return c && { ...c, coupon_code: c.coupons?.code || null };
  },
  // Pega o próximo da fila marcando "enviando" só se ainda estiver pendente.
  claim: async (campaignId, now) => {
    for (let i = 0; i < 3; i++) {
      const next = must(await db.from('campaign_sends').select('id').eq('campaign_id', campaignId).eq('status', 'pendente').order('id').limit(1).maybeSingle());
      if (!next) return null;
      const row = must(await db.from('campaign_sends').update({ status: 'enviando', claimed_at: now }).eq('id', next.id).eq('status', 'pendente').select().maybeSingle());
      if (row) return row;
    }
    return null;
  },
  isOptedOut: async (key) => !!must(await db.from('optouts').select('phone_key').eq('phone_key', key).maybeSingle()),
  mark: async (id, patch) => must(await db.from('campaign_sends').update(patch).eq('id', id)),
  pause: async (id, reason) => must(await db.from('campaigns').update({ status: 'pausada', pause_reason: reason }).eq('id', id)),
  finish: async (id) => {
    const open = must(await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('campaign_id', id).in('status', ['pendente', 'enviando']));
    if (open) return false;
    must(await db.from('campaigns').update({ status: 'concluida', finished_at: new Date().toISOString() }).eq('id', id).eq('status', 'enviando'));
    return true;
  },
};
const sender = createSender({
  db: campaignDb,
  siteUrl: SITE_URL,
  log,
  wa: {
    online: () => online,
    // O WhatsApp devolve o endereço certo (com ou sem o 9); null = número sem WhatsApp.
    lookup: async (phone) => {
      try {
        const [r] = (await sock.onWhatsApp(toJid(phone))) || [];
        return r?.exists ? r.jid : null;
      } catch {
        return toJid(phone);
      }
    },
    send: (jid, text) => sendText(jid, text),
  },
});

// Novidades publicadas com o canal WhatsApp (no painel ou por #novidade) ficam pendentes até o bot enviar.
const NEWS_SQL = 'alter table public.news add column if not exists wa_sent_at timestamptz;';
let checkingNews = false;
let warnedNewsColumn = false;
async function sendPendingNews() {
  if (checkingNews || !online) return;
  checkingNews = true;
  try {
    const since = new Date(Date.now() - 2 * 864e5).toISOString();
    const { data, error } = await db.from('news').select('*')
      .contains('channels', ['whatsapp']).eq('published', true).is('wa_sent_at', null).gte('created_at', since).order('created_at');
    if (error?.code === '42703') {
      if (!warnedNewsColumn) console.error(`⚠️  Para enviar novidades, rode no SQL Editor do Supabase: ${NEWS_SQL}`);
      warnedNewsColumn = true;
      return;
    }
    if (error) throw new Error(error.message);
    for (const n of data ?? []) {
      // Marca antes de enviar (e só se ninguém marcou): se o bot cair no meio, não repete o disparo.
      const { data: claimed, error: e } = await db.from('news').update({ wa_sent_at: new Date().toISOString() })
        .eq('id', n.id).is('wa_sent_at', null).select('id');
      if (e) throw new Error(e.message);
      if (claimed?.length) await broadcast(n);
    }
  } catch (e) {
    console.error('erro ao verificar novidades', e.message);
  } finally {
    checkingNews = false;
  }
}

// O WhatsApp às vezes identifica o contato por um "LID" em vez do número; pedido e conversa usam o número.
async function pnOf(jid, alt) {
  if (!jid) return '';
  if (!isLidUser(jid)) return digits(jid);
  if (alt && !isLidUser(alt)) return digits(alt);
  try {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
    return pn ? digits(pn) : '';
  } catch {
    return '';
  }
}

const textOf = (c) => c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption
  || c.documentMessage?.caption || c.buttonsResponseMessage?.selectedDisplayText || c.listResponseMessage?.title || '';
const MEDIA = ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'contactMessage', 'locationMessage'];
const hasContent = (c) => !!c && (!!textOf(c) || MEDIA.some((k) => c[k]));
const tsMs = (t) => 1000 * Number(typeof t === 'object' && t?.toNumber ? t.toNumber() : t);

async function onMessage(m, type) {
  const { key } = m;
  const jid = key.remoteJid || '';
  if (!m.message || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return; // status e listas de transmissão
  const content = normalizeMessageContent(m.message); // abre mensagens temporárias, de visualização única…
  if (!hasContent(content)) return; // reações, confirmações, mensagens apagadas
  const isGroup = !!isJidGroup(jid);

  if (key.fromMe) {
    // Alguém da loja escreveu pelo celular (ou WhatsApp Web): o bot sai dessa conversa por 12 h.
    // O que o próprio bot envia volta como 'append' com um id que ele guardou; o que foi digitado
    // no celular chega como 'notify' (ou 'append', se o bot estava fora do ar na hora).
    if (isGroup || sentIds.has(key.id)) return;
    if (type !== 'notify' && !(Date.now() - tsMs(m.messageTimestamp) < PAUSE_TTL_MS)) return;
    const phone = await pnOf(jid, key.remoteJidAlt);
    if (!phone || phone === digits(sock.user?.id)) return;
    if (await core.pause(phone)) log(`bot pausado com +${phone}: resposta pelo celular`);
    return;
  }
  // Mensagem de cliente que chegou com o bot fora do ar: fica para a pessoa da loja (ela vê no celular),
  // sem resposta atrasada que pode atropelar o que já foi combinado por lá.
  if (type !== 'notify') return;

  const text = textOf(content).trim();
  const phone = await pnOf(isGroup ? key.participant : jid, isGroup ? key.participantAlt : key.remoteJidAlt);
  // Em grupo a resposta vai para o privado de quem pediu.
  const replyTo = isGroup ? jidNormalizedUser(key.participantAlt || key.participant) : jid;
  if (!phone) {
    if (!isGroup && text && detectIntent(text, await listProducts())) {
      await sendText(replyTo, `Não consegui identificar seu número 😓 Faça seu pedido pelo site${SITE_URL ? `: ${SITE_URL}` : '.'}`);
    }
    return;
  }
  const replies = await core.handleIncoming({ phone, text, profileName: m.pushName, isGroup });
  for (const r of replies) await sendText(replyTo, r);
}

function onConnection({ connection, lastDisconnect, qr }) {
  if (qr) {
    attempt = 0;
    if (process.stdout.isTTY) {
      console.log('\nNo celular da loja: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie (também aparece no painel):\n');
      qrcodeTerminal.generate(qr, { small: true });
    } else if (status.state !== 'qr') {
      log('Aguardando conexão: o QR Code está no painel (aba Bot WhatsApp).'); // serviço: não desenha o QR no bot.log
    }
    QRCode.toDataURL(qr, { margin: 1, width: 320 })
      .then((url) => setStatus({ state: 'qr', qr: url }))
      .catch((e) => console.error('erro ao gerar QR Code', e.message));
  }
  if (connection === 'open') {
    online = true;
    attempt = 0;
    const phone = digits(sock.user?.id);
    log(`✅ Conectado ao WhatsApp (+${phone}). Bot no ar.`);
    setStatus({ state: 'online', qr: null, phone });
  }
  if (connection === 'close') {
    online = false;
    const code = lastDisconnect?.error?.output?.statusCode;
    let wait = Math.min(60e3, 3e3 * ++attempt);
    if (code === DisconnectReason.loggedOut) {
      // O aparelho foi removido no celular: a sessão não vale mais, então gera um QR Code novo.
      log('❌ WhatsApp desconectado pelo celular. Gerando um QR Code novo (painel → Bot WhatsApp).');
      rmSync(AUTH_DIR, { recursive: true, force: true });
      setStatus({ state: 'desconectado', qr: null, phone: null });
    } else if (code === DisconnectReason.connectionReplaced) {
      wait = 120e3;
      log('Outra cópia do bot conectou com este WhatsApp; tento de novo em 2 min.');
    } else {
      log(`Conexão caiu (${code ?? '?'}), reconectando em ${wait / 1000}s...`);
    }
    if (status.state === 'online') setStatus({ state: 'reconectando' });
    setTimeout(() => start().catch((e) => { console.error(e); process.exit(1); }), wait);
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger: pino({ level: 'error' }), browser: Browsers.macOS('Um Doce Bot'), markOnlineOnConnect: false });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', onConnection);
  // Uma mensagem por vez: duas mensagens seguidas do mesmo cliente não disputam a mesma etapa da conversa.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) queue = queue.then(() => onMessage(m, type)).catch((e) => console.error('erro ao tratar mensagem', e));
  });
}

// Uma cópia só: duas usando a mesma sessão do WhatsApp se derrubam (por exemplo, npm start com o serviço ligado).
try {
  const other = Number(readFileSync(LOCK, 'utf8'));
  if (other && other !== process.pid) {
    process.kill(other, 0); // dá erro se esse processo não existe mais
    console.error(`Outra cópia do bot já está rodando (pid ${other}). Pare o serviço antes: ./instalar-servico-mac.sh remover`);
    process.exit(1);
  }
} catch (e) {
  if (e.code === 'EPERM') { console.error('Outra cópia do bot já está rodando.'); process.exit(1); }
}
writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { if (Number(readFileSync(LOCK, 'utf8')) === process.pid) rmSync(LOCK); } catch {} });

// Confere a chave antes de conectar: a publishable (do site) não grava pedidos nem o status do bot.
const check = await db.auth.admin.listUsers({ perPage: 1 });
if (check.error) {
  console.error('A chave do .env não é a Secret key do Supabase (ou está errada). Confira SUPABASE_SECRET_KEY:', check.error.message);
  process.exit(1);
}
if ((await db.from('news').select('wa_sent_at').limit(1)).error?.code === '42703') {
  console.error(`⚠️  Para enviar novidades, rode no SQL Editor do Supabase: ${NEWS_SQL}`);
  warnedNewsColumn = true;
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await Promise.race([queue, sleep(10e3)]); // termina a mensagem em andamento (um pedido sendo gravado)
    await setStatus({ state: 'desligado', qr: null }).catch(() => {});
    process.exit(0);
  });
}

await setStatus({ state: 'iniciando', qr: null });
await start();
setInterval(() => { setStatus(); sendPendingNews(); }, TICK_MS);
// Erro no envio (banco sem as tabelas novas, Supabase fora do ar): tenta de novo em 1 min e avisa no log a cada 10 min.
let campaignRetryAt = 0;
let campaignWarnAt = 0;
setInterval(() => {
  if (Date.now() < campaignRetryAt) return;
  sender.tick().catch((e) => {
    campaignRetryAt = Date.now() + 60e3;
    if (Date.now() - campaignWarnAt < 10 * 60e3) return;
    campaignWarnAt = Date.now();
    console.error(/schema cache|does not exist/.test(e.message) ? `⚠️  Para enviar campanhas, rode o supabase/schema.sql no SQL Editor do Supabase (${e.message})` : `erro no envio de campanhas: ${e.message}`);
  });
}, CAMPAIGN_TICK_MS);
