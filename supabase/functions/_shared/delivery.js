// Forma de entrega do pedido, a mesma no site, no bot e no painel (place_order confere de novo no banco):
//   ponto:    lugar fixo com dia marcado (Ajustes → Entrega com dia marcado), a partir de amanhã;
//   combinar: outro local ou retirada, combinados pelo WhatsApp.
// settings.delivery_spot = { label: 'Na faculdade, em dia de aula', days: [1, 2, 3, 5] } (0 = domingo … 6 = sábado)
export const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export const DELIVERY_MAX_DAYS = 14; // o mesmo limite de place_order
export const COMBINE_LABEL = 'Outro local ou retirada (combinamos pelo WhatsApp)';

export function spotOf(settings) {
  const s = settings?.delivery_spot;
  return s && String(s.label || '').trim() && Array.isArray(s.days) && s.days.length ? s : null;
}

// Datas como 'AAAA-MM-DD'; meio-dia UTC para o dia da semana não depender do fuso.
const spToday = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

// Próximas datas com entrega no ponto, a partir de amanhã (horário de Brasília).
export function deliveryDates(settings, now = Date.now(), count = 4) {
  const spot = spotOf(settings);
  if (!spot) return [];
  const today = spToday(now);
  const out = [];
  for (let i = 1; i <= DELIVERY_MAX_DAYS && out.length < count; i++) {
    const d = addDays(today, i);
    if (spot.days.includes(weekday(d))) out.push(d);
  }
  return out;
}

export const dayLabel = (iso) => `${WEEKDAYS[weekday(iso)]}, ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// Linha de entrega do pedido (resumo do bot, avisos, painel). o = { delivery, delivery_date }
export function deliveryText(o, settings) {
  if (o?.delivery === 'ponto' && o.delivery_date) return `${spotOf(settings)?.label || 'Entrega com dia marcado'} · ${dayLabel(o.delivery_date)}`;
  return COMBINE_LABEL;
}
