import { CONFIG, IS_DEMO } from './config.js';
import { store, ready } from './store.js';
import { icon, hydrateIcons } from './icons.js';
import { $, $$, esc, money, fmtDate, waLink, maskPhoneInput, isValidPhone, toast } from './utils.js';

const CART_KEY = 'um-doce-ate-o-diploma:cart';
const ME_KEY = 'um-doce-ate-o-diploma:me';
const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

let products = [];
let gridShown = false;
let settings = {};
let cart = loadJSON(CART_KEY, []);
const byId = (id) => products.find((p) => p.id === id);

hydrateIcons();
boot();

async function boot() {
  try {
    await ready;
    [products, settings] = await Promise.all([store.listProducts(), store.getSettings()]);
  } catch (e) {
    console.error(e);
    toast('Não consegui carregar o cardápio. Tente recarregar.', 'err');
  }
  cart = cart.filter((l) => byId(l.product_id));

  if (IS_DEMO) $('#demoRibbon').hidden = false;
  renderNotice();
  wireLinks();
  renderCarousel();
  renderGrid('all');
  renderLines();
  wireForm();
  wireLoyalty();
  renderNews();
  wireChrome();
}

/* ---------- topo / links ---------- */
function renderNotice() {
  const el = $('#notice');
  if (settings.accepting === false) {
    el.textContent = `Agenda cheia no momento 🥲 ${settings.notice || 'Volte em breve!'}`;
    el.classList.add('notice--closed');
    el.hidden = false;
  } else if (settings.notice) {
    el.textContent = settings.notice;
    el.hidden = false;
  }
}

function wireLinks() {
  const hello = `Oi! Vim pelo site e quero fazer uma encomenda 🍫`;
  $('#heroWa').href = waLink(hello);
  $('#footWa').href = waLink(hello);
  $('#subscribeWa').href = waLink('Oi! Quero receber as novidades por aqui 🔔');
  $('#footIg').href = `https://instagram.com/${CONFIG.INSTAGRAM}`;
  $('#footCity').textContent = CONFIG.CITY;
  $('#stampGoal').textContent = CONFIG.LOYALTY_GOAL;
  $('#rewardText').textContent = `Ganha ${CONFIG.LOYALTY_REWARD}`;
}

/* ---------- carrossel ---------- */
function renderCarousel() {
  const featured = products.filter((p) => p.featured);
  const items = featured.length ? featured : products;
  const track = $('#carouselTrack');
  const dots = $('#carouselDots');
  track.innerHTML = items.map((p, i) => `
    <article class="slide" id="slide-${i}" aria-roledescription="slide" aria-label="${i + 1} de ${items.length}">
      <img src="${esc(p.image)}" alt="${esc(p.name)}" ${i ? 'loading="lazy"' : ''} />
      <span class="slide__tag">${esc(p.name)} ♡</span>
      <div class="slide__info">
        <p><strong>${money(p.price)}</strong>${esc(p.badge || p.description?.split('.')[0] || '')}</p>
        <button class="btn btn--sm" data-add="${p.id}">${icon('plus')} Quero</button>
      </div>
    </article>`).join('');
  dots.innerHTML = items.map((_, i) => `<button role="tab" aria-label="Destaque ${i + 1}" aria-selected="${i === 0}" data-go="${i}"></button>`).join('');

  const slides = $$('.slide', track);
  let current = 0;
  const go = (i) => {
    current = (i + slides.length) % slides.length;
    track.scrollTo({ left: slides[current].offsetLeft - track.offsetLeft, behavior: 'smooth' });
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting && e.intersectionRatio > 0.6) {
        current = slides.indexOf(e.target);
        slides.forEach((s, j) => s.classList.toggle('is-active', j === current));
        $$('button', dots).forEach((d, j) => d.setAttribute('aria-selected', j === current));
      }
    });
  }, { root: track, threshold: [0.6] });
  slides.forEach((s) => io.observe(s));

  dots.addEventListener('click', (e) => e.target.dataset.go && go(+e.target.dataset.go));
  $('.carousel .prev').addEventListener('click', () => go(current - 1));
  $('.carousel .next').addEventListener('click', () => go(current + 1));

  let paused = false;
  const carousel = $('#carousel');
  ['pointerenter', 'focusin', 'touchstart'].forEach((ev) => carousel.addEventListener(ev, () => (paused = true), { passive: true }));
  ['pointerleave', 'focusout'].forEach((ev) => carousel.addEventListener(ev, () => (paused = false)));
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && slides.length > 1) {
    setInterval(() => !paused && !document.hidden && go(current + 1), 5000);
  }
  track.addEventListener('click', onAddClick);
}

