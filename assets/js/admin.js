import { CONFIG, IS_DEMO } from './config.js';
import { store, ready, STATUSES, OPEN_STATUSES, CHANNELS } from './store.js';
import { icon, hydrateIcons } from './icons.js';
import { stackedBars, donut, attachTips } from './charts.js';
import { handleMessage } from '../../supabase/functions/_shared/bot-engine.js';
import {
  $, $$, esc, money, pct, margin, fmtDate, fmtDateTime, timeAgo, startOfDay, formatPhone, normalizePhone,
  waLink, toast, maskPhoneInput, isValidPhone,
} from './utils.js';

const S = { orders: [], products: [], news: [], settings: {}, admins: [], user: null, seen: new Set(), view: 'inicio' };
const VIEWS = {
  inicio: ['Início', viewHome],
  pedidos: ['Pedidos', viewOrders],
  producao: ['Produção', viewProduction],
  produtos: ['Produtos', viewProducts],
  financeiro: ['Financeiro', viewFinance],
  novidades: ['Novidades', viewNews],
  bot: ['Bot WhatsApp', viewBot],
  ajustes: ['Ajustes', viewSettings],
};
const NEXT = { novo: 'confirmado', confirmado: 'producao', producao: 'pronto', pronto: 'entregue' };
const NEXT_LABEL = { novo: 'Confirmar', confirmado: 'Produzir', producao: 'Pronto', pronto: 'Entregue' };
const st = (id) => STATUSES.find((s) => s.id === id) || STATUSES[0];
const prodById = (id) => S.products.find((p) => p.id === id);
const marginClass = (m) => (m >= 55 ? 'good' : m >= 35 ? 'ok' : 'bad');
let viewAC;

hydrateIcons();
boot();

/* =================================================================== */
/* Auth                                                                 */
/* =================================================================== */
async function boot() {
  await ready;
  S.user = await store.getUser();
  if (S.user) return enterApp();
  showLogin();
}

function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginDemo').hidden = !IS_DEMO;
  const f = $('#loginForm');
  f.email.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button');
    btn.disabled = true;
    $('#loginErr').textContent = '';
    try {
      S.user = await store.signIn(f.email.value, f.password.value);
      f.reset();
      enterApp();
    } catch (ex) {
      $('#loginErr').textContent = ex.message || 'Não foi possível entrar';
    } finally {
      btn.disabled = false;
    }
  };
}

async function enterApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#modeBadge').textContent = IS_DEMO ? '● Modo demonstração' : '● Conectado ao Supabase';
  $('#modeBadge').className = `mode ${IS_DEMO ? 'mode--demo' : 'mode--live'}`;
  $('#today').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  await loadAll();
  S.orders.forEach((o) => S.seen.add(o.id));
  addEventListener('hashchange', route);
  route();
  setInterval(poll, 30000);
}

$('#logoutBtn').addEventListener('click', async () => {
  await store.signOut();
  location.hash = '';
  location.reload();
});
$('#refreshBtn').addEventListener('click', async () => { await loadAll(); render(); toast('Atualizado'); });
$('#newOrderBtn').addEventListener('click', () => orderDialog());
$('#moreBtn').addEventListener('click', () => {
  openDialog(`<h2>Mais</h2><div class="more-grid">
    ${['produtos', 'novidades', 'bot', 'ajustes'].map((v) => `<a href="#${v}" data-close>${icon({ produtos: 'box', novidades: 'news', bot: 'bot', ajustes: 'gear' }[v])} ${VIEWS[v][0]}</a>`).join('')}
    <a href="./" target="_blank">${icon('ext')} Ver loja</a>
    <button id="mLogout">${icon('logout')} Sair</button></div>`, (m) => {
    $('#mLogout', m).onclick = () => $('#logoutBtn').click();
  });
});

async function loadAll() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString();
  [S.orders, S.products, S.news, S.settings, S.admins] = await Promise.all([
    store.listOrders({ since }), store.listProducts({ all: true }), store.listNews({ all: true }), store.getSettings(), store.listBotAdmins(),
  ]);
  updateNewPill();
}

async function poll() {
  if (document.hidden) return;
  try {
    const before = new Set(S.orders.map((o) => o.id));
    S.orders = await store.listOrders({ since: new Date(Date.now() - 400 * 864e5).toISOString() });
    const fresh = S.orders.filter((o) => !before.has(o.id));
    if (fresh.length) {
      chime();
      toast(`🔔 ${fresh.length} novo(s) pedido(s)! ${fresh[0].customer_name}`);
      if (['inicio', 'pedidos', 'producao'].includes(S.view)) render();
    }
    updateNewPill();
  } catch (e) { console.warn(e); }
}

function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.14);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + i * 0.14 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.14 + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.14);
      o.stop(ctx.currentTime + i * 0.14 + 0.55);
    });
  } catch {}
}

function updateNewPill() {
  const n = S.orders.filter((o) => o.status === 'novo').length;
  const pill = $('#navNew');
  pill.hidden = !n;
  pill.textContent = n;
  document.title = n ? `(${n}) Painel da Confeiteira` : 'Painel da Confeiteira';
}

/* =================================================================== */
/* Roteamento                                                           */
/* =================================================================== */
function route() {
  const v = location.hash.slice(1);
  S.view = VIEWS[v] ? v : 'inicio';
  render();
}

