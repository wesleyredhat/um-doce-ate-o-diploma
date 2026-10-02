// Comprovante do Pix pelo WhatsApp, de quem recebeu a confirmação com o Pix (notices.js) nos últimos 3 dias
// e ainda tem o pedido em "Confirmado" sem pagamento marcado:
//   - foto ou PDF: o bot lê o texto (ocr.swift) e confere valor ou código do pedido, e a data (receipt-check.js).
//     Conferiu: o pedido vai para "Em produção". Não conferiu: fica em "Confirmado" com 🧾 "conferir" no painel.
//   - "paguei", "segue o comprovante" sem anexo: o bot pede a foto ou o PDF; nada muda no pedido.
// O bot não sabe se o dinheiro caiu na conta nem se o comprovante é verdadeiro: a loja confere no banco.
// Sem Baileys nem Supabase aqui: index.js liga isso ao WhatsApp e receipts.test.js testa com dados falsos.
import { phoneKey } from '../assets/js/coupons.js';
import { checkReceipt } from './receipt-check.js';

export const RECEIPT_WINDOW_MS = 3 * 864e5;

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
// Passado ("paguei", "pix feito") ou o comprovante em si; futuro e negação ("vou mandar", "ainda não paguei") não contam.
const RECEIPT_TEXT = /^(segue|ta ai|tai|aqui|aqui esta|olha)? ?(o )?comprovante\b|\b(paguei|fiz o pix|transferi)\b|\bpix (ja )?(feito|enviado|realizado|pago)\b|\bpagamento (ja )?(feito|realizado|enviado|efetuado)\b/;
const NOT_YET = /\b(nao|vou|vai|ainda|depois|amanha)\b/;
const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');

export function looksLikeReceipt({ media = false, text = '' }) {
  if (media) return true;
  const t = norm(text);
  return RECEIPT_TEXT.test(t) && !NOT_YET.test(t);
}

// db: recentConfirmations(desdeIso) → [{ sent_at, order: { id, code, customer_name, phone, status, paid, total, created_at, receipt_at } }]
//     advance(pedidoId, agoraIso, nota) → true se o pedido ainda estava "confirmado" e foi para a produção
//     flag(pedidoId, agoraIso, nota) → marca o comprovante para a loja conferir (o pedido não muda de etapa)
// handle({ phone, media, text, read }): read() devolve o texto do comprovante (PDF ou OCR da foto).
export function createReceipts({ db, now = () => Date.now(), log = console.log }) {
  async function waitingOrder(phone) {
    const key = phoneKey(phone);
    const since = new Date(now() - RECEIPT_WINDOW_MS).toISOString();
    return (await db.recentConfirmations(since))
      .filter((c) => c.order && c.order.status === 'confirmado' && !c.order.paid && phoneKey(c.order.phone) === key)
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0]?.order || null;
  }

  async function handle({ phone, media = false, text = '', read = async () => '' }) {
    if (!looksLikeReceipt({ media, text })) return null;
    const o = await waitingOrder(phone);
    if (!o) return null;
    const first = o.customer_name.split(' ')[0];
    if (!media) return `Que bom, ${first}! Me manda o comprovante por aqui (foto ou PDF) que eu confiro e já coloco o pedido *${o.code}* na produção 🧾`;
    const at = new Date(now()).toISOString();
    const r = checkReceipt(await read().catch(() => ''), o, now());
    if (r.ok) {
      if (!(await db.advance(o.id, at, r.reason))) return null;
      log(`comprovante de +${phone} conferido (${r.reason}): pedido ${o.code} foi para a produção`);
      return `Recebi seu comprovante 🧾 Conferi o pagamento${r.amount ? ` de *${brl(o.total)}*` : ''}. Obrigada, ${first}! O pedido *${o.code}* já foi para a produção 👩‍🍳`;
    }
    // Responde só no primeiro: se mandar outra foto que também não confere, a loja já foi avisada pelo painel.
    const firstTry = !o.receipt_at;
    await db.flag(o.id, at, r.reason);
    log(`comprovante de +${phone} para conferir (${r.reason}): pedido ${o.code}`);
    return firstTry ? `Recebi seu comprovante 🧾 Vou conferir aqui e já te confirmo, ${first} 💛` : null;
  }
  return { handle };
}
