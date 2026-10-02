// Bot de encomendas no WhatsApp comum (sem API Business): conecta lendo o QR Code,
// como o WhatsApp Web. Usa o mesmo motor de conversa do simulador do painel.
//
//   cp .env.example .env    (preencha a chave secreta do Supabase)
//   npm install && npm start
//
// A sessão fica em ./auth — não apague, senão terá de escanear o QR de novo.
import makeWASocket, { DisconnectReason, useMultiFileAuthState, isJidGroup, isLidUser, jidNormalizedUser } from 'baileys';
import { createClient } from '@supabase/supabase-js';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { handleMessage } from '../supabase/functions/_shared/bot-engine.js';

const env = (k, d = '') => process.env[k] ?? d;
for (const k of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
  if (!env(k)) { console.error(`Falta ${k} no arquivo .env`); process.exit(1); }
}
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
const SITE_URL = env('SITE_URL');
const OWNER_PHONE = env('OWNER_PHONE').replace(/\D/g, '');
const NEWS_POLL_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const toJid = (phone) => `${phone}@s.whatsapp.net`;

let sock;
let online = false;

async function sendText(jid, text) {
  try {
    await sock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    console.error('falha ao enviar', jid, e.message);
    return false;
  }
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
  console.log(`novidade "${news.title}" enviada para ${sent} cliente(s)`);
  return { sent };
}

const ctx = {
  listProducts: async () => (await db.from('products').select('*').eq('active', true).order('sort')).data ?? [],
  getSettings: async () => (await db.from('settings').select('value').eq('key', 'store').maybeSingle()).data?.value ?? {},
  getSession: async (phone) => (await db.from('bot_sessions').select('data').eq('phone', phone).maybeSingle()).data?.data ?? null,
  saveSession: async (phone, data) => {
    if (data) await db.from('bot_sessions').upsert({ phone, data, updated_at: new Date().toISOString() });
    else await db.from('bot_sessions').delete().eq('phone', phone);
  },
  isAdmin: async (phone) => (await db.from('bot_admins').select('*').eq('phone', phone).maybeSingle()).data,
  listNews: async () => (await db.from('news').select('*').eq('published', true).order('created_at', { ascending: false }).limit(3)).data ?? [],
  subscribe: async (phone, name, on) => {
    if (on) await db.from('subscribers').upsert({ phone, name });
    else await db.from('subscribers').delete().eq('phone', phone);
  },
  placeOrder: async (o) => {
    const { data, error } = await db.rpc('place_order', { p_name: o.customer_name, p_phone: o.phone, p_items: o.items, p_channel: o.channel, p_notes: '' });
    if (error) throw new Error(error.message);
    return data;
  },
  // Novidade criada pelo bot (#novidade) já sai enviada; marca para o verificador não reenviar.
  createNews: async (n) => (await db.from('news').insert({ ...n, published: true, wa_sent_at: new Date().toISOString() }).select().single()).data,
  broadcast,
  listOpenOrders: async () =>
    (await db.from('orders').select('*').in('status', ['novo', 'confirmado', 'producao', 'pronto']).order('created_at')).data ?? [],
  notifyHuman: async (phone, name) => {
    if (OWNER_PHONE) await sendText(toJid(OWNER_PHONE), `💬 ${name || 'Cliente'} (+${phone}) pediu atendimento humano no bot.`);
  },
};

// Novidades publicadas no painel com o canal WhatsApp ficam pendentes até o bot enviar.
let checkingNews = false;
async function sendPendingNews() {
  if (checkingNews || !online) return;
  checkingNews = true;
  try {
    const since = new Date(Date.now() - 2 * 864e5).toISOString();
    const { data, error } = await db.from('news').select('*')
      .contains('channels', ['whatsapp']).eq('published', true).is('wa_sent_at', null).gte('created_at', since).order('created_at');
    if (error) throw error;
    for (const n of data ?? []) {
      // Marca antes de enviar: se o bot cair no meio, não dispara duas vezes para os mesmos clientes.
      await db.from('news').update({ wa_sent_at: new Date().toISOString() }).eq('id', n.id);
      await broadcast(n);
    }
  } catch (e) {
    console.error('erro ao verificar novidades', e.message);
  } finally {
    checkingNews = false;
  }
}

// O WhatsApp pode identificar o contato por um "LID" em vez do número; o pedido precisa do número.
async function senderPhone(key) {
  const group = isJidGroup(key.remoteJid);
  const jid = group ? key.participant : key.remoteJid;
  const alt = group ? key.participantAlt : key.remoteJidAlt;
  if (!isLidUser(jid)) return digits(jid);
  if (alt && !isLidUser(alt)) return digits(alt);
  const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null);
  return pn ? digits(pn) : '';
}

function textOf(m) {
  const c = m.message || {};
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.buttonsResponseMessage?.selectedDisplayText
    || c.listResponseMessage?.title || '';
}

async function onMessage(m) {
  const { key } = m;
  if (key.fromMe || !m.message || key.remoteJid === 'status@broadcast' || key.remoteJid?.endsWith('@newsletter')) return;
  const isGroup = isJidGroup(key.remoteJid);
  const text = textOf(m).trim();
  if (!text) {
    if (!isGroup) await sendText(key.remoteJid, 'Por enquanto eu só entendo texto 🙈 Mande *oi* para ver o menu.');
    return;
  }
  const phone = await senderPhone(key);
  // Em grupo o motor só responde a #pedido e continua a conversa no privado.
  const replyTo = isGroup ? jidNormalizedUser(key.participantAlt || key.participant) : key.remoteJid;
  if (!phone) {
    if (!isGroup) await sendText(replyTo, 'Não consegui identificar seu número 😓 Faça seu pedido pelo site' + (SITE_URL ? `: ${SITE_URL}` : '.'));
    return;
  }
  try {
    const replies = await handleMessage({ phone, text, profileName: m.pushName, isGroup }, ctx);
    for (const r of replies) await sendText(replyTo, r);
  } catch (e) {
    console.error(e);
    await sendText(replyTo, 'Ops, algo deu errado por aqui 😓 Tente de novo em instantes ou mande *menu*.');
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(new URL('./auth', import.meta.url).pathname);
  sock = makeWASocket({ auth: state, logger: pino({ level: 'warn' }), markOnlineOnConnect: false, browser: ['Um Doce Bot', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nNo celular da loja: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie:\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') { online = true; console.log('✅ Conectado ao WhatsApp. Bot no ar.'); heartbeat(); }
    if (connection === 'close') {
      online = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('❌ O aparelho foi desconectado no celular. Apague a pasta bot/auth e rode de novo para escanear outro QR.');
        process.exit(1);
      }
      console.log('Conexão caiu, reconectando...');
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // ignora histórico sincronizado ao conectar
    for (const m of messages) await onMessage(m);
  });
}

// Sinal de vida lido pela aba "Bot WhatsApp" do painel.
async function heartbeat() {
  if (!online) return;
  const { error } = await db.from('settings').upsert({ key: 'bot', value: { last_seen: new Date().toISOString(), phone: digits(sock.user?.id) } });
  if (error) console.error('erro ao gravar status', error.message);
}

start();
setInterval(() => { heartbeat(); sendPendingNews(); }, NEWS_POLL_MS);
