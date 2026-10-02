// Camada de dados única para loja, painel e simulador do bot.
// Dois adaptadores com a mesma interface:
//   - DemoStore: localStorage (sem backend, para testes e apresentação)
//   - SupabaseStore: Postgres + Auth + RLS (produção)
import { CONFIG, IS_DEMO } from './config.js';
import { uid, orderCode, normalizePhone, sha256 } from './utils.js';
import { quoteCoupon, phoneKey, normCode } from './coupons.js';
import { customersFromOrders } from './campaigns.js';
import { deliveryDates, DELIVERY_MAX_DAYS } from '../../supabase/functions/_shared/delivery.js';

export const STATUSES = [
  { id: 'novo', label: 'Novo', color: 'var(--berry)' },
  { id: 'confirmado', label: 'Confirmado', color: 'var(--caramel)' },
  { id: 'producao', label: 'Em produção', color: 'var(--honey)' },
  { id: 'pronto', label: 'Pronto', color: 'var(--leaf)' },
  { id: 'entregue', label: 'Entregue', color: 'var(--cocoa)' },
  { id: 'cancelado', label: 'Cancelado', color: 'var(--muted)' },
];
export const OPEN_STATUSES = ['novo', 'confirmado', 'producao', 'pronto'];
export const CHANNELS = { web: 'Site', whatsapp: 'WhatsApp', grupo: 'Grupo', balcao: 'Balcão' };

const SEED_PRODUCTS = [
  { name: 'Brigadeiro', category: 'doces', price: 4, cost: 1.35, image: 'assets/img/brigadeiro.jpg', badge: 'O clássico',
    description: 'Chocolate nobre e granulado crocante. O clássico que nunca falha!', featured: false },
  { name: 'Casadinho', category: 'doces', price: 4, cost: 1.5, image: 'assets/img/casadinho.jpg', badge: '',
    description: 'Metade brigadeiro, metade beijinho com toque de morango. Um casamento perfeito.', featured: false },
  { name: 'Caixinha 4 docinhos', category: 'doces', price: 15, cost: 5.9, image: 'assets/img/brigadeiro-casadinho.jpg', badge: 'Mais pedido',
    description: '2 brigadeiros + 2 casadinhos na caixinha. Perfeita para presentear (ou não dividir).', featured: true },
  { name: 'Morango Cravejado', category: 'doces', price: 12, cost: 4.6, image: 'assets/img/morango-cravejado.jpg', badge: 'Novidade',
    description: 'Morango fresco envolto em chocolate branco com pedaços de morango. Crocante por fora, irresistível por dentro!', featured: true },
  { name: 'Empadinha de Frango com Catupiry', category: 'salgados', price: 8, cost: 3.1, image: 'assets/img/empadinha.jpg', badge: '',
    description: 'Massa macia que derrete, recheio bem temperado e muito Catupiry.', featured: true },
];