/* ---------- cardápio ---------- */
function renderGrid(cat) {
  const list = cat === 'all' ? products : products.filter((p) => p.category === cat);
  const grid = $('#productGrid');
  if (!list.length) {
    grid.innerHTML = '<p class="news-empty">Nada por aqui ainda. Volte logo!</p>';
    return;
  }
  grid.innerHTML = list.map((p) => {
    const line = cart.find((l) => l.product_id === p.id);
    return `
    <article class="card ${gridShown ? '' : 'reveal'}">
      <div class="card__media">
        <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />
        ${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}
      </div>
      <div class="card__body">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.description)}</p>
        <div class="card__foot">
          <span class="price">${money(p.price)} <small>/un</small></span>
          ${line
            ? `<div class="stepper" aria-label="Quantidade de ${esc(p.name)}">
                 <button type="button" data-dec="${p.id}" aria-label="Menos">−</button>
                 <output>${line.qty}</output>
                 <button type="button" data-inc="${p.id}" aria-label="Mais">+</button>
               </div>`
            : `<button class="btn btn--sm" data-add="${p.id}">${icon('plus')} Adicionar</button>`}
        </div>
      </div>
    </article>`;
  }).join('');
  gridShown = true;
  observeReveal();
}

$('.filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  $$('.filters .chip').forEach((c) => c.setAttribute('aria-pressed', c === b));
  renderGrid(b.dataset.cat);
});
$('#productGrid').addEventListener('click', (e) => {
  onAddClick(e);
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) setQty(inc.dataset.inc, (cart.find((l) => l.product_id === inc.dataset.inc)?.qty || 0) + 1);
  if (dec) setQty(dec.dataset.dec, (cart.find((l) => l.product_id === dec.dataset.dec)?.qty || 0) - 1);
});

function onAddClick(e) {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const p = byId(b.dataset.add);
  setQty(p.id, (cart.find((l) => l.product_id === p.id)?.qty || 0) + 1);
  toast(`${p.name} no pedido ♡`);
}

/* ---------- carrinho ---------- */
function setQty(id, qty, { rerenderGrid = true } = {}) {
  const line = cart.find((l) => l.product_id === id);
  if (qty <= 0) cart = cart.filter((l) => l.product_id !== id);
  else if (line) line.qty = Math.min(500, qty);
  else cart.push({ product_id: id, qty });
  saveJSON(CART_KEY, cart);
  renderLines();
  if (rerenderGrid) renderGrid($('.filters [aria-pressed="true"]').dataset.cat);
}

const cartCount = () => cart.reduce((s, l) => s + l.qty, 0);
const cartTotal = () => cart.reduce((s, l) => s + l.qty * (byId(l.product_id)?.price || 0), 0);

function renderLines() {
  const box = $('#lines');
  if (!cart.length) {
    box.innerHTML = `<div class="empty-lines">Seu pedido está vazio. Toque em <b>Adicionar</b> no cardápio ou no botão abaixo. 🍫</div>`;
  } else {
    box.innerHTML = cart.map((l, i) => {
      const p = byId(l.product_id);
      const options = products.map((o) => `<option value="${o.id}" ${o.id === p.id ? 'selected' : ''} ${o.id !== p.id && cart.some((c) => c.product_id === o.id) ? 'disabled' : ''}>${esc(o.name)} (${money(o.price)})</option>`).join('');
      return `
      <div class="line" data-i="${i}">
        <img src="${esc(p.image)}" alt="" />
        <select class="select" aria-label="Produto" data-sel="${i}">${options}</select>
        <div class="line__meta">
          <div class="stepper">
            <button type="button" data-ldec="${i}" aria-label="Menos">−</button>
            <input type="number" inputmode="numeric" min="1" max="500" value="${l.qty}" aria-label="Quantidade" data-lqty="${i}" />
            <button type="button" data-linc="${i}" aria-label="Mais">+</button>
          </div>
          <span class="line__sub">${money(l.qty * p.price)}</span>
          <button type="button" class="icon-btn line__rm" data-lrm="${i}" aria-label="Remover">${icon('trash')}</button>
        </div>
      </div>`;
    }).join('');
  }
  const count = cartCount();
  $('#orderTotal').textContent = money(cartTotal());
  const bc = $('#bagCount');
  if (bc.textContent !== String(count)) { bc.classList.remove('bump'); void bc.offsetWidth; bc.classList.add('bump'); }
  bc.textContent = count;
  $('#mbarCount').textContent = `${count} ${count === 1 ? 'item' : 'itens'}`;
  $('#mbarTotal').textContent = money(cartTotal());
  updateMbar();
  $('#addLine').hidden = cart.length >= products.length;
}

