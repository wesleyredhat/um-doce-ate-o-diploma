// Regras do cupom de desconto. São as mesmas do banco (coupon_discount e check_coupon em supabase/schema.sql):
// este arquivo serve o modo demonstração, o simulador do bot e os testes (bot/coupons.test.js).
// JavaScript puro, sem dependências: roda no navegador e no Node.

const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',');
// Centavos como o round(x, 2) do Postgres (o 1e-6 evita 3,335 virar 3,33 por erro de ponto flutuante).
const cents = (v) => Math.round((Number(v) || 0) * 100 + 1e-6) / 100;

// Chave da pessoa pelo telefone, com o 9 do celular: o WhatsApp às vezes usa o número antigo, sem o 9.
// 551188887777 e (11) 98888-7777 viram 5511988887777; fixo fica como está.
// Mesma regra de samePhone (bot-engine.js) e de phone_key() no banco.
export function phoneKey(phone) {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`; // sem o código do país
  if (!/^55\d{10}$/.test(d) || !/[6-9]/.test(d[4])) return d;
  return `${d.slice(0, 4)}9${d.slice(4)}`;
}

export const normCode = (code) => String(code ?? '').trim().toUpperCase();

// Hoje (AAAA-MM-DD) no horário de Brasília: a vigência é por dia inteiro.
export const todaySP = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

// Recusas que o cliente precisa ler. Qualquer outro erro vira "tente de novo".
export const isCouponError = (msg) => /^(Cupom |Você já usou|Vale para pedidos)/.test(String(msg ?? ''));

export const couponLabel = (c) => (c.kind === 'percent' ? `${String(Number(c.value)).replace('.', ',')}%` : brl(c.value));

// c: { code, kind: 'percent' | 'fixed', value, min_order, starts_on, ends_on, max_uses, active }
// uses: pedidos não cancelados com este cupom · usedByPhone: este WhatsApp já tem um desses pedidos
export function evaluateCoupon(c, { subtotal = 0, uses = 0, usedByPhone = false, now = Date.now() } = {}) {
  const no = (message) => ({ valid: false, message });
  if (!c) return no('Cupom não encontrado');
  const today = todaySP(now);
  if (!c.active) return no('Cupom pausado');
  if (c.starts_on && today < c.starts_on) return no('Cupom ainda não começou');
  if (c.ends_on && today > c.ends_on) return no('Cupom expirado');
  if (c.max_uses != null && uses >= c.max_uses) return no('Cupom esgotado');
  if (usedByPhone) return no('Você já usou este cupom');
  if (subtotal < Number(c.min_order || 0)) return no(`Vale para pedidos a partir de ${brl(c.min_order)}`);
  const raw = c.kind === 'percent' ? (subtotal * Number(c.value)) / 100 : Number(c.value);
  return { valid: true, discount: cents(Math.min(subtotal, raw)) };
}

// Resposta no mesmo formato de check_coupon() do banco.
export function quoteCoupon(c, { code, subtotal = 0, uses = 0, usedByPhone = false, now = Date.now() } = {}) {
  const base = { code: normCode(code ?? c?.code), label: c ? couponLabel(c) : '', min_order: Number(c?.min_order || 0), subtotal: cents(subtotal) };
  const r = evaluateCoupon(c, { subtotal, uses, usedByPhone, now });
  return r.valid ? { ...base, valid: true, discount: r.discount, total: cents(subtotal - r.discount) } : { ...base, valid: false, message: r.message };
}

// Situação mostrada no painel.
export function couponState(c, uses = 0, now = Date.now()) {
  const today = todaySP(now);
  if (!c.active) return 'pausado';
  if (c.ends_on && today > c.ends_on) return 'expirado';
  if (c.max_uses != null && uses >= c.max_uses) return 'esgotado';
  if (c.starts_on && today < c.starts_on) return 'agendado';
  return 'ativo';
}