function render() {
  viewAC?.abort();
  viewAC = new AbortController();
  const [title, fn] = VIEWS[S.view];
  $('#viewTitle').textContent = title;
  $$('[data-view]').forEach((a) => (a.dataset.view === S.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  const view = $('#view');
  view.style.animation = 'none';
  void view.offsetWidth;
  view.style.animation = '';
  fn(view, viewAC.signal);
  attachTips(view);
  scrollTo({ top: 0 });
}

const on = (root, signal, evt, sel, fn) =>
  root.addEventListener(evt, (e) => { const t = e.target.closest(sel); if (t && root.contains(t)) fn(t, e); }, { signal });

/* =================================================================== */
/* Dialog                                                               */
/* =================================================================== */
function openDialog(html, mount, { wide = false } = {}) {
  const dlg = $('#dlg');
  const body = $('#dlgBody');
  body.className = `modal ${wide ? 'modal--wide' : ''}`;
  body.innerHTML = `<button class="icon-btn modal__x" data-close aria-label="Fechar">${icon('x')}</button>${html}`;
  // Sem "return false": um onclick que devolve false cancela o clique (salvar, marcar, links dentro da janela).
  body.onclick = (e) => { if (e.target.closest('[data-close]')) dlg.close(); };
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
  dlg.showModal();
  mount?.(body, () => dlg.close());
}

/* =================================================================== */
/* Métricas                                                             */
/* =================================================================== */
function inRange(from, to = new Date()) {
  return S.orders.filter((o) => o.status !== 'cancelado' && new Date(o.created_at) >= from && new Date(o.created_at) < to);
}
function sums(list) {
  const revenue = list.reduce((s, o) => s + Number(o.total), 0);
  const cost = list.reduce((s, o) => s + Number(o.cost_total), 0);
  return { revenue, cost, profit: revenue - cost, count: list.length, margin: revenue ? ((revenue - cost) / revenue) * 100 : 0, ticket: list.length ? revenue / list.length : 0 };
}
function dailySeries(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d0 = startOfDay(new Date(Date.now() - i * 864e5));
    const d1 = new Date(d0.getTime() + 864e5);
    out.push({ d: d0, ...sums(inRange(d0, d1)) });
  }
  return out;
}
const delta = (a, b) => (b ? ((a - b) / b) * 100 : a ? 100 : 0);
const deltaTag = (d) => `<span class="${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${pct(Math.abs(d))}</span>`;

function kpi(label, value, sub = '', iconName = '', dark = false) {
  return `<div class="kpi ${dark ? 'kpi--dark' : ''}"><span class="kpi__label">${iconName ? icon(iconName) : ''}${label}</span><span class="kpi__value">${value}</span><span class="kpi__sub">${sub}</span></div>`;
}

function revenueChart(series, everyLabel, share = 1) {
  // largura real em px para o texto do eixo não escalar
  const width = ($('#view').clientWidth || 640) * (innerWidth >= 1100 ? share : 1) - 44;
  return `${stackedBars({
    width,
    height: Math.min(260, Math.max(180, width * 0.32)),
    labels: series.map((s) => s.d.toLocaleDateString('pt-BR', { day: '2-digit', month: series.length > 31 ? 'short' : undefined }).replace('.', '')),
    series: [
      { name: 'Custo', color: 'var(--latte)', values: series.map((s) => s.cost) },
      { name: 'Lucro', color: 'var(--choc)', values: series.map((s) => s.profit) },
    ],
    tips: series.map((s) => `<b>${s.d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })}</b><br>Faturamento ${money(s.revenue)}<br>Lucro ${money(s.profit)} · ${s.count} pedido(s)`),
    fmtAxis: (v) => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k` : Math.round(v)),
    everyLabel,
  })}
  <div class="legend"><span><i style="background:var(--choc)"></i>Lucro</span><span><i style="background:var(--latte)"></i>Custo</span><span>Altura total = faturamento</span></div>`;
}

/* =================================================================== */
/* Início                                                               */
/* =================================================================== */
function viewHome(v, signal) {
  const today = startOfDay();
  const yest = new Date(today.getTime() - 864e5);
  const t = sums(inRange(today));
  const y = sums(inRange(yest, today));
  const open = S.orders.filter((o) => OPEN_STATUSES.includes(o.status));
  const toMake = open.filter((o) => o.status !== 'pronto').reduce((s, o) => s + o.items.reduce((a, i) => a + i.qty, 0), 0);
  const month = sums(inRange(new Date(today.getFullYear(), today.getMonth(), 1)));
  const h = new Date().getHours();
  const hello = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const series = dailySeries(14);
  const last30 = inRange(new Date(Date.now() - 30 * 864e5));
  const byCh = Object.keys(CHANNELS).map((k, i) => ({ label: CHANNELS[k], value: last30.filter((o) => o.channel === k).length, color: ['var(--berry)', '#3f9a5d', '#8fc49c', 'var(--caramel)'][i] }));
  const top = productRank(last30).slice(0, 4);

  v.innerHTML = `
    <p class="greet">${hello}, ${esc((S.user?.name || S.user?.email || 'Cris').split(/[ @]/)[0])} ${h < 18 ? '☀️' : '🌙'}</p>
    <div class="kpis">
      ${kpi('Pedidos hoje', t.count, `${deltaTag(delta(t.count, y.count))} vs ontem`, 'bag')}
      ${kpi('Faturamento hoje', money(t.revenue), `${deltaTag(delta(t.revenue, y.revenue))} vs ontem`, 'cash')}
      ${kpi('Lucro no mês', money(month.profit), `margem ${pct(month.margin)}`, 'chart', true)}
      ${kpi('A produzir agora', `${toMake} un`, `${open.length} pedido(s) em aberto`, 'chef')}
    </div>
    <div class="cols cols--2">
      <section class="panel"><div class="panel__head"><h2>Últimos 14 dias</h2><a class="btn btn--soft btn--sm" href="#financeiro">Financeiro ${icon('right')}</a></div>${revenueChart(series, 2, 0.6)}</section>
      <section class="panel"><div class="panel__head"><h2>De onde vêm os pedidos</h2><p>30 dias</p></div>
        <div class="donut-wrap">${donut(byCh, { center: String(last30.length) })}
          <ul>${byCh.map((c) => `<li><span class="dot" style="background:${c.color}"></span>${c.label}<b>${c.value}</b></li>`).join('')}</ul></div>
        <h2 style="font-family:var(--f-display);font-size:1rem;margin:20px 0 10px;color:var(--choc)">Mais vendidos</h2>
        ${top.map((p) => `<div class="prod-cell" style="margin-bottom:8px">${p.image ? `<img src="${esc(p.image)}" alt="">` : ''}<span style="flex:1">${esc(p.name)}<br><small style="color:var(--muted)">${p.units} un · ${money(p.revenue)}</small></span></div>`).join('') || '<p class="hint">Sem vendas ainda.</p>'}
      </section>
    </div>
    <section class="panel"><div class="panel__head"><h2>Pedidos em aberto</h2><a class="btn btn--soft btn--sm" href="#pedidos">Ver quadro ${icon('right')}</a></div>
      ${open.length ? `<div class="board" style="grid-auto-flow:row;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))">${open.slice(0, 6).map(orderCard).join('')}</div>` : emptyState('Tudo em dia!', 'Nenhum pedido em aberto.')}
    </section>`;
  wireOrderActions(v, signal);
}

function emptyState(title, text) {
  return `<div class="empty"><span class="script">${title}</span>${text}</div>`;
}

/* =================================================================== */
/* Pedidos                                                              */
/* =================================================================== */
const OF = { channel: 'all', q: '', showDone: false };

function orderCard(o) {
  const s = st(o.status);
  const fresh = !S.seen.has(o.id);
  return `<article class="ocard ${fresh ? 'fresh' : ''}" style="--st:${s.color}" draggable="true" data-id="${o.id}">
    <div class="ocard__top"><span class="ocard__code">${esc(o.code)}</span><span class="ch ch--${o.channel}">${CHANNELS[o.channel] || o.channel}</span><span class="ocard__time" title="${fmtDateTime(o.created_at)}">${timeAgo(o.created_at)}</span></div>
    <div class="ocard__who">${esc(o.customer_name)} <a href="${waLink('', o.phone)}" target="_blank" rel="noopener" style="font-weight:600;font-size:.82rem;color:var(--ink-soft)">${formatPhone(o.phone)}</a></div>
    <ul>${o.items.map((i) => `<li>${i.qty}× ${esc(i.name)}</li>`).join('')}</ul>
    ${o.notes ? `<div class="ocard__notes">📝 ${esc(o.notes)}</div>` : ''}
    <div class="ocard__foot">
      <span class="ocard__total">${money(o.total)}</span>
      <a class="icon-btn" href="${notifyLink(o)}" target="_blank" rel="noopener" title="Avisar no WhatsApp" aria-label="Avisar no WhatsApp">${icon('wa')}</a>
      ${o.status !== 'cancelado' && o.status !== 'entregue' ? `<button class="icon-btn" data-cancel="${o.id}" title="Cancelar" aria-label="Cancelar">${icon('x')}</button>` : ''}
      ${NEXT[o.status] ? `<button class="btn btn--sm" data-next="${o.id}">${NEXT_LABEL[o.status]} ${icon('right')}</button>` : o.status === 'cancelado' ? `<button class="btn btn--soft btn--sm" data-reopen="${o.id}">Reabrir</button>` : ''}
    </div>
  </article>`;
}

function notifyLink(o) {
  const first = o.customer_name.split(' ')[0];
  const items = o.items.map((i) => `• ${i.qty}x ${i.name}`).join('\n');
  const pix = S.settings.pix_key ? `\n💸 Pix: ${S.settings.pix_key}` : '';
  const stamps = S.orders.filter((x) => x.phone === o.phone && x.status === 'entregue').length + (o.status === 'entregue' ? 0 : 1);
  const msg = {
    novo: `Oi, ${first}! Recebemos seu pedido *${o.code}* 🎓\n${items}\nTotal: *${money(o.total)}*${pix}\n\nPosso confirmar?`,
    confirmado: `Oi, ${first}! Pedido *${o.code}* confirmado ✅\n${items}\nTotal: *${money(o.total)}*${pix}`,
    producao: `Oi, ${first}! Seu pedido *${o.code}* já está no forno 👩‍🍳💛`,
    pronto: `Oi, ${first}! Seu pedido *${o.code}* está prontinho 🎓🍫 Vamos combinar a entrega?`,
    entregue: `Obrigada pelo pedido, ${first}! 💛 Você está com ${stamps % CONFIG.LOYALTY_GOAL || CONFIG.LOYALTY_GOAL}/${CONFIG.LOYALTY_GOAL} capelos na Carteirinha do Formando.`,
    cancelado: `Oi, ${first}! Sobre o pedido *${o.code}*: `,
  }[o.status];
  return waLink(msg, o.phone);
}

async function setStatus(id, status) {
  const o = S.orders.find((x) => x.id === id);
  if (!o) return;
  const prev = o.status;
  o.status = status;
  try {
    await store.updateOrder(id, { status });
    S.seen.add(id);
    updateNewPill();
    render();
    if (status === 'pronto' || status === 'confirmado') {
      toast(`${o.code} → ${st(status).label}. Avise no WhatsApp 💬`);
    }
  } catch (e) {
    o.status = prev;
    toast(e.message, 'err');
  }
}

function wireOrderActions(root, signal) {
  on(root, signal, 'click', '[data-next]', (b) => setStatus(b.dataset.next, NEXT[S.orders.find((o) => o.id === b.dataset.next).status]));
  on(root, signal, 'click', '[data-reopen]', (b) => setStatus(b.dataset.reopen, 'novo'));
  on(root, signal, 'click', '[data-cancel]', (b) => {
    const o = S.orders.find((x) => x.id === b.dataset.cancel);
    openDialog(`<h2>Cancelar ${esc(o.code)}?</h2><p>${esc(o.customer_name)} · ${money(o.total)}</p><div class="form__actions"><button class="btn btn--ghost" data-close>Voltar</button><button class="btn btn--berry" id="cx">Cancelar pedido</button></div>`,
      (m, close) => ($('#cx', m).onclick = () => { close(); setStatus(o.id, 'cancelado'); }));
  });
  on(root, signal, 'mouseover', '.ocard.fresh', (c) => { S.seen.add(c.dataset.id); c.classList.remove('fresh'); });
}

function viewOrders(v, signal) {
  const cols = OF.showDone ? STATUSES : STATUSES.filter((s) => OPEN_STATUSES.includes(s.id));
  const q = OF.q.toLowerCase();
  const list = S.orders.filter((o) =>
    (OF.channel === 'all' || o.channel === OF.channel) &&
    (!q || o.code.toLowerCase().includes(q) || o.customer_name.toLowerCase().includes(q) || o.phone.includes(q.replace(/\D/g, '') || '§')));

  v.innerHTML = `
    <div class="toolbar">
      <input class="input" type="search" id="oq" placeholder="Buscar por nome, código ou telefone" value="${esc(OF.q)}" />
      <div class="chips" role="group" aria-label="Canal">
        ${[['all', 'Todos'], ...Object.entries(CHANNELS)].map(([k, l]) => `<button class="chip" aria-pressed="${OF.channel === k}" data-ch="${k}">${l}</button>`).join('')}
      </div>
      <label class="switch"><input type="checkbox" id="showDone" ${OF.showDone ? 'checked' : ''}/><i></i>Entregues e cancelados</label>
    </div>
    <p class="hint no-print">Arraste os cartões entre colunas ou use o botão de avançar. O ícone do WhatsApp abre a mensagem pronta para o cliente.</p>
    <div class="board" id="board">
      ${cols.map((s) => {
        let items = list.filter((o) => o.status === s.id);
        const total = items.length;
        if (['entregue', 'cancelado'].includes(s.id)) items = items.slice(0, 30);
        return `<section class="col" data-status="${s.id}">
          <div class="col__head"><span class="dot" style="background:${s.color}"></span>${s.label}<span class="n">${total}</span></div>
          ${items.map(orderCard).join('') || '<div class="col__empty">Nada aqui</div>'}
        </section>`;
      }).join('')}
    </div>`;

  $('#oq', v).addEventListener('input', (e) => { OF.q = e.target.value; clearTimeout(viewOrders.t); viewOrders.t = setTimeout(() => { render(); const i = $('#oq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); }, { signal });
  on(v, signal, 'click', '[data-ch]', (b) => { OF.channel = b.dataset.ch; render(); });
  $('#showDone', v).addEventListener('change', (e) => { OF.showDone = e.target.checked; render(); }, { signal });
  wireOrderActions(v, signal);

  // Drag & drop entre colunas
  let dragId = null;
  on(v, signal, 'dragstart', '.ocard', (c, e) => { dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  on(v, signal, 'dragend', '.ocard', (c) => { c.classList.remove('dragging'); $$('.col.drop', v).forEach((x) => x.classList.remove('drop')); });
  on(v, signal, 'dragover', '.col', (c, e) => { e.preventDefault(); $$('.col.drop', v).forEach((x) => x !== c && x.classList.remove('drop')); c.classList.add('drop'); });
  on(v, signal, 'drop', '.col', (c, e) => {
    e.preventDefault();
    const o = S.orders.find((x) => x.id === dragId);
    if (o && o.status !== c.dataset.status) setStatus(dragId, c.dataset.status);
  });
}

function orderDialog() {
  const active = S.products.filter((p) => p.active);
  const lines = [{ product_id: active[0]?.id, qty: 1 }];
  openDialog(`<h2>Novo pedido</h2><p class="hint">Para pedidos que chegaram por telefone, Instagram ou no balcão.</p>
    <form class="form" id="of">
      <div class="row">
        <label class="field"><span>Nome</span><input class="input" name="name" required /></label>
        <label class="field"><span>WhatsApp</span><input class="input" name="phone" type="tel" required placeholder="(11) 90000-0000" /></label>
      </div>
      <div id="mlines" class="form"></div>
      <button type="button" class="btn btn--soft btn--sm" id="madd" style="justify-self:start">${icon('plus')} Produto</button>
      <div class="row">
        <label class="field"><span>Canal</span><select class="select" name="channel">${Object.entries(CHANNELS).map(([k, l]) => `<option value="${k}" ${k === 'whatsapp' ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Observação</span><input class="input" name="notes" /></label>
      </div>
      <p class="err" id="oerr"></p>
      <div class="form__actions"><strong id="mtotal" style="margin-right:auto;font-family:var(--f-display);font-size:1.4rem;color:var(--choc)"></strong><button class="btn" type="submit">Salvar pedido</button></div>
    </form>`, (m, close) => {
    const f = $('#of', m);
    maskPhoneInput(f.phone);
    const draw = () => {
      $('#mlines', m).innerHTML = lines.map((l, i) => `<div class="mline">
        <select class="select" data-ls="${i}">${active.map((p) => `<option value="${p.id}" ${p.id === l.product_id ? 'selected' : ''}>${esc(p.name)} (${money(p.price)})</option>`).join('')}</select>
        <input class="input" type="number" min="1" value="${l.qty}" data-lq="${i}" style="width:84px" aria-label="Quantidade" />
        <button type="button" class="icon-btn" data-lr="${i}" aria-label="Remover">${icon('trash')}</button></div>`).join('');
      $('#mtotal', m).textContent = money(lines.reduce((s, l) => s + l.qty * (prodById(l.product_id)?.price || 0), 0));
    };
    draw();
    m.addEventListener('change', (e) => {
      if (e.target.dataset.ls) lines[+e.target.dataset.ls].product_id = e.target.value;
      if (e.target.dataset.lq) lines[+e.target.dataset.lq].qty = Math.max(1, parseInt(e.target.value, 10) || 1);
      draw();
    });
    m.addEventListener('click', (e) => { const r = e.target.closest('[data-lr]'); if (r && lines.length > 1) { lines.splice(+r.dataset.lr, 1); draw(); } });
    $('#madd', m).onclick = () => { lines.push({ product_id: active[0].id, qty: 1 }); draw(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!isValidPhone(f.phone.value)) { $('#oerr', m).textContent = 'Telefone inválido'; return; }
      const merged = Object.values(lines.reduce((a, l) => ((a[l.product_id] ||= { product_id: l.product_id, qty: 0 }).qty += l.qty, a), {}));
      try {
        const r = await store.placeOrder({ customer_name: f.name.value, phone: f.phone.value, items: merged, channel: f.channel.value, notes: f.notes.value });
        close();
        await loadAll();
        S.orders.forEach((o) => S.seen.add(o.id));
        render();
        toast(`Pedido ${r.code} criado`);
      } catch (ex) { $('#oerr', m).textContent = ex.message; }
    };
  });
}

