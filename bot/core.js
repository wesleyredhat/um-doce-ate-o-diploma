// Quando o bot fala. O número da loja também é de uso pessoal, então:
//   - só entra na conversa com mensagem identificada como encomenda (detectIntent no motor);
//   - depois de entrar, segue a conversa até 30 min sem resposta;
//   - se alguém da loja responde pelo celular, fica 12 h quieto com aquela pessoa
//     (palavra-chave como "menu" ou "cardápio" chama o bot de volta);
//   - em grupo, só com #pedido (o motor continua a conversa no privado).
// Sem Baileys nem Supabase aqui: index.js liga isso ao WhatsApp e core.test.js testa com dados falsos.
import { handleMessage, detectIntent } from '../supabase/functions/_shared/bot-engine.js';

export const SESSION_TTL_MS = 30 * 60e3;
export const PAUSE_TTL_MS = 12 * 3600e3;

const isPaused = (s) => s?.state === 'human';

// ctx: adaptador de dados do motor (listProducts, placeOrder, ...)
// sessions: { get(phone) -> { data, updated_at } | null, save(phone, data | null) }
export function createCore({ ctx, sessions, now = () => Date.now(), log = console.error }) {
  async function loadSession(phone) {
    const row = await sessions.get(phone);
    if (!row?.data) return null;
    const ttl = isPaused(row.data) ? PAUSE_TTL_MS : SESSION_TTL_MS;
    return now() - new Date(row.updated_at).getTime() < ttl ? row.data : null;
  }

  const isAdminCommand = async (phone, text) => text.startsWith('#') && !/^#pedido\b/i.test(text) && !!(await ctx.isAdmin(phone));

  // 'pass' = vai para o motor · 'resume' = tira da pausa e vai para o motor · null = silêncio
  async function decide({ phone, text, isGroup }, session) {
    if (isGroup) {
      if (!text.startsWith('#')) return null;
      return isPaused(session) && /^#pedido\b/i.test(text) ? 'resume' : 'pass';
    }
    const intent = detectIntent(text, await ctx.listProducts());
    if (isPaused(session)) {
      if (intent === 'explicit') return 'resume';
      return (await isAdminCommand(phone, text)) ? 'pass' : null;
    }
    if (session || intent) return 'pass';
    return (await isAdminCommand(phone, text)) ? 'pass' : null;
  }

  // msg: { phone, text, profileName, isGroup } → respostas a enviar (vazio = não responder)
  async function handleIncoming(msg) {
    const text = String(msg.text || '').trim();
    let session = await loadSession(msg.phone);
    if (!text) {
      // áudio, figurinha, foto sem legenda: só avisa quem está no meio de um pedido
      return !msg.isGroup && session && !isPaused(session) ? ['Por enquanto eu só entendo texto 🙈 Mande *menu* para ver as opções.'] : [];
    }
    const decision = await decide({ ...msg, text }, session);
    if (!decision) return [];
    if (decision === 'resume') {
      session = null;
      await sessions.save(msg.phone, null);
    }

    let saved = false;
    const engineCtx = {
      ...ctx,
      getSession: async () => session,
      saveSession: async (phone, data) => { saved = true; session = data; await sessions.save(phone, data); },
    };
    try {
      const replies = await handleMessage({ ...msg, text }, engineCtx);
      // Respondeu sem mudar de etapa (menu, cardápio…): a conversa continua valendo por mais 30 min.
      if (replies.length && !saved && !msg.isGroup) await sessions.save(msg.phone, session || { state: 'menu', cart: [] });
      return replies;
    } catch (e) {
      log(e);
      return ['Ops, algo deu errado por aqui 😓 Tente de novo em instantes ou mande *menu*.'];
    }
  }

  // Alguém da loja respondeu pelo celular: o bot sai da conversa com essa pessoa.
  const pause = (phone) => sessions.save(phone, { state: 'human', cart: [] });

  return { handleIncoming, pause, loadSession };
}
