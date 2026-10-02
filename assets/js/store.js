// Camada de dados única para loja, painel e simulador do bot.
// Dois adaptadores com a mesma interface:
//   - DemoStore: localStorage (sem backend, para testes e apresentação)
//   - SupabaseStore: Postgres + Auth + RLS (produção)
import { CONFIG, IS_DEMO } from './config.js';
import { uid, orderCode, normalizePhone, sha256 } from './utils.js';

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
    { id: uid(), title: 'Chegou o Morango Cravejado 🍓', body: 'Morango fresquinho, chocolate branco e pedacinhos de morango por fora. Edição de lançamento — garanta o seu antes da prova!',
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
    notice: 'Encomendas com 1 dia de antecedência • Retirada no campus',
    pix_key: '',
    bot_greeting: 'Oi! 🎓🍫 Aqui é a Um Doce Até o Diploma.',
  });
  write('subscribers', []);
  write('seeded', true);
}

function buildOrder({ customer_name, phone, items, channel = 'web', status = 'novo', notes = '', created_at }) {
  const total = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const cost_total = items.reduce((s, it) => s + it.qty * it.unit_cost, 0);
  const ts = created_at || new Date().toISOString();
  return { id: uid(), code: orderCode(), customer_name, phone: normalizePhone(phone), items, total, cost_total, channel, status, notes,
    created_at: ts, updated_at: ts };
}

const DemoStore = {
  mode: 'demo',
  async init() { seedDemo(); },

  // Auth local — apenas para demonstração (não é segurança real, os dados estão no próprio navegador).
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

  async placeOrder({ customer_name, phone, items, channel = 'web', notes = '' }) {
    const products = read('products', []);
    const lines = items.map(({ product_id, qty }) => {
      const p = products.find((x) => x.id === product_id && x.active);
      if (!p) throw new Error('Produto indisponível');
      return { product_id, name: p.name, qty: Math.max(1, Math.min(500, Math.floor(qty))), unit_price: p.price, unit_cost: p.cost };
    });
    if (!lines.length) throw new Error('Escolha ao menos um produto');
    const order = buildOrder({ customer_name: customer_name.trim(), phone, items: lines, channel, notes });
    write('orders', [order, ...read('orders', [])]);
    return { code: order.code, total: order.total };
  },
  async listOrders({ since } = {}) {
    const os = read('orders', []);
    return since ? os.filter((o) => o.created_at >= since) : os;
  },
  async updateOrder(id, patch) {
    const os = read('orders', []);
    const o = os.find((x) => x.id === id);
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
    const subs = read('subscribers', []).filter((s) => s.phone !== phone);
    if (on) subs.push({ phone, name, created_at: new Date().toISOString() });
    write('subscribers', subs);
  },
  async listSubscribers() { return read('subscribers', []); },

  async broadcast() {
    return { sent: 0, demo: true };
  },

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

  async placeOrder({ customer_name, phone, items, channel = 'web', notes = '' }) {
    return must(await sb.rpc('place_order', {
      p_name: customer_name, p_phone: normalizePhone(phone), p_items: items, p_channel: channel, p_notes: notes,
    }));
  },
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
  async listSubscribers() { return must(await sb.from('subscribers').select('*')); },

  async broadcast(newsId) {
    if (!CONFIG.BOT_FUNCTION_URL) throw new Error('BOT_FUNCTION_URL não configurada');
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