/* =================================================================== */
/* Produção                                                             */
/* =================================================================== */
function viewProduction(v) {
  const todo = S.orders.filter((o) => ['novo', 'confirmado', 'producao'].includes(o.status));
  const agg = {};
  todo.forEach((o) => o.items.forEach((i) => {
    const a = (agg[i.product_id] ||= { id: i.product_id, name: i.name, qty: 0, orders: [] });
    a.qty += i.qty;
    a.orders.push(`${o.code} · ${o.customer_name} · ${i.qty} un${o.status === 'novo' ? ' (não confirmado)' : ''}`);
  }));
  const rows = Object.values(agg).sort((a, b) => b.qty - a.qty);
  const cost = todo.reduce((s, o) => s + Number(o.cost_total), 0);
  v.innerHTML = `
    <div class="kpis">
      ${kpi('Unidades a produzir', rows.reduce((s, r) => s + r.qty, 0), `${todo.length} pedido(s)`, 'chef', true)}
      ${kpi('Custo de insumos', money(cost), 'estimado pelo custo cadastrado', 'cash')}
      ${kpi('A confirmar', todo.filter((o) => o.status === 'novo').length, 'pedidos novos', 'clock')}
      ${kpi('Prontos p/ entrega', S.orders.filter((o) => o.status === 'pronto').length, 'aguardando retirada', 'check')}
    </div>
    <section class="panel">
      <div class="panel__head"><div><h2>Lista de produção</h2><p>Soma dos pedidos novos, confirmados e em produção</p></div><button class="btn btn--soft btn--sm no-print" onclick="print()">${icon('print')} Imprimir</button></div>
      ${rows.length ? `<div class="prod-list">${rows.map((r) => {
        const p = prodById(r.id);
        return `<div class="prod-item">${p?.image ? `<img src="${esc(p.image)}" alt="">` : '<span></span>'}<div><h3>${esc(r.name)}</h3><small>${r.orders.length} pedido(s)</small></div><span class="qty">${r.qty}</span>
          <details><summary>Ver pedidos</summary><ul>${r.orders.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details></div>`;
      }).join('')}</div>` : emptyState('Forno livre!', 'Nada para produzir agora.')}
    </section>`;
}

