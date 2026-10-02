// Edge Function: bot de encomendas no WhatsApp (WhatsApp Business Cloud API).
//
//   GET  /whatsapp-bot             → verificação do webhook pela Meta
//   POST /whatsapp-bot             → mensagens recebidas (webhook)
//   POST /whatsapp-bot/broadcast   → painel dispara uma novidade aos inscritos (exige login de admin)
//
// Deploy:  supabase functions deploy whatsapp-bot --no-verify-jwt
// Segredos (supabase secrets set ...):
//   WA_TOKEN            token permanente do usuário de sistema da Meta
//   WA_PHONE_ID         Phone number ID do número da loja
//   WA_VERIFY_TOKEN     texto qualquer, igual ao configurado no webhook da Meta
//   WA_APP_SECRET       (recomendado) valida a assinatura X-Hub-Signature-256
//   WA_TEMPLATE_NEWS    (opcional) nome do template aprovado p/ novidades fora da janela de 24h
//   OWNER_PHONE         (opcional) número que recebe aviso quando cliente pede atendimento humano
//   SITE_URL            (opcional) URL da loja no GitHub Pages
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handleMessage } from '../_shared/bot-engine.js';

const env = (k: string) => Deno.env.get(k) ?? '';
const GRAPH = `https://graph.facebook.com/${env('WA_API_VERSION') || 'v21.0'}`;
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function sendText(to: string, body: string) {
  const res = await fetch(`${GRAPH}/${env('WA_PHONE_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WA_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: true } }),
  });
  if (!res.ok) console.error('send failed', to, await res.text());
  return res.ok;
}

async function sendNews(to: string, news: { title: string; body: string }) {
  const tpl = env('WA_TEMPLATE_NEWS');
  if (!tpl) return sendText(to, `✨ *${news.title}*\n${news.body}${env('SITE_URL') ? `\n\nPeça já: ${env('SITE_URL')}` : ''}\n\n_Para sair, responda "parar novidades"._`);
  // Fora da janela de 24h a Meta só permite templates aprovados.
  const res = await fetch(`${GRAPH}/${env('WA_PHONE_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WA_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: tpl, language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: news.title }, { type: 'text', text: news.body.slice(0, 900) }] }] },
    }),
  });
  return res.ok;
}

async function broadcast(news: { title: string; body: string }) {
  const { data: subs } = await db.from('subscribers').select('phone');
  let sent = 0;
  for (const s of subs ?? []) {
    if (await sendNews(s.phone, news)) sent++;
    await new Promise((r) => setTimeout(r, 120)); // respeita limites de envio
  }
  return { sent };
}

const ctx = {
  listProducts: async () => (await db.from('products').select('*').eq('active', true).order('sort')).data ?? [],
  getSettings: async () => (await db.from('settings').select('value').eq('key', 'store').maybeSingle()).data?.value ?? {},
  getSession: async (phone: string) => (await db.from('bot_sessions').select('data').eq('phone', phone).maybeSingle()).data?.data ?? null,
  saveSession: async (phone: string, data: unknown) => {
    if (data) await db.from('bot_sessions').upsert({ phone, data, updated_at: new Date().toISOString() });
    else await db.from('bot_sessions').delete().eq('phone', phone);
  },
  isAdmin: async (phone: string) => (await db.from('bot_admins').select('*').eq('phone', phone).maybeSingle()).data,
  listNews: async () => (await db.from('news').select('*').eq('published', true).order('created_at', { ascending: false }).limit(3)).data ?? [],
  subscribe: async (phone: string, name: string, on: boolean) => {
    if (on) await db.from('subscribers').upsert({ phone, name });
    else await db.from('subscribers').delete().eq('phone', phone);
  },
  placeOrder: async (o: { customer_name: string; phone: string; items: unknown; channel: string }) => {
    const { data, error } = await db.rpc('place_order', { p_name: o.customer_name, p_phone: o.phone, p_items: o.items, p_channel: o.channel, p_notes: '' });
    if (error) throw new Error(error.message);
    return data;
  },
  createNews: async (n: Record<string, unknown>) => (await db.from('news').insert({ ...n, published: true }).select().single()).data,
  broadcast,
  listOpenOrders: async () =>
    (await db.from('orders').select('*').in('status', ['novo', 'confirmado', 'producao', 'pronto']).order('created_at')).data ?? [],
  notifyHuman: async (phone: string, name: string) => {
    if (env('OWNER_PHONE')) await sendText(env('OWNER_PHONE'), `💬 ${name || 'Cliente'} (+${phone}) pediu atendimento humano no bot.`);
  },
};

async function validSignature(req: Request, raw: string) {
  const secret = env('WA_APP_SECRET');
  if (!secret) return true;
  const sig = req.headers.get('x-hub-signature-256')?.replace('sha256=', '') ?? '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.length === sig.length && hex === sig;
}

const seen = new Set<string>(); // evita processar reenvios do webhook na mesma instância

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // 1) Verificação do webhook
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === env('WA_VERIFY_TOKEN');
    return ok ? new Response(url.searchParams.get('hub.challenge')) : new Response('forbidden', { status: 403 });
  }

  // 2) Disparo de novidade pelo painel
  if (url.pathname.endsWith('/broadcast')) {
    const userClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: isAdmin } = await userClient.rpc('is_admin');
    if (!isAdmin) return json({ error: 'forbidden' }, 403);
    const { news_id } = await req.json();
    const { data: news } = await db.from('news').select('*').eq('id', news_id).single();
    if (!news) return json({ error: 'not found' }, 404);
    return json(await broadcast(news));
  }

  // 3) Mensagens recebidas
  const raw = await req.text();
  if (!(await validSignature(req, raw))) return new Response('bad signature', { status: 401 });
  const payload = JSON.parse(raw || '{}');

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = Object.fromEntries((value.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '';
        if (!text) {
          await sendText(m.from, 'Por enquanto eu só entendo texto 🙈 Mande *oi* para ver o menu.');
          continue;
        }
        try {
          // Mensagens de grupo: depende do suporte a grupos do seu provedor/API.
          // O motor só responde em grupo quando a mensagem começa com #pedido e continua no privado.
          const replies = await handleMessage({ phone: m.from, text, profileName: names[m.from], isGroup: Boolean(m.group_id) }, ctx);
          for (const r of replies) await sendText(m.from, r);
        } catch (e) {
          console.error(e);
          await sendText(m.from, 'Ops, algo deu errado por aqui 😓 Tente de novo em instantes ou mande *menu*.');
        }
      }
    }
  }
  return new Response('ok');
});