/* ------------------------------------------------------------------ */
/* Demo                                                                */
/* ------------------------------------------------------------------ */
const LS = 'um-doce-ate-o-diploma:';
const read = (k, fallback) => {
  try {
    const v = localStorage.getItem(LS + k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(LS + k, JSON.stringify(v));
  } catch {}
};

function seedDemo() {
  if (read('seeded', false)) return;
  const products = SEED_PRODUCTS.map((p, i) => ({ id: uid(), active: true, sort: i, ...p }));
  const names = ['Ana Clara', 'Bruno', 'Camila', 'Diego', 'Eduarda', 'Felipe', 'Gabriela', 'Henrique', 'Isabela', 'João Pedro',
    'Larissa', 'Marina', 'Natália', 'Otávio', 'Paula', 'Rafael', 'Sofia', 'Thiago', 'Vitória', 'Yasmin'];
  const orders = [];
  const now = Date.now();
  for (let i = 0; i < 90; i++) {
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.3) * 30);
    const created = new Date(now - daysAgo * 864e5 - Math.random() * 10 * 36e5);
    const n = 1 + Math.floor(Math.random() * 2);
    const items = [];
    for (let j = 0; j < n; j++) {
      const p = products[Math.floor(Math.random() * products.length)];
      if (items.some((it) => it.product_id === p.id)) continue;
      const qty = p.price < 5 ? 2 + Math.floor(Math.random() * 10) : 1 + Math.floor(Math.random() * 3);
      items.push({ product_id: p.id, name: p.name, qty, unit_price: p.price, unit_cost: p.cost });
    }
    const who = names[i % names.length];
    let status = 'entregue';
    if (daysAgo === 0) status = ['novo', 'novo', 'confirmado', 'producao', 'pronto'][i % 5];
    else if (daysAgo === 1) status = ['pronto', 'entregue'][i % 2];
    else if (Math.random() < 0.05) status = 'cancelado';
    orders.push(buildOrder({
      customer_name: who,
      phone: '5511' + String(980000000 + (i % names.length) * 1371).slice(0, 9),
      items,
      channel: ['web', 'web', 'whatsapp', 'whatsapp', 'grupo'][i % 5],
      status,
      created_at: created.toISOString(),
    }));
  }
  orders.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const news = [
    { id: uid(), title: 'Chegou o Morango Cravejado 🍓', body: 'Morango fresquinho, chocolate branco e pedacinhos de morango por fora. Edição de lançamento: garanta o seu antes da prova!',
      image: 'assets/img/morango-cravejado.jpg', channels: ['site', 'whatsapp'], published: true, author: 'Cris', created_at: new Date(now - 2 * 864e5).toISOString() },
    { id: uid(), title: 'Kit Semana de Provas', body: 'Caixinha com 4 docinhos + 1 empadinha por um preço especial. Porque ninguém estuda de estômago vazio.',
      image: 'assets/img/brigadeiro-casadinho.jpg', channels: ['site'], published: true, author: 'Cris', created_at: new Date(now - 6 * 864e5).toISOString() },
  ];
  write('products', products);
  write('orders', orders);
  write('news', news);
  write('bot_admins', [{ id: uid(), phone: '5511999999999', name: 'Cris (dona)', can_post: true, can_manage_orders: true }]);
  write('settings', {
    accepting: true,
    notice: 'Encomendas com 1 dia de antecedência',
    pix_key: '',
    bot_greeting: 'Oi! 🎓🍫 Aqui é a Um Doce Até o Diploma.',
    delivery_spot: { label: 'Na faculdade, em dia de aula', days: [1, 2, 3, 5] },
  });
  write('subscribers', []);
  write('coupons', [{ id: uid(), code: 'VOLTA10', kind: 'percent', value: 10, min_order: 0, starts_on: null, ends_on: null, max_uses: 50, active: true, created_at: new Date(now).toISOString() }]);
  write('optouts', []);
  write('campaigns', []);
  write('campaign_sends', []);
  write('seeded', true);
}

function buildOrder({ customer_name, phone, items, channel = 'web', status = 'novo', notes = '', created_at }) {
  const total = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const cost_total = items.reduce((s, it) => s + it.qty * it.unit_cost, 0);
  const ts = created_at || new Date().toISOString();
  return { id: uid(), code: orderCode(), customer_name, phone: normalizePhone(phone), items, total, cost_total, channel, status, notes,
    created_at: ts, updated_at: ts, coupon_code: null, discount: 0, delivery: 'combinar', delivery_date: null, paid: false };
}