/* =================================================================== */
/* Produtos                                                             */
/* =================================================================== */
function viewProducts(v, signal) {
  v.innerHTML = `
    <div class="toolbar"><p class="hint" style="margin:0;flex:1">A margem considera preço de venda e custo unitário (insumos + embalagem). Estrela = destaque no carrossel.</p>
      <button class="btn" id="addP">${icon('plus')} Novo produto</button></div>
    <div class="pgrid">${S.products.map((p) => {
      const m = margin(p.price, p.cost);
      return `<article class="pcard ${p.active ? '' : 'off'}">
        <img class="pcard__img" src="${esc(p.image || 'assets/img/logo.png')}" alt="" loading="lazy" />
        <div class="pcard__body">
          <h3>${esc(p.name)} ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}</h3>
          <div class="pcard__nums"><div><small>Preço</small><b>${money(p.price)}</b></div><div><small>Custo</small><b>${money(p.cost)}</b></div><div><small>Margem</small><b class="marg marg--${marginClass(m)}">${pct(m)}</b></div></div>
          <div class="pcard__actions">
            <label class="switch" title="Visível na loja"><input type="checkbox" data-act="${p.id}" ${p.active ? 'checked' : ''}/><i></i></label>
            <button class="icon-btn star ${p.featured ? 'on' : ''}" data-feat="${p.id}" title="Destaque" aria-label="Destaque"><svg class="i" viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/></svg></button>
            <button class="btn btn--soft btn--sm" data-edit="${p.id}">${icon('edit')} Editar</button>
          </div>
        </div></article>`;
    }).join('')}</div>`;
  $('#addP', v).onclick = () => productDialog();
  on(v, signal, 'click', '[data-edit]', (b) => productDialog(prodById(b.dataset.edit)));
  on(v, signal, 'change', '[data-act]', async (i) => { await store.saveProduct({ id: i.dataset.act, active: i.checked }); prodById(i.dataset.act).active = i.checked; render(); });
  on(v, signal, 'click', '[data-feat]', async (b) => { const p = prodById(b.dataset.feat); p.featured = !p.featured; await store.saveProduct({ id: p.id, featured: p.featured }); render(); });
}

function resizeImage(file, max = 900) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.82));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

