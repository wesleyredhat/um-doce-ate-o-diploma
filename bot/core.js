// Quando o bot fala. O número da loja também é de uso pessoal, então:
//   - só entra na conversa com mensagem identificada como encomenda (detectIntent no motor);
//   - depois de entrar, segue a conversa até 30 min sem resposta;
//   - se alguém da loja responde pelo celular, fica 12 h quieto com aquela pessoa
//     ("menu", "cardápio" ou "#pedido" chamam o bot de volta; "parar novidades" funciona sempre);
//   - em grupo, só com #pedido (o motor continua a conversa no privado).
// Sem Baileys nem Supabase aqui: index.js liga isso ao WhatsApp e core.test.js testa com dados falsos.
import { handleMessage, detectIntent } from '../supabase/functions/_shared/bot-engine.js';

export const SESSION_TTL_MS = 30 * 60e3;
export const PAUSE_TTL_MS = 12 * 3600e3;
// "parar", "sair", "stop" sozinhos: saída das promoções para quem recebeu campanha (ctx.gotCampaign).
const STOP_ALONE = /^(?:parar|pare|para|sair|stop|cancelar|descadastrar|remover)[\s!.]*$/i;
const PAUSE_REFRESH_MS = 10 * 60e3; // pausa já gravada há menos de 10 min não é regravada

const isPaused = (s) => s?.state === 'human';

// ctx: adaptador de dados do motor (listProducts, placeOrder, ...)
// sessions: { get(phone) -> { data, updated_at } | null, save(phone, data | null) }
export function createCore({ ctx, sessions, now = () => Date.now(), log = console.error }) {
  // pausa conta da hora da resposta pelo celular (que pode ter chegado atrasada, com o bot fora do ar)
  const since = (row) => (isPaused(row.data) && row.data.since) || new Date(row.updated_at).getTime();
  const age = (row) => now() - since(row);

  async function loadSession(phone) {
    const row = await sessions.get(phone);
    if (!row?.data) return null;
    return age(row) < (isPaused(row.data) ? PAUSE_TTL_MS : SESSION_TTL_MS) ? row.data : null;
  }

  const isAdminCommand = async (phone, text) => text.startsWith('#') && !/^#pedido\b/i.test(text) && !!(await ctx.isAdmin(phone));

  // 'pass' = vai para o motor · 'resume' = tira da pausa e vai para o motor · null = silêncio
  async function decide({ phone, text, isGroup }, session, kind) {
    if (isGroup) return isPaused(session) && /^#pedido\b/i.test(text) ? 'resume' : 'pass';
    if (isPaused(session)) {
      if (kind === 'keyword') return 'resume';
      if (kind === 'unsubscribe') return 'pass';
      return (await isAdminCommand(phone, text)) ? 'pass' : null;
    }
    if (session || kind) return 'pass';
    return (await isAdminCommand(phone, text)) ? 'pass' : null;
  }

  // msg: { phone, text, profileName, isGroup } → respostas a enviar (vazio = não responder)
  async function handleIncoming(msg) {
    let text = String(msg.text || '').trim();
    if (msg.isGroup && !text.startsWith('#')) return []; // grupo: nem consulta o banco
    let session = await loadSession(msg.phone);
    if (!text) {
      // áudio, figurinha, foto sem legenda: só avisa quem está no meio de um pedido
      return session && !isPaused(session) ? ['Por enquanto eu só entendo texto 🙈 Mande *menu* para ver as opções.'] : [];
    }
    let kind = msg.isGroup ? null : detectIntent(text, await ctx.listProducts());
    // Quem recebeu campanha costuma responder só "parar" ou "PARE": fora de conversa, vale como saída das promoções.
    if (!kind && !session && !msg.isGroup && STOP_ALONE.test(text) && (await ctx.gotCampaign?.(msg.phone))) {
      kind = 'unsubscribe';
      text = 'parar promoções';
    }
    const decision = await decide({ ...msg, text }, session, kind);
    if (!decision) return [];
    if (decision === 'resume') {
      session = null;
      await sessions.save(msg.phone, null);
    }

    let saved = false;
    const engineCtx = {
      ...ctx,
      now,
      getSession: async () => session,
      saveSession: async (phone, data) => { saved = true; session = data; await sessions.save(phone, data); },
    };
    try {
      const replies = await handleMessage({ ...msg, text }, engineCtx);
      // Respondeu sem mudar de etapa (cardápio, novidades…): a conversa continua valendo por mais 30 min.
      // Comando de administradora e entrada/saída das novidades não abrem conversa.
      const keepOpen = replies.length && !saved && kind !== 'subscribe' && kind !== 'unsubscribe' && !(await isAdminCommand(msg.phone, text));
      if (keepOpen) await sessions.save(msg.phone, session || { state: 'menu', cart: [] });
      return replies;
    } catch (e) {
      log(e);
      return ['Ops, algo deu errado por aqui 😓 Tente de novo em instantes ou mande *menu*.'];
    }
  }

  // Alguém da loja respondeu pelo celular (at = hora da mensagem): o bot sai da conversa com essa pessoa.
  // Devolve true quando gravou a pausa.
  async function pause(phone, at = now()) {
    const row = await sessions.get(phone);
    if (isPaused(row?.data) && at - since(row) < PAUSE_REFRESH_MS) return false;
    await sessions.save(phone, { state: 'human', cart: [], since: at });
    return true;
  }

  return { handleIncoming, pause, loadSession };
}
