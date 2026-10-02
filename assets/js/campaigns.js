// Campanhas pelo WhatsApp: quem recebe, o texto de cada mensagem e o ritmo de envio.
// JavaScript puro: o painel usa para montar e estimar a campanha, e o bot (bot/sender.js) para enviar.
import { phoneKey } from './coupons.js';

// Ritmo pensado para o WhatsApp comum não bloquear o número. Limite e horário mudam no painel (Campanhas).
export const PACE = { daily_limit: 80, start_hour: 9, end_hour: 20, gap_min_ms: 20e3, gap_max_ms: 60e3 };

export const AUDIENCES = {
  todos: 'Todos os clientes',
  sumidos: 'Sumidos (sem pedir há um tempo)',
  produto: 'Já compraram um produto',
  fieis: '3 pedidos ou mais',
  top: 'Os 20 que mais gastaram',
  inscritos: 'Inscritos nas novidades',
};

// Clientes a partir dos pedidos, igual à view admin_customers do banco (usado no modo demonstração).
export function customersFromOrders(orders, optedOut = new Set()) {
  const by = new Map();
  const valid = orders.filter((o) => o.status !== 'cancelado').sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const o of valid) {
    const k = phoneKey(o.phone);
    const c = by.get(k) || { phone_key: k, orders: 0, spent: 0, first_order: o.created_at, qty: {}, names: {} };
    Object.assign(c, { phone: o.phone, name: o.customer_name, last_order: o.created_at });
    c.orders += 1;
    c.spent += Number(o.total) || 0;
    for (const i of o.items) {
      c.qty[i.product_id] = (c.qty[i.product_id] || 0) + i.qty;
      c.names[i.product_id] = i.name;
    }
    by.set(k, c);
  }
  return [...by.values()].map(({ qty, names, ...c }) => {
    const ids = Object.keys(qty).sort((a, b) => qty[b] - qty[a]);
    return { ...c, spent: Math.round(c.spent * 100) / 100, product_ids: ids, top_products: ids.slice(0, 3).map((id) => names[id]), opted_out: optedOut.has(c.phone_key) };
  });
}

// customers: linhas de admin_customers · subscribers: { phone, name } · f: { type, days, product_id }
// Devolve [{ phone, name, phone_key }] sem repetir a mesma pessoa e sem quem pediu para sair.
export function pickAudience(customers, subscribers, f, now = Date.now()) {
  const allowed = customers.filter((c) => !c.opted_out);
  let list;
  switch (f.type) {
    case 'sumidos': {
      const limit = now - (Number(f.days) || 60) * 864e5;
      list = allowed.filter((c) => new Date(c.last_order).getTime() < limit);
      break;
    }
    case 'produto': list = allowed.filter((c) => (c.product_ids || []).includes(f.product_id)); break;
    case 'fieis': list = allowed.filter((c) => c.orders >= 3); break;
    case 'top': list = [...allowed].sort((a, b) => b.spent - a.spent).slice(0, 20); break;
    case 'inscritos': {
      const byKey = new Map(customers.map((c) => [c.phone_key, c]));
      list = subscribers.map((s) => {
        const k = phoneKey(s.phone);
        return { phone: s.phone, phone_key: k, name: byKey.get(k)?.name || s.name || '', opted_out: !!byKey.get(k)?.opted_out };
      }).filter((s) => !s.opted_out);
      break;
    }
    default: list = allowed;
  }
  const seen = new Set();
  return list
    .map((c) => ({ phone: c.phone, name: c.name || '', phone_key: c.phone_key || phoneKey(c.phone) }))
    .filter((c) => !seen.has(c.phone_key) && seen.add(c.phone_key));
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// {nome} vira o primeiro nome. Sem nome, some junto com a vírgula ("Oi, {nome}!" vira "Oi!").
export function personalize(body, name) {
  const first = firstName(name);
  if (first) return body.replace(/\{nome\}/gi, first);
  return body.replace(/,?[ \t]*\{nome\}/gi, '').replace(/^[\s,!.]+/, '');
}

// Mensagem final: texto + cupom com link (ou link do site) + como sair da lista.
export function campaignText({ body, coupon_code }, name, siteUrl = '') {
  const site = siteUrl ? siteUrl.replace(/\/?$/, '/') : '';
  let t = personalize(body, name).trim();
  if (coupon_code) {
    t += `\n\n🎟️ Cupom *${coupon_code}*`;
    if (site) t += `\nPeça pelo link, o cupom já vai aplicado: ${site}?cupom=${coupon_code}`;
    t += `\nOu responda *cupom ${coupon_code}* por aqui.`;
  } else if (site) {
    t += `\n\nPeça pelo site: ${site}\nOu responda *menu* por aqui.`;
  }
  return `${t}\n\n_Para não receber mais promoções, responda *parar promoções*._`;
}

// Data e hora em Brasília (o computador do bot pode estar em outro fuso).
export function spClock(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

// Brasília não tem horário de verão desde 2019: UTC−3 o ano todo.
export const spDayStart = (now = Date.now()) => Date.parse(`${spClock(now).day}T00:00:00-03:00`);

// Quando termina, no ritmo médio (40 s entre mensagens), respeitando horário e limite do dia.
export function estimateFinish(count, cfg = {}, { now = Date.now(), sentToday = 0 } = {}) {
  const c = { ...PACE, ...cfg };
  const gap = (c.gap_min_ms + c.gap_max_ms) / 2;
  const day0 = spDayStart(now);
  let left = count;
  for (let day = 0; day < 366; day++) {
    const start = Math.max(now, day0 + day * 864e5 + c.start_hour * 36e5);
    const close = day0 + day * 864e5 + c.end_hour * 36e5;
    const room = Math.min(c.daily_limit - (day === 0 ? sentToday : 0), Math.floor((close - start) / gap));
    if (room > 0) {
      if (left <= room) return { days: day, at: start + left * gap };
      left -= room;
    }
  }
  return { days: 366, at: null };
}

export function finishText(count, cfg, opts) {
  const { days, at } = estimateFinish(count, cfg, opts);
  if (at == null) return 'leva mais de um ano no ritmo atual';
  const { day, hour } = spClock(at);
  if (days === 0) return `termina hoje por volta das ${hour}h`;
  if (days === 1) return `termina amanhã por volta das ${hour}h`;
  return `leva ${days + 1} dias, termina dia ${day.slice(8, 10)}/${day.slice(5, 7)} por volta das ${hour}h`;
}
