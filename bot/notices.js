// Avisos automáticos do pedido pelo WhatsApp. Um gatilho do banco (orders_notice, em supabase/schema.sql)
// cria o aviso quando o status muda na esteira do painel:
//   - confirmado: confirmação com itens e total e, numa segunda mensagem, só o Pix Copia e Cola (já com o valor);
//   - pronto: pedido disponível para entrega (na entrega com dia marcado, o lugar e o dia).
// Aviso de pedido que voltou atrás espera; de pedido cancelado (ou "pronto" já entregue) e com mais de 1 dia, pula.
// Sem Baileys nem Supabase aqui: index.js liga isso ao WhatsApp e notices.test.js testa com dados falsos.
import { deliveryText } from '../supabase/functions/_shared/delivery.js';
import { orderPix } from '../supabase/functions/_shared/pix.js';

export const NOTICE_MAX_AGE_MS = 864e5;

const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
// Status em que cada aviso ainda faz sentido; 'novo' (e "pronto" antes de ficar pronto) espera na fila.
const VALID = { confirmado: ['confirmado', 'producao', 'pronto'], pronto: ['pronto'] };
const WAIT = { confirmado: ['novo'], pronto: ['novo', 'confirmado', 'producao'] };

export function noticeTexts(kind, o, store = {}) {
  const first = o.customer_name.split(' ')[0];
  const spot = o.delivery === 'ponto' && o.delivery_date;
  if (kind === 'pronto') {
    // Usa o que a cliente já informou (dia marcado ou observação do pedido) em vez de perguntar de novo.
    if (spot) return [`Oi, ${first}! Seu pedido *${o.code}* está prontinho 🎓🍫\n📍 Entrega: ${deliveryText(o, store)}\nTe espero lá 💛`];
    const notes = String(o.notes || '').trim();
    if (notes) return [`Oi, ${first}! Seu pedido *${o.code}* está prontinho e disponível para entrega 🎓🍫\n📝 Você escreveu: "${notes}"\nSe algo mudou, me avisa por aqui 💛`];
    return [`Oi, ${first}! Seu pedido *${o.code}* está prontinho e disponível para entrega 🎓🍫\nMe conta o melhor horário e o local que a gente combina por aqui 💛`];
  }
  const items = o.items.map((i) => `• ${i.qty}x ${i.name}`).join('\n');
  const off = Number(o.discount) > 0 ? ` (já com ${brl(o.discount)} de desconto)` : '';
  const where = spot ? `\n📍 Entrega: ${deliveryText(o, store)}` : '';
  const head = `Oi, ${first}! Seu pedido *${o.code}* está confirmado ✅\n${items}\nTotal: *${brl(o.total)}*${off}${where}`;
  const pix = orderPix(store, o);
  if (!pix) return [`${head}\n\nJá já combinamos o pagamento por aqui 💛`];
  // O código vai sozinho na mensagem seguinte: um toque longo copia só ele. (O cartão Pix do WhatsApp Business
  // não aparece quando enviado pelo WhatsApp comum, nem no celular: testado em 02/10/2026.)
  return [
    `${head}\n\n💸 *Pagamento por Pix*\nCopie o código da próxima mensagem e cole no app do banco em *Pix Copia e Cola*: já vai com o valor certinho.\n_Se preferir, a chave é ${pix.label}_\n\nDepois é só mandar o comprovante por aqui 💛`,
    pix.code,
  ];
}

// db: settings() → settings.store, pending() → [{id, kind, created_at, order}], claim(id) → true se pegou, mark(id, campos)
// wa: online(), lookup(telefone) → jid ou null, send(jid, texto) → true/false
export function createNotices({ db, wa, now = () => Date.now(), log = console.log }) {
  let busy = false;

  async function run() {
    if (!wa.online()) return 'offline';
    const list = await db.pending();
    if (!list.length) return 'sem avisos';
    const store = await db.settings();
    for (const n of list) {
      const o = n.order;
      if (!o) continue;
      if (now() - Date.parse(n.created_at) > NOTICE_MAX_AGE_MS) {
        await db.mark(n.id, { status: 'pulada', error: 'Aviso antigo: o bot ficou desligado' });
        continue;
      }
      if (WAIT[n.kind].includes(o.status)) continue;
      if (!VALID[n.kind].includes(o.status)) {
        await db.mark(n.id, { status: 'pulada', error: `Pedido ${o.status}` });
        continue;
      }
      if (!(await db.claim(n.id))) continue;
      const jid = await wa.lookup(o.phone);
      if (!jid) {
        await db.mark(n.id, { status: 'falhou', error: 'Número sem WhatsApp' });
        continue;
      }
      let ok = true;
      for (const text of noticeTexts(n.kind, o, store)) ok = ok && (await wa.send(jid, text));
      if (ok) {
        await db.mark(n.id, { status: 'enviada', sent_at: new Date(now()).toISOString(), error: null });
        log(`aviso "${n.kind}" do pedido ${o.code} enviado`);
      } else {
        await db.mark(n.id, { status: 'falhou', error: 'Erro ao enviar' });
      }
    }
    return 'ok';
  }

  // Chamado a cada 30 s pelo index.js; nunca roda dois ao mesmo tempo.
  async function tick() {
    if (busy) return 'ocupado';
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  }
  return { tick };
}