function productDialog(p = { name: '', category: 'doces', description: '', price: '', cost: '', image: '', badge: '', active: true, featured: false }) {
  openDialog(`<h2>${p.id ? 'Editar produto' : 'Novo produto'}</h2>
    <form class="form" id="pf">
      <div class="img-pick"><img id="pimg" src="${esc(p.image || 'assets/img/logo.png')}" alt="" />
        <div class="form"><label class="field"><span>Foto</span><input type="file" accept="image/*" id="pfile" /></label>
        <input class="input" name="image" placeholder="ou cole a URL da imagem" value="${esc(p.image?.startsWith('data:') ? '' : p.image)}" /></div></div>
      <div class="row">
        <label class="field"><span>Nome</span><input class="input" name="name" required value="${esc(p.name)}" /></label>
        <label class="field"><span>Categoria</span><select class="select" name="category"><option value="doces" ${p.category === 'doces' ? 'selected' : ''}>Doces</option><option value="salgados" ${p.category === 'salgados' ? 'selected' : ''}>Salgados</option></select></label>
      </div>
      <label class="field"><span>Descrição</span><textarea class="textarea" name="description" maxlength="220">${esc(p.description)}</textarea></label>
      <div class="row3">
        <label class="field"><span>Preço de venda</span><input class="input" name="price" type="number" step="0.01" min="0" required value="${p.price}" /></label>
        <label class="field"><span>Custo unitário</span><input class="input" name="cost" type="number" step="0.01" min="0" required value="${p.cost}" /></label>
        <label class="field"><span>Selo</span><input class="input" name="badge" maxlength="18" placeholder="Ex.: Novidade" value="${esc(p.badge)}" /></label>
      </div>
      <div class="preview-box" id="pprev"></div>
      <p class="hint" id="psug"></p>
      <div class="form__actions">
        ${p.id ? `<button type="button" class="btn btn--ghost" id="pdel" style="margin-right:auto">${icon('trash')} Excluir</button>` : ''}
        <button type="button" class="btn btn--ghost" data-close>Cancelar</button><button class="btn" type="submit">Salvar</button>
      </div>
    </form>`, (m, close) => {
    const f = $('#pf', m);
    let dataImg = p.image?.startsWith('data:') ? p.image : '';
    const prev = () => {
      const price = +f.price.value || 0;
      const cost = +f.cost.value || 0;
      const mg = margin(price, cost);
      $('#pprev', m).innerHTML = `<div><small>Lucro / un</small><b>${money(price - cost)}</b></div><div><small>Margem</small><b class="marg marg--${marginClass(mg)}">${pct(mg)}</b></div><div><small>Markup</small><b>${cost ? (price / cost).toFixed(2).replace('.', ',') + 'x' : 'sem custo'}</b></div>`;
      const sug = cost ? Math.ceil((cost / (1 - 0.6)) * 2) / 2 : 0;
      $('#psug', m).innerHTML = cost ? `💡 Para 60% de margem, o preço sugerido é <b>${money(sug)}</b>. <button type="button" class="chip" id="usesug">Usar</button>` : '';
      $('#usesug', m)?.addEventListener('click', () => { f.price.value = sug.toFixed(2); prev(); });
    };
    prev();
    f.addEventListener('input', prev);
    f.image.addEventListener('input', () => { dataImg = ''; $('#pimg', m).src = f.image.value || 'assets/img/logo.png'; });
    $('#pfile', m).onchange = async (e) => { const file = e.target.files[0]; if (!file) return; dataImg = await resizeImage(file); $('#pimg', m).src = dataImg; f.image.value = ''; };
    $('#pdel', m)?.addEventListener('click', async () => {
      if (!confirm(`Excluir "${p.name}"? Pedidos antigos continuam no histórico.`)) return;
      await store.deleteProduct(p.id);
      S.products = await store.listProducts({ all: true });
      close(); render(); toast('Produto excluído');
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const rec = { ...(p.id ? { id: p.id } : {}), name: f.name.value.trim(), category: f.category.value, description: f.description.value.trim(),
        price: +f.price.value, cost: +f.cost.value, badge: f.badge.value.trim(), image: dataImg || f.image.value.trim() || p.image || '' };
      try {
        await store.saveProduct(rec);
        S.products = await store.listProducts({ all: true });
        close(); render(); toast('Produto salvo ♡');
      } catch (ex) { toast(ex.message, 'err'); }
    };
  });
}

/* =================================================================== */
/* Financeiro                                                           */
/* =================================================================== */
const FIN = { days: 30 };

function productRank(list) {
  const agg = {};
  list.forEach((o) => o.items.forEach((i) => {
    const a = (agg[i.product_id] ||= { id: i.product_id, name: i.name, image: prodById(i.product_id)?.image, units: 0, revenue: 0, cost: 0 });
    a.units += i.qty;
    a.revenue += i.qty * i.unit_price;
    a.cost += i.qty * i.unit_cost;
  }));
  return Object.values(agg).map((a) => ({ ...a, profit: a.revenue - a.cost, margin: margin(a.revenue, a.cost) })).sort((a, b) => b.profit - a.profit);
}

function viewFinance(v, signal) {
  const days = FIN.days;
  const from = startOfDay(new Date(Date.now() - (days - 1) * 864e5));
  const prevFrom = new Date(from.getTime() - days * 864e5);
  const list = inRange(from);
  const cur = sums(list);
  const prev = sums(inRange(prevFrom, from));
  const fixedMonthly = (S.settings.fixed_costs || []).reduce((s, c) => s + Number(c.value || 0), 0);
  const fixed = (fixedMonthly * days) / 30;
  const net = cur.profit - fixed;
  const ranks = productRank(list);
  const maxProfit = Math.max(...ranks.map((r) => r.profit), 1);
  const series = days > 60 ? weeklySeries(days) : dailySeries(days);

  v.innerHTML = `
    <div class="toolbar">
      <div class="chips" role="group" aria-label="Período">${[7, 30, 90, 365].map((d) => `<button class="chip" data-days="${d}" aria-pressed="${days === d}">${d === 365 ? '12 meses' : `${d} dias`}</button>`).join('')}</div>
      <button class="btn btn--soft btn--sm" id="csv" style="margin-left:auto">${icon('copy')} Exportar CSV</button>
    </div>
    <div class="kpis">
      ${kpi('Faturamento', money(cur.revenue), `${deltaTag(delta(cur.revenue, prev.revenue))} vs período anterior`, 'cash')}
      ${kpi('Custo dos produtos', money(cur.cost), `${pct(cur.revenue ? (cur.cost / cur.revenue) * 100 : 0)} do faturamento`, 'box')}
      ${kpi('Lucro bruto', money(cur.profit), `margem ${pct(cur.margin)}`, 'chart', true)}
      ${kpi('Lucro líquido est.', money(net), fixedMonthly ? `após ${money(fixed)} de custos fixos` : '<a href="#ajustes">cadastre custos fixos</a>', 'heart')}
    </div>
    <div class="kpis">
      ${kpi('Pedidos', cur.count, `${deltaTag(delta(cur.count, prev.count))}`)}
      ${kpi('Ticket médio', money(cur.ticket), `${deltaTag(delta(cur.ticket, prev.ticket))}`)}
      ${kpi('Lucro por pedido', money(cur.count ? cur.profit / cur.count : 0), 'média')}
      ${kpi('Cancelados', S.orders.filter((o) => o.status === 'cancelado' && new Date(o.created_at) >= from).length, 'no período')}
    </div>
    <section class="panel"><div class="panel__head"><h2>Faturamento ${days > 60 ? 'semanal' : 'diário'}</h2><p>Cada barra = custo + lucro</p></div>${revenueChart(series, days > 60 ? 4 : days > 14 ? 5 : 1)}</section>
    <div class="cols cols--2">
      <section class="panel"><div class="panel__head"><h2>Resultado por produto</h2><p>Ordenado por lucro</p></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Produto</th><th class="num">Un.</th><th class="num">Receita</th><th class="num">Custo</th><th class="num">Lucro</th><th class="num">Margem</th><th>Peso no lucro</th></tr></thead>
        <tbody>${ranks.map((r) => `<tr><td><div class="prod-cell">${r.image ? `<img src="${esc(r.image)}" alt="">` : ''}${esc(r.name)}</div></td><td class="num">${r.units}</td><td class="num">${money(r.revenue)}</td><td class="num">${money(r.cost)}</td><td class="num"><b>${money(r.profit)}</b></td><td class="num"><span class="marg marg--${marginClass(r.margin)}">${pct(r.margin)}</span></td><td class="mbar-cell"><span style="width:${(r.profit / maxProfit) * 100}%"></span></td></tr>`).join('') || '<tr><td colspan="7" class="empty">Sem vendas no período.</td></tr>'}</tbody>
        ${ranks.length ? `<tfoot><tr><td>Total</td><td class="num">${ranks.reduce((s, r) => s + r.units, 0)}</td><td class="num">${money(cur.revenue)}</td><td class="num">${money(cur.cost)}</td><td class="num">${money(cur.profit)}</td><td class="num">${pct(cur.margin)}</td><td></td></tr></tfoot>` : ''}</table></div>
      </section>
      <section class="panel"><div class="panel__head"><h2>Simulador de preço</h2></div>
        <form class="form" id="sim">
          <div class="row"><label class="field"><span>Custo dos ingredientes</span><input class="input" name="c" type="number" step="0.01" value="1.20" /></label>
          <label class="field"><span>Embalagem / forminha</span><input class="input" name="e" type="number" step="0.01" value="0.25" /></label></div>
          <label class="field"><span>Margem desejada: <b id="mv">60%</b></span><input type="range" name="m" min="20" max="80" value="60" /></label>
          <div class="preview-box" id="simout"></div>
          <p class="hint">Fórmula: preço = custo ÷ (1 − margem), arredondado para cima a cada R$ 0,50.</p>
        </form>
        <h2 style="font-family:var(--f-display);font-size:1rem;margin:20px 0 10px;color:var(--choc)">Por canal</h2>
        <div class="table-wrap"><table class="t" style="min-width:0"><tbody>${Object.entries(CHANNELS).map(([k, l]) => { const s = sums(list.filter((o) => o.channel === k)); return `<tr><td><span class="ch ch--${k}">${l}</span></td><td class="num">${s.count} ped.</td><td class="num">${money(s.revenue)}</td></tr>`; }).join('')}</tbody></table></div>
      </section>
    </div>`;

  on(v, signal, 'click', '[data-days]', (b) => { FIN.days = +b.dataset.days; render(); });
  const sim = $('#sim', v);
  const calc = () => {
    const cost = (+sim.c.value || 0) + (+sim.e.value || 0);
    const mg = +sim.m.value / 100;
    const price = Math.ceil((cost / (1 - mg)) * 2) / 2;
    $('#mv', v).textContent = `${sim.m.value}%`;
    $('#simout', v).innerHTML = `<div><small>Custo total</small><b>${money(cost)}</b></div><div><small>Preço sugerido</small><b>${money(price)}</b></div><div><small>Lucro / un</small><b>${money(price - cost)}</b></div>`;
  };
  sim.addEventListener('input', calc, { signal });
  calc();
  $('#csv', v).onclick = () => {
    const rows = [['codigo', 'data', 'cliente', 'telefone', 'canal', 'status', 'itens', 'total', 'custo', 'lucro']];
    S.orders.filter((o) => new Date(o.created_at) >= from).forEach((o) => rows.push([o.code, fmtDateTime(o.created_at), o.customer_name, o.phone, o.channel, o.status,
      o.items.map((i) => `${i.qty}x ${i.name}`).join(' | '), Number(o.total).toFixed(2), Number(o.cost_total).toFixed(2), (o.total - o.cost_total).toFixed(2)]));
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: `pedidos-${days}d.csv` });
    a.click();
  };
}

