// Confere o texto de um comprovante de Pix (lido do PDF ou da foto por ocr.swift) com o pedido:
//   - o valor do pedido ou o código dele (vai no Pix Copia e Cola como identificador, ex.: DDFHWA) aparece;
//   - a data e hora do pagamento são depois de o pedido ter sido feito (e não estão no futuro).
// Cada banco escreve a data de um jeito: "02 OUT 2026 - 19:47", "02/10/2026 às 19h47", "2 de outubro de 2026, 19:47".
const MONTHS = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const TOLERANCE_MS = 3 * 60e3; // comprovante mostra só hora e minuto, e o relógio do celular pode estar um pouco atrasado

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const spMs = (y, mo, d, h = 0, mi = 0, se = 0) => Date.parse(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}-03:00`);
const validDate = (y, mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2100;

// Valores em centavos: "R$ 10,00", "R$10", "R$ 1.234,56" e, perto de "valor", "10,00" sozinho.
export function amountsIn(text) {
  const t = norm(text);
  const out = new Set();
  const money = /r\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?/g;
  for (const m of t.matchAll(money)) out.add(Number(m[1].replace(/\./g, '')) * 100 + Number(m[2] || 0));
  for (const m of t.matchAll(/valor[^\d\n]{0,20}\n?\s*(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b/g)) out.add(Number(m[1].replace(/\./g, '')) * 100 + Number(m[2]));
  return [...out];
}

// Datas (com hora, quando vier junto) em milissegundos, no horário de Brasília.
export function datesIn(text) {
  const t = norm(text);
  const dates = [];
  const add = (index, length, y, mo, d) => { if (validDate(y, mo, d)) dates.push({ index, end: index + length, y, mo, d }); };
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) add(m.index, m[0].length, Number(m[3].length === 2 ? `20${m[3]}` : m[3]), Number(m[2]), Number(m[1]));
  for (const m of t.matchAll(/\b(\d{1,2})(?: de)? (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*\.?(?: de)? (\d{4})\b/g)) add(m.index, m[0].length, Number(m[3]), MONTHS[m[2]], Number(m[1]));
  const times = [...t.matchAll(/\b([01]?\d|2[0-3])(?::|h)([0-5]\d)(?::([0-5]\d))?\b/g)].map((m) => ({ index: m.index, h: Number(m[1]), mi: Number(m[2]), se: Number(m[3] || 0) }));
  return dates.map((d) => {
    // hora logo depois da data ("02/10/2026 às 19:47") ou, se só houver uma de cada, a hora que estiver no texto
    const near = times.find((x) => x.index >= d.end && x.index - d.end <= 12) || (dates.length === 1 && times.length === 1 ? times[0] : null);
    return near ? { ms: spMs(d.y, d.mo, d.d, near.h, near.mi, near.se), withTime: true } : { ms: spMs(d.y, d.mo, d.d), withTime: false };
  });
}

// order: { code, total, created_at }. Devolve { ok, reason, amount, code } (reason explica o que faltou).
export function checkReceipt(text, order, now = Date.now()) {
  const cents = Math.round(Number(order.total) * 100);
  const amount = amountsIn(text).includes(cents);
  const code = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').includes(String(order.code).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const created = Date.parse(order.created_at);
  const createdDay = spMs(...new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(created)).split('-').map(Number));
  const dates = datesIn(text);
  const after = dates.some((d) => (d.withTime ? d.ms >= created - TOLERANCE_MS : d.ms >= createdDay) && d.ms <= now + TOLERANCE_MS);
  if (!String(text || '').trim()) return { ok: false, reason: 'não consegui ler o comprovante', amount, code };
  if (!amount && !code) return { ok: false, reason: `não achei o valor do pedido nem o código ${order.code}`, amount, code };
  if (!dates.length) return { ok: false, reason: 'não achei a data do pagamento', amount, code };
  if (!after) return { ok: false, reason: 'a data do pagamento é de antes do pedido', amount, code };
  return { ok: true, reason: amount ? 'valor e data conferidos' : `código ${order.code} e data conferidos`, amount, code };
}
