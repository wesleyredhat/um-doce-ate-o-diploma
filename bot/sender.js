// Envio das campanhas pelo WhatsApp, devagar para o número não ser bloqueado:
//   - uma mensagem a cada 20 a 60 s, só no horário configurado (Brasília) e até o limite do dia (todas as campanhas);
//   - pula quem pediu para sair e marca "falhou" número sem WhatsApp;
//   - 5 erros de envio seguidos pausam a campanha; mensagem presa em "enviando" há 5 min volta para a fila.
// Sem Baileys nem Supabase aqui: index.js liga isso ao WhatsApp e sender.test.js testa com dados falsos.
import { PACE, spClock, spDayStart, campaignText } from '../assets/js/campaigns.js';

export const STALE_MS = 5 * 60e3;
export const MAX_FAILS = 5;

// db: settings(), requeueStale(antesIso), sentSince(iso), nextCampaign(), claim(campanhaId, agoraIso), isOptedOut(phoneKey),
//     mark(envioId, campos), pause(campanhaId, motivo), finish(campanhaId) → true se concluiu
// wa: online(), lookup(telefone) → jid ou null, send(jid, texto) → true/false
export function createSender({ db, wa, siteUrl = '', now = () => Date.now(), random = Math.random, log = console.log }) {
  let nextAt = 0;
  let fails = 0;
  let busy = false;
  let cfg = null;
  let cfgAt = -Infinity;

  const settings = async (t) => {
    if (!cfg || t - cfgAt > 60e3) {
      cfg = { ...PACE, ...(await db.settings()) };
      cfgAt = t;
    }
    return cfg;
  };
  const idle = (t, ms, why) => {
    nextAt = t + ms;
    return why;
  };

  async function step() {
    if (!wa.online()) return 'offline';
    const t = now();
    if (t < nextAt) return 'aguardando';
    const c = await settings(t);
    const { hour } = spClock(t);
    if (hour < c.start_hour || hour >= c.end_hour) return idle(t, 60e3, 'fora do horário');
    await db.requeueStale(new Date(t - STALE_MS).toISOString());
    if ((await db.sentSince(new Date(spDayStart(t)).toISOString())) >= c.daily_limit) return idle(t, 60e3, 'limite do dia');
    const campaign = await db.nextCampaign();
    if (!campaign) return idle(t, 30e3, 'sem campanha');
    const s = await db.claim(campaign.id, new Date(t).toISOString());
    if (!s) {
      if (!(await db.finish(campaign.id))) return idle(t, 30e3, 'aguardando');
      log(`campanha "${campaign.name}" concluída`);
      return 'concluída';
    }
    if (await db.isOptedOut(s.phone_key)) {
      await db.mark(s.id, { status: 'pulada' });
      return 'pulada';
    }
    const jid = await wa.lookup(s.phone);
    if (!jid) {
      await db.mark(s.id, { status: 'falhou', error: 'Número sem WhatsApp' });
      return 'sem whatsapp';
    }
    const ok = await wa.send(jid, campaignText(campaign, s.name, siteUrl));
    nextAt = t + c.gap_min_ms + random() * (c.gap_max_ms - c.gap_min_ms);
    if (ok) {
      fails = 0;
      await db.mark(s.id, { status: 'enviada', sent_at: new Date(t).toISOString(), error: null });
      return 'enviada';
    }
    await db.mark(s.id, { status: 'falhou', error: 'Erro ao enviar' });
    if (++fails >= MAX_FAILS) {
      fails = 0;
      await db.pause(campaign.id, `${MAX_FAILS} envios seguidos falharam. Confira o WhatsApp do bot e retome a campanha.`);
      log(`campanha "${campaign.name}" pausada: ${MAX_FAILS} falhas seguidas`);
    }
    return 'falhou';
  }

  // Chamado a cada poucos segundos pelo index.js; nunca roda dois ao mesmo tempo.
  async function tick() {
    if (busy) return 'ocupado';
    busy = true;
    try {
      return await step();
    } finally {
      busy = false;
    }
  }
  return { tick };
}