function weeklySeries(days) {
  const out = [];
  const weeks = Math.ceil(days / 7);
  for (let i = weeks - 1; i >= 0; i--) {
    const d1 = new Date(startOfDay().getTime() + 864e5 - i * 7 * 864e5);
    const d0 = new Date(d1.getTime() - 7 * 864e5);
    out.push({ d: d0, ...sums(inRange(d0, d1)) });
  }
  return out;
}

/* =================================================================== */
/* Novidades                                                            */
/* =================================================================== */
function viewNews(v, signal) {
  v.innerHTML = `
    <div class="cols cols--even">
      <section class="panel"><div class="panel__head"><h2>Nova novidade</h2></div>
        <form class="form" id="nf">
          <label class="field"><span>Título</span><input class="input" name="title" required maxlength="80" placeholder="Ex.: Chegou o Morango Cravejado 🍓" /></label>
          <label class="field"><span>Texto</span><textarea class="textarea" name="body" maxlength="400" placeholder="Conte a novidade com carinho…"></textarea></label>
          <label class="field"><span>Imagem</span><select class="select" name="image"><option value="">Sem imagem</option>${S.products.map((p) => `<option value="${esc(p.image)}">${esc(p.name)}</option>`).join('')}</select></label>
          <div style="display:flex;gap:18px;flex-wrap:wrap">
            <label class="switch"><input type="checkbox" name="site" checked /><i></i>Mostrar no site</label>
            <label class="switch"><input type="checkbox" name="wa" /><i></i>Enviar pelo bot</label>
          </div>
          <div class="form__actions"><button class="btn" type="submit">${icon('send')} Publicar</button></div>
        </form>
        <p class="hint">“Enviar pelo bot” dispara para os clientes inscritos (opção 4 do menu do bot). Para grupos, use o botão <b>Compartilhar no grupo</b> de cada novidade.</p>
      </section>
      <section class="panel"><div class="panel__head"><h2>Publicadas</h2><p>${S.news.length} no total</p></div>
        <div class="nlist">${S.news.map((n) => `<article class="nitem">
          ${n.image ? `<img src="${esc(n.image)}" alt="">` : '<span></span>'}
          <div><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p>
          <div class="nitem__meta">${fmtDate(n.created_at)} · ${esc(n.author || '')} ${(n.channels || []).map((c) => `<span class="ch">${c === 'site' ? 'Site' : 'WhatsApp'}</span>`).join('')}${n.published ? '' : '<span class="ch">Oculta</span>'}
            <span class="actions">
              <a class="icon-btn" href="${waLink(`✨ *${n.title}*\n${n.body}\n\nPeça já: ${location.origin}${location.pathname.replace(/admin\.html$/, '')}`, '')}" target="_blank" rel="noopener" title="Compartilhar no grupo" aria-label="Compartilhar no grupo">${icon('wa')}</a>
              <button class="icon-btn" data-toggle="${n.id}" title="${n.published ? 'Ocultar' : 'Mostrar'}">${icon(n.published ? 'check' : 'x')}</button>
              <button class="icon-btn" data-del="${n.id}" title="Excluir">${icon('trash')}</button>
            </span></div></div></article>`).join('') || emptyState('Nada ainda', 'Publique a primeira novidade!')}</div>
      </section>
    </div>`;

  const f = $('#nf', v);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const channels = [f.site.checked && 'site', f.wa.checked && 'whatsapp'].filter(Boolean);
    if (!channels.length) { toast('Escolha ao menos um canal', 'err'); return; }
    try {
      const n = await store.saveNews({ title: f.title.value.trim(), body: f.body.value.trim(), image: f.image.value, channels, published: true, author: S.user?.name || 'Painel' });
      if (f.wa.checked) {
        try {
          const r = await store.broadcast(n.id);
          toast(r.demo ? 'Publicado! (envio pelo bot simulado no modo demo)' : r.queued ? 'Publicado! O bot envia pelo WhatsApp em até 1 minuto 📲' : `Publicado e enviado para ${r.sent} cliente(s) 🎉`);
        } catch (ex) { toast(`Publicado no site. Bot: ${ex.message}`, 'err'); }
      } else toast('Novidade publicada ✨');
      S.news = await store.listNews({ all: true });
      render();
    } catch (ex) { toast(ex.message, 'err'); }
  };
  on(v, signal, 'click', '[data-del]', async (b) => { if (!confirm('Excluir esta novidade?')) return; await store.deleteNews(b.dataset.del); S.news = await store.listNews({ all: true }); render(); });
  on(v, signal, 'click', '[data-toggle]', async (b) => { const n = S.news.find((x) => x.id === b.dataset.toggle); await store.saveNews({ id: n.id, published: !n.published }); S.news = await store.listNews({ all: true }); render(); });
}

/* =================================================================== */
/* Bot WhatsApp                                                         */
/* =================================================================== */
const SIM = { persona: 'cliente', log: [] };

function waFormat(s) {
  return esc(s).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<em>$2</em>');
}

