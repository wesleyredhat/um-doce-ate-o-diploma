// Comprovante do Pix pelo WhatsApp: foto, PDF ou "paguei"/"segue o comprovante" de quem recebeu a confirmação
// com o Pix (notices.js) nos últimos 3 dias e ainda tem o pedido em "Confirmado" sem pagamento marcado.
// O pedido vai para "Em produção" com receipt_at, e o painel mostra 🧾 para a loja conferir no banco:
// o bot não tem como saber se o dinheiro caiu nem se o comprovante é verdadeiro.
// Sem Baileys nem Supabase aqui: index.js liga isso ao WhatsApp e receipts.test.js testa com dados falsos.
import { phoneKey } from '../assets/js/coupons.js';

export const RECEIPT_WINDOW_MS = 3 * 864e5;

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Passado ("paguei", "pix feito") ou o comprovante em si; futuro e negação ("vou mandar", "ainda não paguei") não contam.
const RECEIPT_TEXT = /^(segue|ta ai|tai|aqui|aqui esta|olha)? ?(o )?comprovante\b|\b(paguei|fiz o pix|transferi)\b|\bpix (ja )?(feito|enviado|realizado|pago)\b|\bpagamento (ja )?(feito|realizado|enviado|efetuado)\b/;
const NOT_YET = /\b(nao|vou|vai|ainda|depois|amanha)\b/;

export function looksLikeReceipt({ media = false, text = '' }) {
  if (media) return true;
  const t = norm(text);
  return RECEIPT_TEXT.test(t) && !NOT_YET.test(t);
}

// db: recentConfirmations(desdeIso) → [{ sent_at, order: { id, code, customer_name, phone, status, paid } }]
//     advance(pedidoId, agoraIso) → true se o pedido ainda estava "confirmado" e foi para a produção
export function createReceipts({ db, now = () => Date.now(), log = console.log }) {
  async function handle({ phone, media = false, text = '' }) {
    if (!looksLikeReceipt({ media, text })) return null;
    const key = phoneKey(phone);
    const since = new Date(now() - RECEIPT_WINDOW_MS).toISOString();
    const waiting = (await db.recentConfirmations(since))
      .filter((c) => c.order && c.order.status === 'confirmado' && !c.order.paid && phoneKey(c.order.phone) === key)
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at));
    const o = waiting[0]?.order;
    if (!o || !(await db.advance(o.id, new Date(now()).toISOString()))) return null;
    log(`comprovante de +${phone}: pedido ${o.code} foi para a produção`);
    return `Recebi seu comprovante 🧾 Obrigada, ${o.customer_name.split(' ')[0]}! O pedido *${o.code}* já foi para a produção 👩‍🍳`;
  }
  return { handle };
}