const DemoStore = {
  mode: 'demo',
  async init() { seedDemo(); },

  // Auth local, apenas para demonstração (não é segurança real, os dados estão no próprio navegador).
  async signIn(email, password) {
    const ok = email.trim().toLowerCase() === CONFIG.DEMO_ADMIN.email && (await sha256(password)) === CONFIG.DEMO_ADMIN.passwordHash;
    if (!ok) throw new Error('E-mail ou senha inválidos');
    const user = { email, name: 'Administradora' };
    sessionStorage.setItem(LS + 'session', JSON.stringify(user));
    return user;
  },
  async signOut() { sessionStorage.removeItem(LS + 'session'); },
  async getUser() {
    try { return JSON.parse(sessionStorage.getItem(LS + 'session')); } catch { return null; }
  },

  async listProducts({ all = false } = {}) {
    const ps = read('products', []).sort((a, b) => a.sort - b.sort);
    return all ? ps : ps.filter((p) => p.active);
  },
  async saveProduct(p) {
    const ps = read('products', []);
    const i = ps.findIndex((x) => x.id === p.id);
    if (i >= 0) ps[i] = { ...ps[i], ...p };
    else ps.push({ id: uid(), active: true, featured: false, sort: ps.length, ...p });
    write('products', ps);
  },
  async deleteProduct(id) { write('products', read('products', []).filter((p) => p.id !== id)); },

  async placeOrder({ customer_name, phone, items, channel = 'web', notes = '', coupon = null, delivery = 'combinar', delivery_date = null, paid = false }) {
    const products = read('products', []);
    const lines = items.map(({ product_id, qty }) => {
      const p = products.find((x) => x.id === product_id && x.active);
      if (!p) throw new Error('Produto indisponível');
      return { product_id, name: p.name, qty: Math.max(1, Math.min(500, Math.floor(qty))), unit_price: p.price, unit_cost: p.cost };
    });
    if (!lines.length) throw new Error('Escolha ao menos um produto');
    const order = buildOrder({ customer_name: customer_name.trim(), phone, items: lines, channel, notes });
    order.paid = !!paid; // demonstração: quem chama é sempre o painel
    // Mesma regra de place_order: um dos dias marcados em Ajustes, de amanhã até 14 dias.
    if (delivery === 'ponto') {
      if (!deliveryDates(read('settings', {}), Date.now(), DELIVERY_MAX_DAYS).includes(delivery_date)) throw new Error('Escolha um dos dias de entrega disponíveis');
      Object.assign(order, { delivery, delivery_date });
    }
    const subtotal = order.total;
    if (normCode(coupon)) {
      const q = await this.checkCoupon(coupon, phone, items);
      if (!q.valid) throw new Error(q.message);
      Object.assign(order, { coupon_code: q.code, discount: q.discount, total: q.total });
    }
    write('orders', [order, ...read('orders', [])]);
    return { code: order.code, total: order.total, subtotal, discount: order.discount, coupon: order.coupon_code, delivery: order.delivery, delivery_date: order.delivery_date };
  },
  async checkCoupon(code, phone = '', items = []) {
    const c = read('coupons', []).find((x) => x.code === normCode(code));
    const products = read('products', []);
    const subtotal = items.reduce((s, i) => {
      const p = products.find((x) => x.id === i.product_id && x.active);
      return s + (p ? Math.max(1, Math.min(500, Math.floor(i.qty))) * p.price : 0);
    }, 0);
    const used = c ? read('orders', []).filter((o) => o.coupon_code === c.code && o.status !== 'cancelado') : [];
    const key = phoneKey(phone);
    return quoteCoupon(c, { code, subtotal, uses: used.length, usedByPhone: !!key && used.some((o) => phoneKey(o.phone) === key) });
  },
  async listCustomers() {
    return customersFromOrders(read('orders', []), new Set(read('optouts', []).map((o) => o.phone_key)), read('loyalty_rewards', []));
  },
  // Brinde da Carteirinha do Formando entregue (order_id: o pedido em que foi junto, se houver).
  async giveReward({ phone_key, order_id = null }) {
    write('loyalty_rewards', [...read('loyalty_rewards', []), { id: uid(), phone_key, order_id, given_at: new Date().toISOString() }]);
  },
  async listOrders({ since } = {}) {
    const os = read('orders', []);
    return since ? os.filter((o) => o.created_at >= since) : os;
  },
  async updateOrder(id, patch) {
    const os = read('orders', []);
    const o = os.find((x) => x.id === id);
    // Igual ao gatilho orders_coupon_reopen do banco: reabrir não pode furar a cota nem o "uma vez por WhatsApp".
    if (o?.coupon_code && o.status === 'cancelado' && patch.status && patch.status !== 'cancelado') {
      const c = read('coupons', []).find((x) => x.code === o.coupon_code);
      const others = os.filter((x) => x.id !== o.id && x.coupon_code === o.coupon_code && x.status !== 'cancelado');
      if (c?.max_uses != null && others.length >= c.max_uses) throw new Error(`Não dá para reabrir: o cupom ${o.coupon_code} esgotou depois do cancelamento`);
      if (others.some((x) => phoneKey(x.phone) === phoneKey(o.phone))) throw new Error(`Não dá para reabrir: este WhatsApp já usou o cupom ${o.coupon_code} em outro pedido`);
    }
    if (o) Object.assign(o, patch, { updated_at: new Date().toISOString() });
    write('orders', os);
  },
  async loyalty(phone) {
    const p = normalizePhone(phone);
    return read('orders', []).filter((o) => o.phone === p && o.status === 'entregue').length;
  },

  async listNews({ all = false } = {}) {
    const ns = read('news', []).sort((a, b) => b.created_at.localeCompare(a.created_at));
    return all ? ns : ns.filter((n) => n.published && n.channels.includes('site'));
  },
  async saveNews(n) {
    const ns = read('news', []);
    const i = ns.findIndex((x) => x.id === n.id);
    if (i >= 0) ns[i] = { ...ns[i], ...n };
    else ns.unshift({ id: uid(), created_at: new Date().toISOString(), published: true, channels: ['site'], ...n });
    write('news', ns);
    return i >= 0 ? ns[i] : ns[0];
  },
  async deleteNews(id) { write('news', read('news', []).filter((n) => n.id !== id)); },

  async listBotAdmins() { return read('bot_admins', []); },
  async saveBotAdmin(a) {
    const as = read('bot_admins', []);
    const rec = { ...a, phone: normalizePhone(a.phone) };
    const i = as.findIndex((x) => x.id === a.id);
    if (i >= 0) as[i] = { ...as[i], ...rec };
    else as.push({ id: uid(), can_post: true, can_manage_orders: false, ...rec });
    write('bot_admins', as);
  },
  async deleteBotAdmin(id) { write('bot_admins', read('bot_admins', []).filter((a) => a.id !== id)); },

  async getSettings() { return read('settings', {}); },
  async saveSettings(s) { write('settings', { ...read('settings', {}), ...s }); },

  // Usado pelo simulador do bot
  async getBotSession(phone) { return read('bot_sessions', {})[phone] || null; },
  async saveBotSession(phone, data) {
    const all = read('bot_sessions', {});
    if (data) all[phone] = data;
    else delete all[phone];
    write('bot_sessions', all);
  },
  async subscribe(phone, name, on = true) {
    const key = phoneKey(phone);
    const subs = read('subscribers', []).filter((s) => s.phone !== phone);
    const outs = read('optouts', []).filter((o) => o.phone_key !== key);
    if (on) subs.push({ phone, name, created_at: new Date().toISOString() });
    else outs.push({ phone_key: key, phone, created_at: new Date().toISOString() });
    write('subscribers', subs);
    write('optouts', outs);
  },
  async listSubscribers() { return read('subscribers', []); },

  async botStatus() { return null; },

  async broadcast() {
    return { sent: 0, demo: true };
  },

  async listCoupons() { return read('coupons', []).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async saveCoupon(c) {
    const cs = read('coupons', []);
    const { id, ...rec } = 'code' in c ? { ...c, code: normCode(c.code) } : c;
    if (rec.code && cs.some((x) => x.code === rec.code && x.id !== id)) throw new Error('Já existe um cupom com esse código');
    const i = cs.findIndex((x) => x.id === id);
    if (i >= 0) cs[i] = { ...cs[i], ...rec };
    else cs.push({ id: uid(), kind: 'percent', min_order: 0, starts_on: null, ends_on: null, max_uses: null, active: true, created_at: new Date().toISOString(), ...rec });
    write('coupons', cs);
  },

  async listCampaigns() {
    const sends = read('campaign_sends', []);
    const coupons = read('coupons', []);
    return read('campaigns', []).map((c) => ({ ...c, coupon_code: coupons.find((x) => x.id === c.coupon_id)?.code || null, sends: sends.filter((s) => s.campaign_id === c.id) }));
  },
  // Modo demonstração: nada é enviado de verdade, então a campanha já nasce concluída.
  async createCampaign({ name, body, coupon_id = null, audience, recipients }) {
    const outs = new Set(read('optouts', []).map((o) => o.phone_key));
    const now = new Date().toISOString();
    const c = { id: uid(), name, body, coupon_id, audience, status: 'concluida', pause_reason: null, created_at: now, finished_at: now };
    const sends = recipients.map((r) => ({
      id: uid(), campaign_id: c.id, phone: r.phone, phone_key: phoneKey(r.phone), name: r.name || '',
      status: outs.has(phoneKey(r.phone)) ? 'pulada' : 'enviada', error: null, claimed_at: now, sent_at: now,
    }));
    write('campaigns', [c, ...read('campaigns', [])]);
    write('campaign_sends', [...read('campaign_sends', []), ...sends]);
    return c;
  },
  async setCampaignStatus(id, status) {
    write('campaigns', read('campaigns', []).map((c) => (c.id === id ? { ...c, status, pause_reason: null } : c)));
  },
  async getCampaignSettings() { return read('campaign_settings', {}); },
  async saveCampaignSettings(s) { write('campaign_settings', { ...read('campaign_settings', {}), ...s }); },

  resetDemo() {
    Object.keys(localStorage).filter((k) => k.startsWith(LS)).forEach((k) => localStorage.removeItem(k));
  },
};

/* ------------------------------------------------------------------ */
/* Supabase                                                            */
/* ------------------------------------------------------------------ */
let sb;
const must = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data;
};
// A API devolve no máximo 1000 linhas por vez: lê de 1000 em 1000 até acabar.
async function allRows(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await query().range(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const SupabaseStore = {
  mode: 'supabase',
  async init() {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
    sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  },

  async signIn(email, password) {
    const { user } = must(await sb.auth.signInWithPassword({ email, password }));
    const isAdmin = must(await sb.rpc('is_admin'));
    if (!isAdmin) {
      await sb.auth.signOut();
      throw new Error('Este usuário não tem acesso ao painel');
    }
    return user;
  },
  async signOut() { await sb.auth.signOut(); },
  async getUser() {
    const { data } = await sb.auth.getSession();
    return data.session?.user ?? null;
  },

  async listProducts({ all = false } = {}) {
    let q = sb.from('products').select('*').order('sort');
    if (!all) q = q.eq('active', true);
    return must(await q);
  },
  async saveProduct(p) {
    must(await (p.id ? sb.from('products').update(p).eq('id', p.id) : sb.from('products').insert(p)));
  },
  async deleteProduct(id) { must(await sb.from('products').delete().eq('id', id)); },

  async placeOrder({ customer_name, phone, items, channel = 'web', notes = '', coupon = null, delivery = 'combinar', delivery_date = null, paid = false }) {
    // Sem cupom e sem entrega no ponto, a chamada é a mesma de antes do schema novo: pedido continua funcionando enquanto o banco não é atualizado.
    const args = { p_name: customer_name, p_phone: normalizePhone(phone), p_items: items, p_channel: channel, p_notes: notes };
    if (normCode(coupon)) args.p_coupon = normCode(coupon);
    if (delivery === 'ponto') Object.assign(args, { p_delivery: 'ponto', p_delivery_date: delivery_date });
    if (paid) args.p_paid = true; // só vale para a loja (place_order confere is_admin)
    return must(await sb.rpc('place_order', args));
  },
  async checkCoupon(code, phone = '', items = []) {
    return must(await sb.rpc('check_coupon', { p_code: code, p_phone: phone ? normalizePhone(phone) : '', p_items: items }));
  },
  async listCustomers() { return allRows(() => sb.from('admin_customers').select('*').order('phone_key')); },
  async giveReward({ phone_key, order_id = null }) { must(await sb.from('loyalty_rewards').insert({ phone_key, order_id })); },
  async listOrders({ since } = {}) {
    let q = sb.from('orders').select('*').order('created_at', { ascending: false }).limit(2000);
    if (since) q = q.gte('created_at', since);
    return must(await q);
  },
  async updateOrder(id, patch) { must(await sb.from('orders').update(patch).eq('id', id)); },
  async loyalty(phone) { return must(await sb.rpc('loyalty_stamps', { p_phone: normalizePhone(phone) })); },

  async listNews({ all = false } = {}) {
    let q = sb.from('news').select('*').order('created_at', { ascending: false });
    if (!all) q = q.eq('published', true).contains('channels', ['site']);
    return must(await q);
  },
  async saveNews(n) {
    const q = n.id ? sb.from('news').update(n).eq('id', n.id) : sb.from('news').insert(n);
    return must(await q.select().single());
  },
  async deleteNews(id) { must(await sb.from('news').delete().eq('id', id)); },

  async listBotAdmins() { return must(await sb.from('bot_admins').select('*').order('name')); },
  async saveBotAdmin(a) {
    const rec = { ...a, phone: normalizePhone(a.phone) };
    must(await (a.id ? sb.from('bot_admins').update(rec).eq('id', a.id) : sb.from('bot_admins').insert(rec)));
  },
  async deleteBotAdmin(id) { must(await sb.from('bot_admins').delete().eq('id', id)); },

  async getSettings() {
    const row = must(await sb.from('settings').select('value').eq('key', 'store').maybeSingle());
    return row?.value ?? {};
  },
  async saveSettings(s) {
    const cur = await this.getSettings();
    must(await sb.from('settings').upsert({ key: 'store', value: { ...cur, ...s } }));
  },

  // O simulador do bot no painel roda em memória no modo produção (não grava sessões reais).
  _sessions: {},
  async getBotSession(phone) { return this._sessions[phone] || null; },
  async saveBotSession(phone, data) { if (data) this._sessions[phone] = data; else delete this._sessions[phone]; },
  async subscribe() {},
  async listSubscribers() { return allRows(() => sb.from('subscribers').select('*').order('phone')); },

  async listCoupons() { return must(await sb.from('coupons').select('*').order('created_at', { ascending: false })); },
  async saveCoupon(c) {
    const { id, ...rec } = 'code' in c ? { ...c, code: normCode(c.code) } : c;
    const { error } = await (id ? sb.from('coupons').update(rec).eq('id', id) : sb.from('coupons').insert(rec));
    if (error) throw new Error(error.code === '23505' ? 'Já existe um cupom com esse código' : error.message);
  },

  async listCampaigns() {
    const rows = must(await sb.from('campaigns').select('*, coupons(code), campaign_sends(id, phone, name, status, error, sent_at)')
      .order('created_at', { ascending: false }).limit(50));
    return rows.map(({ coupons, campaign_sends, ...c }) => ({ ...c, coupon_code: coupons?.code || null, sends: campaign_sends || [] }));
  },
  // Nasce pausada e só vai para "enviando" com a lista inteira gravada: o bot nunca pega uma campanha pela metade.
  async createCampaign({ name, body, coupon_id = null, audience, recipients }) {
    const c = must(await sb.from('campaigns').insert({ name, body, coupon_id, audience, status: 'pausada' }).select().single());
    const rows = recipients.map((r) => ({ campaign_id: c.id, phone: r.phone, phone_key: phoneKey(r.phone), name: r.name || '' }));
    const { error } = await sb.from('campaign_sends').insert(rows);
    if (error) {
      await sb.from('campaigns').delete().eq('id', c.id);
      throw new Error(error.message);
    }
    must(await sb.from('campaigns').update({ status: 'enviando' }).eq('id', c.id));
    return c;
  },
  async setCampaignStatus(id, status) { must(await sb.from('campaigns').update({ status, pause_reason: null }).eq('id', id)); },
  async getCampaignSettings() {
    const row = must(await sb.from('settings').select('value').eq('key', 'campaigns').maybeSingle());
    return row?.value ?? {};
  },
  async saveCampaignSettings(s) {
    must(await sb.from('settings').upsert({ key: 'campaigns', value: { ...(await this.getCampaignSettings()), ...s } }));
  },

  // Bot por QR Code (pasta bot/): ele busca sozinho as novidades com canal WhatsApp ainda não enviadas.
  async botStatus() {
    const row = must(await sb.from('settings').select('value').eq('key', 'bot').maybeSingle());
    return row?.value || null;
  },

  async broadcast(newsId) {
    if (!CONFIG.BOT_FUNCTION_URL) return { queued: true };
    const { data } = await sb.auth.getSession();
    const res = await fetch(`${CONFIG.BOT_FUNCTION_URL}/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
      body: JSON.stringify({ news_id: newsId }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },
};

export const store = IS_DEMO ? DemoStore : SupabaseStore;
export const ready = store.init();