function botCtx() {
  return {
    listProducts: () => store.listProducts(),
    getSettings: () => store.getSettings(),
    getSession: (p) => store.getBotSession(p),
    saveSession: (p, s) => store.saveBotSession(p, s),
    isAdmin: async (p) => S.admins.find((a) => a.phone === normalizePhone(p)) || null,
    listNews: () => store.listNews(),
    subscribe: (p, n, on) => store.subscribe(p, n, on),
    placeOrder: (o) => store.placeOrder({ ...o, notes: 'Teste pelo simulador do bot' }),
    createNews: (n) => store.saveNews({ ...n, channels: ['site'], published: true }), // simulador não dispara WhatsApp
    broadcast: async () => ({ sent: 0 }),
    listOpenOrders: async () => (await store.listOrders()).filter((o) => OPEN_STATUSES.includes(o.status)),
    notifyHuman: async () => {},
    findOrder: async (code) => S.orders.find((o) => o.code === code) || null,
  };
}

function viewBot(v, signal) {
  const live = !!CONFIG.BOT_FUNCTION_URL;
  const personas = {
    cliente: { phone: '5511988887777', name: 'Ana (cliente)', isGroup: false },
    grupo: { phone: '5511977776666', name: 'Bruno (no grupo)', isGroup: true },
    admin: { phone: S.admins.find((a) => a.can_post)?.phone || '5511999999999', name: 'Administradora', isGroup: false },
  };
  v.innerHTML = `
    <div class="cols cols--2">
      <div style="display:grid;gap:18px;align-content:start">
        <section class="panel"><div class="panel__head"><h2>Status da integração</h2></div>
          ${live ? `<p class="status-line"><span class="dot" style="background:var(--leaf)"></span>Bot conectado ao WhatsApp Business (Cloud API)</p>
          <p class="hint">Webhook: <span class="codeline">${esc(CONFIG.BOT_FUNCTION_URL)}</span></p>` : `
          <div id="botLive"><p class="status-line"><span class="dot" style="background:var(--honey)"></span>Verificando o bot…</p></div>`}
        </section>
        <section class="panel"><div class="panel__head"><div><h2>Números autorizados</h2><p>Quem pode postar novidades e ver pedidos pelo bot</p></div><button class="btn btn--sm" id="addAdm">${icon('plus')} Adicionar</button></div>
          <div class="table-wrap"><table class="t" style="min-width:440px"><thead><tr><th>Nome</th><th>WhatsApp</th><th>Postar novidades</th><th>Ver pedidos</th><th></th></tr></thead>
          <tbody>${S.admins.map((a) => `<tr><td><b>${esc(a.name)}</b></td><td>${formatPhone(a.phone)}</td>
            <td><label class="switch"><input type="checkbox" data-perm="can_post" data-id="${a.id}" ${a.can_post ? 'checked' : ''}/><i></i></label></td>
            <td><label class="switch"><input type="checkbox" data-perm="can_manage_orders" data-id="${a.id}" ${a.can_manage_orders ? 'checked' : ''}/><i></i></label></td>
            <td><button class="icon-btn" data-rmadm="${a.id}" aria-label="Remover">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">Nenhum número autorizado.</td></tr>'}</tbody></table></div>
        </section>
        <section class="panel"><div class="panel__head"><h2>Como as pessoas usam</h2></div>
          <ul class="steps-list">
            <li><b>Clientes</b>: o bot responde só mensagens de encomenda: <code>menu</code>, <code>cardápio</code>, os botões do site ou o pedido escrito, como <code>quero 10 brigadeiros e 2 empadinhas</code>. Conversas pessoais ficam sem resposta automática.</li>
            <li><b>Respondeu pelo celular?</b> O bot fica 12 h sem falar com aquela pessoa (ela pode chamar de novo com <code>menu</code>). Conversa parada há 30 min encerra sozinha.</li>
            <li><b>No grupo</b>, o bot só responde a mensagens com <code>#pedido</code> (ex.: <code>#pedido 6 casadinhos</code>) e continua no privado.</li>
            <li><b>Administradoras</b>: <code>#novidade Título | texto</code>, <code>#pedidos</code>, <code>#producao</code>.</li>
            <li>Opção <b>4</b> inscreve o cliente para receber novidades; “parar novidades” cancela.</li>
          </ul>
        </section>
      </div>

      <section class="panel" style="align-self:start"><div class="panel__head"><div><h2>Simulador</h2><p>Mesma conversa do bot real (aqui ele responde tudo). Pedidos feitos aqui entram no quadro.</p></div></div>
        <div class="phone-sim"><div class="phone-sim__screen">
          <div class="phone-sim__head"><img src="assets/img/logo.png" width="34" height="34" alt="" /><div><b>Um Doce Até o Diploma</b><small>bot · online</small></div>
            <select id="persona" aria-label="Conversar como">${Object.entries(personas).map(([k, p]) => `<option value="${k}" ${SIM.persona === k ? 'selected' : ''}>${p.name}</option>`).join('')}</select></div>
          <div class="msgs" id="msgs"></div>
          <div class="quick" id="quick">${['oi', '1', '2', '3', '0', 'quero 10 brigadeiros e 2 empadinhas', '#pedido 6 casadinhos', '#pedidos', '#producao', '#novidade Kit Provas | 4 docinhos + empadinha com preço especial!', 'cancelar'].map((q) => `<button type="button">${esc(q)}</button>`).join('')}</div>
          <form class="composer" id="composer"><input id="msgIn" placeholder="Mensagem" autocomplete="off" /><button aria-label="Enviar">${icon('send')}</button></form>
        </div></div>
        <div style="text-align:center;margin-top:10px"><button class="btn btn--soft btn--sm" id="simReset">${icon('refresh')} Reiniciar conversa</button></div>
      </section>
    </div>`;

  // O bot por QR Code (pasta bot/) grava o status a cada 30 s em settings.bot, inclusive o QR Code para conectar.
  const botLive = $('#botLive', v);
  if (botLive) {
    const line = (color, text) => `<p class="status-line"><span class="dot" style="background:var(--${color})"></span>${text}</p>`;
    const paint = (b) => {
      const alive = b?.last_seen && Date.now() - new Date(b.last_seen).getTime() < 120e3 && b.state !== 'desligado';
      const qr = typeof b?.qr === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(b.qr) ? b.qr : '';
      if (alive && b.state === 'online') {
        botLive.innerHTML = line('leaf', `Bot online no WhatsApp${b.phone ? ` · ${esc(formatPhone(b.phone))}` : ''}`);
      } else if (alive && b.state === 'qr' && qr) {
        botLive.innerHTML = line('honey', 'Aguardando conexão com o WhatsApp')
          + `<img class="bot-qr" src="${qr}" alt="QR Code para conectar o WhatsApp" width="240" height="240" />
          <p class="hint">No celular da loja: WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b> → aponte para o código. Ele se renova sozinho.</p>`;
      } else if (alive) {
        botLive.innerHTML = line('honey', 'Bot ligado, conectando ao WhatsApp…');
      } else {
        botLive.innerHTML = line('honey', b?.last_seen ? `Bot desligado, visto ${timeAgo(b.last_seen)}. Confira se o computador do bot está ligado.` : 'Bot ainda não instalado. O simulador ao lado já funciona')
          + `<p class="hint">O bot roda num computador sempre ligado: pasta <code>bot</code> do projeto, <code>npm install</code>, Secret key do Supabase no <code>.env</code> e <code>./instalar-servico-mac.sh</code>. O QR Code para conectar aparece aqui.</p>`;
      }
    };
    const refresh = () => store.botStatus().then(paint).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 5000);
    signal.addEventListener('abort', () => clearInterval(timer));
  }

  const msgs = $('#msgs', v);
  const draw = () => {
    msgs.innerHTML = SIM.log.length ? SIM.log.map((m) => `<div class="msg msg--${m.dir}">${waFormat(m.text)}</div>`).join('') : '<div class="msg msg--sys">Mande “oi” para começar 👋</div>';
    msgs.scrollTop = msgs.scrollHeight;
  };
  draw();
  const send = async (text) => {
    if (!text.trim()) return;
    const p = personas[SIM.persona];
    SIM.log.push({ dir: 'out', text });
    draw();
    try {
      const replies = await handleMessage({ phone: p.phone, text, profileName: p.name.split(' ')[0], isGroup: p.isGroup }, botCtx());
      if (!replies.length) SIM.log.push({ dir: 'sys', text: p.isGroup ? 'bot ignorou (no grupo só responde a #pedido)' : 'bot ficou em silêncio' });
      for (const r of replies) { await new Promise((ok) => setTimeout(ok, 350)); SIM.log.push({ dir: 'in', text: r }); draw(); }
      draw();
      const before = S.orders.length;
      S.orders = await store.listOrders();
      S.news = await store.listNews({ all: true });
      if (S.orders.length > before) { updateNewPill(); toast('Pedido do simulador entrou no quadro 🎉'); }
    } catch (ex) { SIM.log.push({ dir: 'sys', text: `erro: ${ex.message}` }); draw(); }
  };
  $('#composer', v).onsubmit = (e) => { e.preventDefault(); const i = $('#msgIn', v); send(i.value); i.value = ''; };
  on(v, signal, 'click', '#quick button', (b) => send(b.textContent));
  $('#persona', v).onchange = (e) => { SIM.persona = e.target.value; SIM.log.push({ dir: 'sys', text: `agora conversando como ${personas[SIM.persona].name}` }); draw(); };
  $('#simReset', v).onclick = async () => { await Promise.all(Object.values(personas).map((p) => store.saveBotSession(p.phone, null))); SIM.log = []; draw(); };

  $('#addAdm', v).onclick = () => openDialog(`<h2>Autorizar número</h2><form class="form" id="af">
      <label class="field"><span>Nome</span><input class="input" name="name" required /></label>
      <label class="field"><span>WhatsApp</span><input class="input" name="phone" type="tel" required /></label>
      <label class="switch"><input type="checkbox" name="can_post" checked /><i></i>Pode postar novidades</label>
      <label class="switch"><input type="checkbox" name="can_manage_orders" /><i></i>Pode ver pedidos e produção</label>
      <div class="form__actions"><button class="btn" type="submit">Salvar</button></div></form>`, (m, close) => {
    const f = $('#af', m);
    maskPhoneInput(f.phone);
    f.onsubmit = async (e) => {
      e.preventDefault();
      if (!isValidPhone(f.phone.value)) { toast('Telefone inválido', 'err'); return; }
      await store.saveBotAdmin({ name: f.name.value.trim(), phone: f.phone.value, can_post: f.can_post.checked, can_manage_orders: f.can_manage_orders.checked });
      S.admins = await store.listBotAdmins();
      close(); render();
    };
  });
  on(v, signal, 'change', '[data-perm]', async (i) => { await store.saveBotAdmin({ ...S.admins.find((a) => a.id === i.dataset.id), [i.dataset.perm]: i.checked }); S.admins = await store.listBotAdmins(); });
  on(v, signal, 'click', '[data-rmadm]', async (b) => { if (!confirm('Remover este número?')) return; await store.deleteBotAdmin(b.dataset.rmadm); S.admins = await store.listBotAdmins(); render(); });
}

/* =================================================================== */
/* Ajustes                                                              */
/* =================================================================== */
function viewSettings(v, signal) {
  const s = S.settings;
  const fixed = s.fixed_costs?.length ? s.fixed_costs : [{ name: 'Gás e energia', value: 0 }, { name: 'Embalagens extras', value: 0 }];
  v.innerHTML = `
    <div class="cols cols--even">
      <section class="panel"><div class="panel__head"><h2>Loja</h2></div>
        <form class="form" id="sf">
          <label class="switch"><input type="checkbox" name="accepting" ${s.accepting !== false ? 'checked' : ''}/><i></i>Aceitando encomendas</label>
          <label class="field"><span>Aviso no topo do site</span><input class="input" name="notice" value="${esc(s.notice || '')}" placeholder="Ex.: Encomendas com 1 dia de antecedência" /></label>
          <label class="field"><span>Chave Pix (enviada na confirmação)</span><input class="input" name="pix_key" value="${esc(s.pix_key || '')}" /></label>
          <label class="field"><span>Saudação do bot</span><input class="input" name="bot_greeting" value="${esc(s.bot_greeting || '')}" /></label>
          <div class="form__actions"><button class="btn" type="submit">Salvar</button></div>
        </form>
      </section>
      <section class="panel"><div class="panel__head"><div><h2>Custos fixos mensais</h2><p>Usados no lucro líquido estimado</p></div></div>
        <form class="form" id="ff">
          <div id="fixed" class="form">${fixed.map((c, i) => `<div class="mline"><input class="input" name="n${i}" value="${esc(c.name)}" aria-label="Descrição" /><input class="input" name="v${i}" type="number" step="0.01" value="${c.value}" style="width:120px" aria-label="Valor" /><span></span></div>`).join('')}</div>
          <button type="button" class="btn btn--soft btn--sm" id="addFixed" style="justify-self:start">${icon('plus')} Custo</button>
          <div class="form__actions"><button class="btn" type="submit">Salvar custos</button></div>
        </form>
      </section>
      <section class="panel"><div class="panel__head"><h2>Conta e segurança</h2></div>
        <p class="status-line"><span class="dot" style="background:${IS_DEMO ? 'var(--honey)' : 'var(--leaf)'}"></span>${IS_DEMO ? 'Modo demonstração (dados apenas neste navegador)' : 'Produção (Supabase Auth + RLS)'}</p>
        <p class="hint">${IS_DEMO
          ? 'Para receber pedidos reais de clientes, conecte o Supabase (gratuito) preenchendo SUPABASE_URL e SUPABASE_ANON_KEY em assets/js/config.js. O passo a passo está no README.'
          : `Logada como <b>${esc(S.user?.email || '')}</b>. Senhas e novos acessos são gerenciados em Supabase → Authentication.`}</p>
        ${IS_DEMO ? `<button class="btn btn--ghost btn--sm" id="resetDemo">${icon('refresh')} Restaurar dados de exemplo</button>` : ''}
      </section>
    </div>`;

  $('#sf', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    await store.saveSettings({ accepting: f.accepting.checked, notice: f.notice.value.trim(), pix_key: f.pix_key.value.trim(), bot_greeting: f.bot_greeting.value.trim() });
    S.settings = await store.getSettings();
    toast('Ajustes salvos');
  };
  $('#addFixed', v).onclick = () => {
    const i = $$('#fixed .mline', v).length;
    $('#fixed', v).insertAdjacentHTML('beforeend', `<div class="mline"><input class="input" name="n${i}" placeholder="Descrição" /><input class="input" name="v${i}" type="number" step="0.01" value="0" style="width:120px" /><span></span></div>`);
  };
  $('#ff', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const list = $$('#fixed .mline', v).map((_, i) => ({ name: f[`n${i}`].value.trim(), value: +f[`v${i}`].value || 0 })).filter((c) => c.name);
    await store.saveSettings({ fixed_costs: list });
    S.settings = await store.getSettings();
    toast('Custos salvos');
  };
  $('#resetDemo', v)?.addEventListener('click', () => {
    if (!confirm('Apagar tudo e restaurar os dados de exemplo?')) return;
    store.resetDemo();
    location.reload();
  }, { signal });
}