$('#lines').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const i = +(t.dataset.linc ?? t.dataset.ldec ?? t.dataset.lrm);
  const l = cart[i];
  if (!l) return;
  if (t.dataset.linc) setQty(l.product_id, l.qty + 1);
  if (t.dataset.ldec) setQty(l.product_id, l.qty - 1);
  if (t.dataset.lrm) setQty(l.product_id, 0);
});
$('#lines').addEventListener('change', (e) => {
  if (e.target.dataset.sel) {
    const i = +e.target.dataset.sel;
    cart[i].product_id = e.target.value;
    saveJSON(CART_KEY, cart);
    renderLines();
    renderGrid($('.filters [aria-pressed="true"]').dataset.cat);
  }
  if (e.target.dataset.lqty) {
    const l = cart[+e.target.dataset.lqty];
    setQty(l.product_id, Math.max(1, parseInt(e.target.value, 10) || 1));
  }
});
$('#addLine').addEventListener('click', () => {
  const next = products.find((p) => !cart.some((l) => l.product_id === p.id));
  if (next) setQty(next.id, 1);
});

/* ---------- envio ---------- */
function wireForm() {
  const form = $('#orderForm');
  const me = loadJSON(ME_KEY, {});
  form.name.value = me.name || '';
  form.phone.value = me.phone || '';
  maskPhoneInput(form.phone);
  if (settings.accepting === false) {
    $('#submitBtn').disabled = true;
    $('#formErr').textContent = 'No momento não estamos aceitando encomendas.';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#formErr');
    err.textContent = '';
    form.name.removeAttribute('aria-invalid');
    form.phone.removeAttribute('aria-invalid');
    if (!cart.length) { err.textContent = 'Escolha pelo menos um produto 🍫'; return; }
    if (form.name.value.trim().length < 2) { form.name.setAttribute('aria-invalid', 'true'); form.name.focus(); err.textContent = 'Informe seu nome.'; return; }
    if (!isValidPhone(form.phone.value)) { form.phone.setAttribute('aria-invalid', 'true'); form.phone.focus(); err.textContent = 'Confira o WhatsApp com DDD.'; return; }

    const btn = $('#submitBtn');
    btn.disabled = true;
    btn.innerHTML = 'Enviando…';
    try {
      const snapshot = cart.map((l) => ({ ...l, p: byId(l.product_id) }));
      const r = await store.placeOrder({
        customer_name: form.name.value.trim(),
        phone: form.phone.value,
        notes: form.notes.value.trim(),
        items: cart.map(({ product_id, qty }) => ({ product_id, qty })),
        channel: 'web',
      });
      saveJSON(ME_KEY, { name: form.name.value.trim(), phone: form.phone.value });
      showDone(r, form.name.value.trim(), snapshot);
      cart = [];
      saveJSON(CART_KEY, cart);
      form.notes.value = '';
      renderLines();
      renderGrid($('.filters [aria-pressed="true"]').dataset.cat);
    } catch (ex) {
      console.error(ex);
      err.textContent = 'Não foi possível enviar agora. Tente de novo ou peça pelo WhatsApp.';
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('check')} Enviar pedido`;
    }
  });
}

function showDone(r, name, lines) {
  $('#doneName').textContent = name.split(' ')[0];
  $('#doneCode').textContent = r.code;
  const msg = `Oi! Acabei de fazer o pedido *${r.code}* pelo site 🎓\n\n${lines.map((l) => `• ${l.qty}x ${l.p.name}`).join('\n')}\n\nTotal: *${money(r.total)}*\nNome: ${name}`;
  $('#doneWa').href = waLink(msg);
  const dlg = $('#doneDialog');
  dlg.showModal();
  capsRain();
}
$('#doneClose').addEventListener('click', () => $('#doneDialog').close());

function capsRain() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = $('#capsRain');
  const svg = '<path d="m2 9 10-5 10 5-10 5L2 9Z"/><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/><path d="M22 9v5"/>';
  for (let i = 0; i < 26; i++) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.innerHTML = svg;
    el.style.left = `${Math.random() * 100}vw`;
    el.style.animationDuration = `${2.2 + Math.random() * 2}s`;
    el.style.animationDelay = `${Math.random() * 0.6}s`;
    el.style.setProperty('--r', `${(Math.random() - 0.5) * 720}deg`);
    el.style.width = `${24 + Math.random() * 22}px`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }
}

/* ---------- novidades ---------- */
async function renderNews() {
  const box = $('#newsList');
  let news = [];
  try { news = await store.listNews(); } catch (e) { console.error(e); }
  if (!news.length) {
    box.innerHTML = '<p class="news-empty">Em breve, novidades deliciosas por aqui ✨</p>';
    return;
  }
  box.innerHTML = news.slice(0, 6).map((n) => `
    <article class="news-card reveal ${n.image ? '' : 'news-card--noimg'}">
      ${n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy" />` : ''}
      <div>
        <time datetime="${n.created_at}">${fmtDate(n.created_at)}</time>
        <h3>${esc(n.title)}</h3>
        <p>${esc(n.body)}</p>
      </div>
    </article>`).join('');
  observeReveal();
}

/* ---------- carteirinha ---------- */
function wireLoyalty() {
  const input = $('#loyaltyPhone');
  maskPhoneInput(input);
  const me = loadJSON(ME_KEY, {});
  if (me.phone) input.value = me.phone;
  renderStamps(0);
  $('#loyaltyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isValidPhone(input.value)) { $('#loyaltyMsg').textContent = 'Confira o número com DDD.'; return; }
    try {
      const total = await store.loyalty(input.value);
      const goal = CONFIG.LOYALTY_GOAL;
      const prizes = Math.floor(total / goal);
      const now = total % goal;
      renderStamps(now);
      $('#loyaltyMsg').innerHTML = total === 0
        ? 'Ainda sem capelos. Que tal começar hoje? 🎓'
        : `${prizes ? `Você já completou <b>${prizes}</b> carteirinha(s)! ` : ''}Faltam <b>${goal - now}</b> pedido(s) para ${esc(CONFIG.LOYALTY_REWARD)}.`;
    } catch {
      $('#loyaltyMsg').textContent = 'Não consegui consultar agora.';
    }
  });
}

function renderStamps(n) {
  const goal = CONFIG.LOYALTY_GOAL;
  $('#stamps').innerHTML = Array.from({ length: goal }, (_, i) =>
    `<span class="stamp ${i < n ? 'on' : ''} ${i === goal - 1 ? 'prize' : ''}" style="animation-delay:${i * 70}ms">${icon(i === goal - 1 ? 'heart' : 'cap')}</span>`).join('');
  $('#stampCount').textContent = n;
}

/* ---------- detalhes ---------- */
let pedidoVisible = false;
function updateMbar() {
  $('#mbar').hidden = !cart.length || pedidoVisible;
}
function wireChrome() {
  const top = $('.top');
  addEventListener('scroll', () => top.classList.toggle('scrolled', scrollY > 8), { passive: true });
  new IntersectionObserver(([e]) => { pedidoVisible = e.isIntersecting; updateMbar(); }, { threshold: 0.15 }).observe($('#pedido'));
}

let revealIO;
function observeReveal() {
  revealIO ||= new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), revealIO.unobserve(e.target))), { threshold: 0.12 });
  $$('.reveal:not(.in)').forEach((el) => revealIO.observe(el));
}
