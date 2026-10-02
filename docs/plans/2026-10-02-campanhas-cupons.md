# Clientes, campanhas e cupons: plano de implementação

> **Para o Claude:** implemente tarefa por tarefa, na ordem. Cada tarefa termina com os testes passando e um commit. Não pule o passo de ver o teste falhar.

**Objetivo:** ver no painel quem já comprou, disparar campanhas pelo WhatsApp do bot com ritmo seguro e oferecer cupons de desconto (cota, vigência e valor) validados no servidor, no site e no bot.

**Arquitetura:** as regras do cupom ficam no banco (`coupon_discount`, usada por `place_order` e `check_coupon`) e são espelhadas num módulo JS puro (`assets/js/coupons.js`) para o modo demonstração e os testes. Campanhas viram uma fila no banco (`campaign_sends`, uma linha por pessoa) que o bot do Mac consome devagar (`bot/sender.js`). Público, texto e ritmo ficam em `assets/js/campaigns.js`, usado pelo painel e pelo bot.

**Tecnologias:** site estático em JS de módulos (sem build), Supabase (Postgres + RLS + PostgREST), bot em Node 20+ com Baileys, testes com `node --test` dentro de `bot/`.

**Desenho aprovado:** [`2026-10-02-campanhas-cupons-design.md`](2026-10-02-campanhas-cupons-design.md).

---

## Antes de começar

- A aplicação ainda não está em produção: dá para recriar `place_order` sem manter a assinatura antiga.
- Os testes rodam com `cd bot && npm test` (todos os `bot/*.test.js`). Hoje são 18 e passam.
- Outra sessão do Claude mexeu no bot enquanto este plano era escrito (commit `9133d83`). O plano foi conferido contra esse código; se o bot mudar de novo, confira os trechos "troque" antes de aplicar.
- O bot importa arquivos de fora da pasta `bot/` (`../supabase/functions/_shared/bot-engine.js`); os módulos novos de `assets/js/` são importados do mesmo jeito.
- **Regras de texto do projeto:** nada de travessão (traço longo, U+2014) nem meia-risca (U+2013) em nenhum texto, código ou comentário, e nada de citar campus ou faculdade (a loja atende vários lugares). Use vírgula, ponto, dois-pontos ou parênteses. O sinal de menos dos descontos é "−" (U+2212), que pode. Para procurar: `perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/; close ARGV if eof' arquivos...`
- Comentários seguem o estilo do código atual: poucos, em português, explicando o porquê.
- A Edge Function `supabase/functions/whatsapp-bot` (API oficial, não usada hoje) não muda; o motor ignora cupom quando o adaptador não tem `checkCoupon`.

### Tarefa 0: branch e correção das janelas do painel

**Passo 1: branch**

```bash
cd /Users/wesley/u01/pessoal/um-doce-ate-o-diploma
git checkout -b campanhas-cupons
cd bot && npm test   # esperado: 18 testes, 0 falhas
```

**Passo 2: corrigir um bug que já existe hoje**

Em `openDialog` (`assets/js/admin.js`), os dois `onclick` devolvem `false` quando o clique não é no fundo nem em `[data-close]`, e um `onclick` que devolve `false` cancela a ação padrão do clique. Resultado no código atual: o botão salvar de "Novo pedido", "Novo produto" e "Autorizar número" não envia o formulário, os interruptores dentro das janelas não mudam e os links do menu "Mais" do celular não navegam. As janelas novas deste plano dependem da correção.

Troque:

```js
  body.onclick = (e) => e.target.closest('[data-close]') && dlg.close();
  dlg.onclick = (e) => e.target === dlg && dlg.close();
```

por:

```js
  // Sem "return false": um onclick que devolve false cancela o clique (salvar, marcar, links dentro da janela).
  body.onclick = (e) => { if (e.target.closest('[data-close]')) dlg.close(); };
  dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
```

E, em `assets/css/base.css`, deixe toda janela rolar quando passar da altura da tela (a janela da campanha passa, e as atuais passam em celular pequeno). Na regra `.modal { ... }`, acrescente depois de `width`:

```css
max-height: calc(100dvh - 32px); overflow-y: auto;
```

**Passo 3: conferir no modo demonstração**

Monte a cópia em modo demonstração (roteiro na Tarefa 8, Passo 4) e confira: "Novo pedido" salva e fecha a janela; no celular, "Mais → Produtos" abre a aba Produtos.

**Passo 4: commit**

```bash
git add assets/js/admin.js assets/css/base.css
git commit -m "Painel: janelas voltam a salvar, marcar e navegar"
```

---

### Tarefa 1: regras do cupom em JS

**Arquivos:**
- Criar: `assets/js/coupons.js`
- Teste: `bot/coupons.test.js`

**Passo 1: escrever o teste**

`bot/coupons.test.js`:

```js
// npm test: regras do cupom (as mesmas do banco, em supabase/schema.sql).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneKey, evaluateCoupon, quoteCoupon, couponState, couponLabel, isCouponError, todaySP } from '../assets/js/coupons.js';

const NOW = Date.parse('2026-10-02T15:00:00Z'); // 12h em Brasília
const base = { code: 'VOLTA10', kind: 'percent', value: 10, min_order: 0, starts_on: null, ends_on: null, max_uses: null, active: true };
const check = (c, opts) => evaluateCoupon({ ...base, ...c }, { subtotal: 40, now: NOW, ...opts });

test('telefone: celular com e sem o 9 é a mesma pessoa; fixo fica como está', () => {
  assert.equal(phoneKey('5511988887777'), '5511988887777');
  assert.equal(phoneKey('551188887777'), '5511988887777');
  assert.equal(phoneKey('(11) 98888-7777'), '5511988887777');
  assert.equal(phoneKey('+55 55 99999-8888'), '5555999998888', 'DDD 55 não se confunde com o código do país');
  assert.equal(phoneKey('551133334444'), '551133334444', 'fixo não ganha 9');
  assert.notEqual(phoneKey('5511988887777'), phoneKey('5521988887777'));
});

test('desconto em porcentagem e em reais', () => {
  assert.deepEqual(check({}), { valid: true, discount: 4 });
  assert.deepEqual(check({ kind: 'fixed', value: 5 }), { valid: true, discount: 5 });
  assert.deepEqual(check({ kind: 'fixed', value: 50 }), { valid: true, discount: 40 }, 'nunca passa do subtotal');
  assert.deepEqual(check({}, { subtotal: 33.35 }), { valid: true, discount: 3.34 }, 'arredonda como o banco');
  assert.deepEqual(check({ value: 12.5 }, { subtotal: 33.35 }), { valid: true, discount: 4.17 });
});

test('pedido mínimo', () => {
  assert.deepEqual(check({ min_order: 50 }), { valid: false, message: 'Vale para pedidos a partir de R$ 50,00' });
  assert.equal(check({ min_order: 40 }).valid, true, 'igual ao mínimo vale');
});

test('vigência por dia inteiro, no horário de Brasília', () => {
  assert.equal(todaySP(Date.parse('2026-10-03T02:30:00Z')), '2026-10-02', '23h30 em Brasília ainda é dia 2');
  assert.equal(check({ ends_on: '2026-10-02' }).valid, true);
  assert.equal(check({ ends_on: '2026-10-02' }, { now: Date.parse('2026-10-03T02:59:00Z') }).valid, true, 'vale até 23h59');
  assert.equal(check({ ends_on: '2026-10-02' }, { now: Date.parse('2026-10-03T03:00:00Z') }).message, 'Cupom expirado');
  assert.equal(check({ starts_on: '2026-10-03' }).message, 'Cupom ainda não começou');
  assert.equal(check({ starts_on: '2026-10-02' }).valid, true);
});

test('cota, uma vez por WhatsApp e pausado', () => {
  assert.equal(check({ max_uses: 50 }, { uses: 49 }).valid, true);
  assert.equal(check({ max_uses: 50 }, { uses: 50 }).message, 'Cupom esgotado');
  assert.equal(check({}, { usedByPhone: true }).message, 'Você já usou este cupom');
  assert.equal(check({ active: false }).message, 'Cupom pausado');
  assert.equal(evaluateCoupon(null, { subtotal: 40 }).message, 'Cupom não encontrado');
});

test('resposta no formato do check_coupon do banco', () => {
  assert.deepEqual(quoteCoupon(base, { code: ' volta10 ', subtotal: 40, now: NOW }),
    { code: 'VOLTA10', label: '10%', min_order: 0, subtotal: 40, valid: true, discount: 4, total: 36 });
  assert.deepEqual(quoteCoupon(null, { code: 'nada', subtotal: 40, now: NOW }),
    { code: 'NADA', label: '', min_order: 0, subtotal: 40, valid: false, message: 'Cupom não encontrado' });
});

test('situação e rótulo para o painel', () => {
  assert.equal(couponState(base, 0, NOW), 'ativo');
  assert.equal(couponState({ ...base, starts_on: '2026-10-10' }, 0, NOW), 'agendado');
  assert.equal(couponState({ ...base, ends_on: '2026-10-01' }, 0, NOW), 'expirado');
  assert.equal(couponState({ ...base, max_uses: 2 }, 2, NOW), 'esgotado');
  assert.equal(couponState({ ...base, active: false }, 0, NOW), 'pausado');
  assert.equal(couponLabel({ kind: 'percent', value: 12.5 }), '12,5%');
  assert.equal(couponLabel({ kind: 'fixed', value: 5 }), 'R$ 5,00');
  assert.ok(isCouponError('Cupom esgotado'));
  assert.ok(isCouponError('Vale para pedidos a partir de R$ 30,00'));
  assert.ok(!isCouponError('Produto indisponível'));
});
```

**Passo 2: ver falhar**

Rode: `cd bot && node --test coupons.test.js`
Esperado: FAIL, `Cannot find module .../assets/js/coupons.js`.

**Passo 3: implementar**

`assets/js/coupons.js`:

```js
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
```

**Passo 4: ver passar**

Rode: `cd bot && npm test`
Esperado: todos passam (os 18 de antes e os 7 novos).

**Passo 5: commit**

```bash
git add assets/js/coupons.js bot/coupons.test.js
git commit -m "Regras do cupom de desconto em JS, com testes"
```

---

### Tarefa 2: público, texto e ritmo das campanhas

**Arquivos:**
- Criar: `assets/js/campaigns.js`
- Teste: `bot/campaigns.test.js`

**Passo 1: escrever o teste**

`bot/campaigns.test.js`:

```js
// npm test: público, texto e estimativa das campanhas (assets/js/campaigns.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneKey } from '../assets/js/coupons.js';
import { customersFromOrders, pickAudience, personalize, campaignText, finishText, spClock } from '../assets/js/campaigns.js';

const NOW = Date.parse('2026-10-02T15:00:00Z'); // 12h em Brasília
const SITE = 'https://umdoceateodiploma.com.br/';
const cust = (phone, name, orders, spent, last_order, product_ids, opted_out = false) =>
  ({ phone_key: phoneKey(phone), phone, name, orders, spent, last_order, product_ids, top_products: [], opted_out });
const ANA = cust('5511988880001', 'Ana Clara', 5, 300, '2026-09-30T12:00:00Z', ['p1']);
const BIA = cust('5511988880002', 'Bia', 1, 20, '2026-06-01T12:00:00Z', ['p2']);
const CAIO = cust('5511988880003', 'Caio', 3, 90, '2026-07-15T12:00:00Z', ['p1', 'p2'], true);
const CUSTOMERS = [ANA, BIA, CAIO];
const names = (list) => list.map((r) => r.name);

test('clientes a partir dos pedidos (igual à view admin_customers)', () => {
  const o = (phone, customer_name, total, status, created_at, items) => ({ phone, customer_name, total, status, created_at, items });
  const list = customersFromOrders([
    o('5511988887777', 'Ana', 40, 'entregue', '2026-09-01T12:00:00Z', [{ product_id: 'p1', name: 'Brigadeiro', qty: 10 }]),
    o('551188887777', 'Ana Souza', 24, 'entregue', '2026-09-20T12:00:00Z', [{ product_id: 'p2', name: 'Casadinho', qty: 6 }, { product_id: 'p1', name: 'Brigadeiro', qty: 1 }]),
    o('5511988887777', 'Ana', 99, 'cancelado', '2026-09-25T12:00:00Z', [{ product_id: 'p4', name: 'Morango', qty: 9 }]),
    o('5521977776666', 'Bia', 12, 'cancelado', '2026-09-10T12:00:00Z', [{ product_id: 'p4', name: 'Morango', qty: 1 }]),
  ], new Set(['5511988887777']));
  assert.equal(list.length, 1, 'Bia só tem pedido cancelado: não é cliente');
  assert.deepEqual(list[0], {
    phone_key: '5511988887777', phone: '551188887777', name: 'Ana Souza', orders: 2, spent: 64,
    first_order: '2026-09-01T12:00:00Z', last_order: '2026-09-20T12:00:00Z',
    product_ids: ['p1', 'p2'], top_products: ['Brigadeiro', 'Casadinho'], opted_out: true,
  });
});

test('filtros de público (quem saiu nunca entra)', () => {
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'todos' }, NOW)), ['Ana Clara', 'Bia']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'sumidos', days: 90 }, NOW)), ['Bia']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'produto', product_id: 'p1' }, NOW)), ['Ana Clara']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'fieis' }, NOW)), ['Ana Clara']);
  assert.deepEqual(names(pickAudience(CUSTOMERS, [], { type: 'top' }, NOW)), ['Ana Clara', 'Bia']);
  assert.deepEqual(pickAudience(CUSTOMERS, [], { type: 'todos' }, NOW)[0], { phone: ANA.phone, name: 'Ana Clara', phone_key: ANA.phone_key });
});

test('inscritos: inclui quem nunca comprou e não repete a mesma pessoa', () => {
  const subs = [
    { phone: '551188880001', name: 'Aninha' }, // Ana sem o 9
    { phone: '5511988880001', name: 'Ana' },
    { phone: '5521977770000', name: 'Duda' },
    { phone: CAIO.phone, name: 'Caio' },
  ];
  assert.deepEqual(names(pickAudience(CUSTOMERS, subs, { type: 'inscritos' }, NOW)), ['Ana Clara', 'Duda']);
});

test('{nome} vira o primeiro nome', () => {
  assert.equal(personalize('Oi, {nome}! Tem novidade.', 'Ana Clara'), 'Oi, Ana! Tem novidade.');
  assert.equal(personalize('Oi, {nome}! Tem novidade.', ''), 'Oi! Tem novidade.');
  assert.equal(personalize('{nome}, chegou o kit', '  '), 'chegou o kit');
});

test('texto da mensagem: cupom com link, ou link do site, e sempre como sair', () => {
  const t = campaignText({ body: 'Oi, {nome}!', coupon_code: 'VOLTA10' }, 'Ana', SITE);
  assert.match(t, /^Oi, Ana!\n\n🎟️ Cupom \*VOLTA10\*/);
  assert.match(t, /https:\/\/umdoceateodiploma\.com\.br\/\?cupom=VOLTA10/);
  assert.match(t, /responda \*cupom VOLTA10\*/);
  assert.match(t, /_Para não receber mais promoções, responda \*parar promoções\*\._$/);
  assert.match(campaignText({ body: 'Oi!' }, 'Ana', SITE), /Peça pelo site: https:\/\/umdoceateodiploma\.com\.br\/\nOu responda \*menu\*/);
});

test('estimativa de término no ritmo médio', () => {
  assert.deepEqual(spClock(NOW), { day: '2026-10-02', hour: 12, minute: 0 });
  assert.equal(finishText(47, {}, { now: NOW }), 'termina hoje por volta das 12h');
  assert.equal(finishText(200, {}, { now: NOW }), 'leva 3 dias, termina dia 04/10 por volta das 9h');
  assert.equal(finishText(10, {}, { now: Date.parse('2026-10-03T00:00:00Z') }), 'termina amanhã por volta das 9h', 'às 21h já passou do horário');
  assert.equal(finishText(10, { daily_limit: 80 }, { now: NOW, sentToday: 80 }), 'termina amanhã por volta das 9h', 'limite do dia já usado');
});
```

**Passo 2: ver falhar**

Rode: `cd bot && node --test campaigns.test.js`
Esperado: FAIL, módulo `assets/js/campaigns.js` não existe.

**Passo 3: implementar**

`assets/js/campaigns.js`:

```js
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
```

**Passo 4: ver passar**

Rode: `cd bot && npm test`
Esperado: todos passam.

**Passo 5: commit**

```bash
git add assets/js/campaigns.js bot/campaigns.test.js
git commit -m "Público, texto e ritmo das campanhas, com testes"
```

---

### Tarefa 3: banco (cupons, campanhas, clientes)

**Arquivos:**
- Modificar: `supabase/schema.sql`
- Criar: `supabase/tests/cupons.sql`

Não há como rodar Postgres aqui: o teste deste passo é o script `supabase/tests/cupons.sql`, que a pessoa dona do projeto roda no SQL Editor do Supabase (Tarefa 12). Escreva o teste primeiro mesmo assim; ele documenta as regras.

**Passo 1: escrever o teste SQL**

`supabase/tests/cupons.sql`:

```sql
-- Testes das regras de cupom direto no banco (place_order, check_coupon, admin_customers).
-- Rode no SQL Editor do Supabase depois do schema.sql. Tudo é desfeito no final (rollback):
-- se uma regra falhar, o editor mostra o erro com a explicação; se passar, aparece "Success".
-- A loja precisa estar aceitando encomendas (painel → Ajustes → Aceitando encomendas).
begin;

insert into products (id, name, price, cost, active) values ('00000000-0000-4000-8000-0000000000a1', 'Teste Brigadeiro', 10, 3, true);
insert into coupons (code, kind, value, min_order, starts_on, ends_on, max_uses, active) values
  ('TESTE10', 'percent', 10, 0, null, null, 2, true),
  ('TESTEFIX', 'fixed', 50, 0, null, null, null, true),
  ('TESTEMIN', 'fixed', 5, 30, null, null, null, true),
  ('TESTEOLD', 'percent', 10, 0, null, (now() at time zone 'America/Sao_Paulo')::date - 1, null, true),
  ('TESTENEW', 'percent', 10, 0, (now() at time zone 'America/Sao_Paulo')::date + 1, null, null, true),
  ('TESTEOFF', 'percent', 10, 0, null, null, null, false);

create function pg_temp.items(q int) returns jsonb language sql as
  $$ select jsonb_build_array(jsonb_build_object('product_id', '00000000-0000-4000-8000-0000000000a1', 'qty', q)) $$;

-- Faz o pedido e exige que seja recusado com exatamente esta mensagem.
create function pg_temp.fails_with(p_phone text, p_coupon text, p_qty int, p_msg text) returns void language plpgsql as $$
begin
  perform place_order('Teste', p_phone, pg_temp.items(p_qty), 'web', '', p_coupon);
  raise exception using errcode = 'P0004', message = format('esperava "%s" com o cupom %s, mas o pedido passou', p_msg, p_coupon);
exception when raise_exception then
  if sqlerrm <> p_msg then
    raise exception using errcode = 'P0004', message = format('esperava "%s", veio "%s"', p_msg, sqlerrm);
  end if;
end $$;

do $$
declare
  r json;
  j jsonb;
  n int;
begin
  -- 10% de R$ 30, código com espaço e minúsculas
  r := place_order('Ana Teste', '5511988887777', pg_temp.items(3), 'web', '', ' teste10 ');
  assert (r->>'subtotal')::numeric = 30 and (r->>'discount')::numeric = 3 and (r->>'total')::numeric = 27 and r->>'coupon' = 'TESTE10', 'percentual: ' || r::text;
  assert (select discount = 3 and total = 27 and coupon_code = 'TESTE10' from orders where code = r->>'code'), 'pedido gravado com o desconto';

  -- o mesmo WhatsApp sem o 9 já usou
  perform pg_temp.fails_with('551188887777', 'TESTE10', 3, 'Você já usou este cupom');

  -- cota de 2: o segundo cliente usa, o terceiro não
  perform place_order('Bia Teste', '5521977776666', pg_temp.items(3), 'web', '', 'TESTE10');
  perform pg_temp.fails_with('5531966665555', 'TESTE10', 3, 'Cupom esgotado');

  -- pedido cancelado devolve a cota
  update orders set status = 'cancelado' where code = r->>'code';
  perform place_order('Caio Teste', '5531966665555', pg_temp.items(3), 'web', '', 'TESTE10');

  -- valor fixo nunca passa do subtotal
  r := place_order('Ana Teste', '5511988887777', pg_temp.items(3), 'web', '', 'TESTEFIX');
  assert (r->>'discount')::numeric = 30 and (r->>'total')::numeric = 0, 'teto no subtotal: ' || r::text;

  -- pedido mínimo de R$ 30
  perform pg_temp.fails_with('5541955554444', 'TESTEMIN', 2, 'Vale para pedidos a partir de R$ 30,00');
  perform place_order('Davi Teste', '5541955554444', pg_temp.items(3), 'web', '', 'TESTEMIN');

  -- vigência, pausado e inexistente
  perform pg_temp.fails_with('5551944443333', 'TESTEOLD', 3, 'Cupom expirado');
  perform pg_temp.fails_with('5551944443333', 'TESTENEW', 3, 'Cupom ainda não começou');
  perform pg_temp.fails_with('5551944443333', 'TESTEOFF', 3, 'Cupom pausado');
  perform pg_temp.fails_with('5551944443333', 'NAOEXISTE', 3, 'Cupom não encontrado');

  -- sem cupom: desconto zero
  r := place_order('Eva Teste', '5561933332222', pg_temp.items(1), 'web', '', null);
  assert (r->>'discount')::numeric = 0 and (r->>'total')::numeric = 10, 'sem cupom: ' || r::text;

  -- check_coupon só confere, não grava nada
  select count(*) into n from orders;
  j := check_coupon('teste10', '5571922221111', pg_temp.items(5));
  assert j->>'valid' = 'false' and j->>'message' = 'Cupom esgotado', 'check esgotado: ' || j::text;
  j := check_coupon('TESTEMIN', '5571922221111', pg_temp.items(5));
  assert (j->>'valid')::boolean and (j->>'discount')::numeric = 5 and (j->>'total')::numeric = 45 and j->>'label' = 'R$ 5,00', 'check válido: ' || j::text;
  j := check_coupon('TESTEMIN', '', pg_temp.items(1));
  assert j->>'message' = 'Vale para pedidos a partir de R$ 30,00' and (j->>'min_order')::numeric = 30, 'check mínimo: ' || j::text;
  j := check_coupon('TESTE10', '', '[]');
  assert j->>'label' = '10%', 'rótulo em porcentagem: ' || j::text;
  assert (select count(*) from orders) = n, 'check_coupon não grava pedidos';

  -- telefone com e sem o 9 é a mesma pessoa
  assert phone_key('5511988887777') = '5511988887777' and phone_key('551188887777') = '5511988887777' and phone_key('551133334444') = '551133334444', 'phone_key';

  -- clientes: Ana aparece uma vez e o pedido cancelado não conta
  select count(*) into n from admin_customers where phone_key = '5511988887777';
  assert n = 1, 'Ana aparece uma vez só';
  assert (select orders = 1 and spent = 0 and 'Teste Brigadeiro' = any (top_products) from admin_customers where phone_key = '5511988887777'), 'resumo da Ana';
end $$;

rollback;
```

**Passo 2: ajustar `supabase/schema.sql`**

2a. Logo depois dos índices de `orders` (depois de `create index if not exists orders_status_idx ...`), acrescente:

```sql
alter table public.orders add column if not exists coupon_code text;
alter table public.orders add column if not exists discount numeric(10, 2) not null default 0;
```

2b. Logo depois da tabela `settings` (antes do bloco "Funções"), acrescente as tabelas novas:

```sql
-- Cupons de desconto. Regras em coupon_discount(); espelho em JS: assets/js/coupons.js.
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{3,20}$'),
  kind text not null default 'percent' check (kind in ('percent', 'fixed')),
  value numeric(10, 2) not null,
  min_order numeric(10, 2) not null default 0 check (min_order >= 0),
  starts_on date,
  ends_on date,
  max_uses int check (max_uses > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (value > 0 and (kind = 'fixed' or value <= 100)),
  check (ends_on >= starts_on)
);

-- Quem respondeu "parar promoções" ou "parar novidades": não recebe campanhas nem novidades.
create table if not exists public.optouts (
  phone_key text primary key,
  phone text not null,
  created_at timestamptz not null default now()
);

-- Campanhas pelo WhatsApp: cada pessoa vira uma linha em campaign_sends, que o bot envia aos poucos (bot/sender.js).
create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  body text not null,
  coupon_id uuid references public.coupons (id) on delete set null,
  audience jsonb not null default '{}',
  status text not null default 'pausada' check (status in ('enviando', 'pausada', 'concluida', 'cancelada')),
  pause_reason text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists public.campaign_sends (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  phone text not null,
  phone_key text not null,
  name text not null default '',
  status text not null default 'pendente' check (status in ('pendente', 'enviando', 'enviada', 'falhou', 'pulada')),
  error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (campaign_id, phone_key)
);
create index if not exists campaign_sends_queue_idx on public.campaign_sends (campaign_id, status);
create index if not exists campaign_sends_sent_idx on public.campaign_sends (sent_at) where status = 'enviada';
```

2c. No bloco "Funções", **troque** toda a função `place_order` (do comentário "Cria o pedido..." até o `end $$;` dela) por:

```sql
-- Mesma pessoa com e sem o 9 do celular: o número antigo ganha o 9; fixo fica como está.
-- Igual a phoneKey (assets/js/coupons.js) e a samePhone (bot-engine.js).
create or replace function public.phone_key(p text) returns text
language sql immutable set search_path = public as $$
  with a as (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d),
       b as (select case when length(d) in (10, 11) then '55' || d else d end as d from a)
  select case when d ~ '^55[0-9]{10}$' and substr(d, 5, 1) between '6' and '9' then left(d, 4) || '9' || substr(d, 5) else d end from b;
$$;

-- Regras do cupom (espelho em JS: assets/js/coupons.js). Devolve o desconto ou recusa com a mensagem para o cliente.
-- p_lock trava a linha do cupom até o fim da transação: dois pedidos ao mesmo tempo não passam da cota.
create or replace function public.coupon_discount(p_code text, p_phone text, p_subtotal numeric, p_lock boolean default false)
returns numeric language plpgsql set search_path = public as $$
declare
  c coupons;
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if p_lock then
    select * into c from coupons where code = upper(trim(p_code)) for update;
  else
    select * into c from coupons where code = upper(trim(p_code));
  end if;
  if not found then raise exception 'Cupom não encontrado'; end if;
  if not c.active then raise exception 'Cupom pausado'; end if;
  if c.starts_on is not null and v_today < c.starts_on then raise exception 'Cupom ainda não começou'; end if;
  if c.ends_on is not null and v_today > c.ends_on then raise exception 'Cupom expirado'; end if;
  if c.max_uses is not null
     and (select count(*) from orders where coupon_code = c.code and status <> 'cancelado') >= c.max_uses then
    raise exception 'Cupom esgotado';
  end if;
  if exists (select 1 from orders where coupon_code = c.code and status <> 'cancelado' and phone_key(phone) = phone_key(p_phone)) then
    raise exception 'Você já usou este cupom';
  end if;
  if p_subtotal < c.min_order then
    raise exception 'Vale para pedidos a partir de R$ %', replace(to_char(c.min_order, 'FM999990.00'), '.', ',');
  end if;
  return round(least(p_subtotal, case when c.kind = 'percent' then p_subtotal * c.value / 100 else c.value end), 2);
end $$;

-- Cria o pedido calculando preço, custo e desconto NO SERVIDOR (o cliente nunca define valores).
drop function if exists public.place_order(text, text, jsonb, text, text);
create or replace function public.place_order(
  p_name text, p_phone text, p_items jsonb, p_channel text default 'web', p_notes text default '', p_coupon text default null
) returns json
language plpgsql security definer set search_path = public as $$
declare
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_cost numeric := 0;
  v_coupon text := nullif(upper(trim(coalesce(p_coupon, ''))), '');
  v_discount numeric := 0;
  v_code text;
  r record;
  v_accepting boolean;
begin
  select coalesce((value->>'accepting')::boolean, true) into v_accepting from settings where key = 'store';
  if v_accepting is false and not is_admin() then
    raise exception 'Não estamos aceitando encomendas no momento';
  end if;
  if p_channel not in ('web', 'whatsapp', 'grupo', 'balcao') then raise exception 'canal inválido'; end if;
  if p_channel = 'balcao' and not is_admin() then raise exception 'canal inválido'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then
    raise exception 'itens inválidos';
  end if;

  for r in
    select p.id, p.name, p.price, p.cost, least(greatest((i->>'qty')::int, 1), 500) as qty
    from jsonb_array_elements(p_items) i
    join products p on p.id = (i->>'product_id')::uuid and p.active
  loop
    v_items := v_items || jsonb_build_object('product_id', r.id, 'name', r.name, 'qty', r.qty, 'unit_price', r.price, 'unit_cost', r.cost);
    v_total := v_total + r.qty * r.price;
    v_cost := v_cost + r.qty * r.cost;
  end loop;
  if jsonb_array_length(v_items) = 0 then raise exception 'Produto indisponível'; end if;

  if v_coupon is not null then
    v_discount := coupon_discount(v_coupon, p_phone, v_total, true);
  end if;

  loop
    v_code := 'DD-' || upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=0O1Il', ''), 1, 4));
    exit when length(v_code) = 7 and not exists (select 1 from orders where code = v_code);
  end loop;

  insert into orders (code, customer_name, phone, items, total, cost_total, channel, notes, coupon_code, discount)
  values (v_code, trim(p_name), regexp_replace(p_phone, '\D', '', 'g'), v_items, v_total - v_discount, v_cost, p_channel,
          left(coalesce(p_notes, ''), 300), v_coupon, v_discount);

  return json_build_object('code', v_code, 'total', v_total - v_discount, 'subtotal', v_total, 'discount', v_discount, 'coupon', v_coupon);
end $$;
```

2d. Logo depois da função `loyalty_stamps`, acrescente:

```sql
-- Prévia do cupom para o site e o bot: as mesmas regras de place_order, sem gravar nada.
create or replace function public.check_coupon(p_code text, p_phone text default '', p_items jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c coupons;
  v_subtotal numeric := 0;
  v_discount numeric;
  v_out jsonb;
begin
  select * into c from coupons where code = upper(trim(coalesce(p_code, '')));
  if jsonb_typeof(p_items) = 'array' then
    select coalesce(sum(least(greatest((i->>'qty')::int, 1), 500) * p.price), 0) into v_subtotal
    from jsonb_array_elements(p_items) i
    join products p on p.id = (i->>'product_id')::uuid and p.active;
  end if;
  v_out := jsonb_build_object(
    'code', upper(trim(coalesce(p_code, ''))),
    'subtotal', v_subtotal,
    'min_order', coalesce(c.min_order, 0),
    'label', case
      when c.id is null then ''
      when c.kind = 'percent' then replace(rtrim(rtrim(c.value::text, '0'), '.'), '.', ',') || '%'
      else 'R$ ' || replace(to_char(c.value, 'FM999990.00'), '.', ',')
    end);
  begin
    v_discount := coupon_discount(p_code, coalesce(p_phone, ''), v_subtotal);
  exception when raise_exception then
    return v_out || jsonb_build_object('valid', false, 'message', sqlerrm);
  end;
  return v_out || jsonb_build_object('valid', true, 'discount', v_discount, 'total', v_subtotal - v_discount);
end $$;

-- Clientes = quem já comprou (pedido não cancelado), agrupado por phone_key.
-- security_invoker: vale a RLS de orders, então só admin enxerga. Espelho em JS: customersFromOrders (assets/js/campaigns.js).
drop view if exists public.admin_customers;
create view public.admin_customers with (security_invoker = true) as
with valid as (
  select o.*, phone_key(o.phone) as k from orders o where o.status <> 'cancelado'
), base as (
  select k,
    (array_agg(phone order by created_at desc))[1] as phone,
    (array_agg(customer_name order by created_at desc))[1] as name,
    count(*)::int as orders,
    sum(total) as spent,
    min(created_at) as first_order,
    max(created_at) as last_order
  from valid group by k
), lines as (
  select k, i->>'product_id' as product_id, max(i->>'name') as name, sum((i->>'qty')::int) as qty
  from valid, jsonb_array_elements(items) i
  group by k, i->>'product_id'
), prods as (
  select k, array_agg(product_id order by qty desc) as product_ids, (array_agg(name order by qty desc))[1:3] as top_products
  from lines group by k
)
select b.k as phone_key, b.phone, b.name, b.orders, b.spent, b.first_order, b.last_order,
  coalesce(p.product_ids, '{}') as product_ids,
  coalesce(p.top_products, '{}') as top_products,
  exists (select 1 from optouts x where x.phone_key = b.k) as opted_out
from base b left join prods p on p.k = b.k;
```

2e. Nos `grant execute`, troque a linha de `place_order` e acrescente as novas:

```sql
grant execute on function public.place_order(text, text, jsonb, text, text, text) to anon, authenticated;
grant execute on function public.check_coupon(text, text, jsonb) to anon, authenticated;
-- coupon_discount só é chamada por place_order e check_coupon.
revoke execute on function public.coupon_discount(text, text, numeric, boolean) from public, anon, authenticated;
revoke all on public.admin_customers from anon;
grant select on public.admin_customers to authenticated;
```

2f. No bloco RLS, junto dos outros `enable row level security`:

```sql
alter table public.coupons enable row level security;
alter table public.optouts enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_sends enable row level security;
```

e, depois das políticas de `settings`:

```sql
-- Cupons, campanhas e a lista de quem saiu: só admin pelo navegador. O bot usa a chave secreta.
drop policy if exists "coupons admin" on public.coupons;
create policy "coupons admin" on public.coupons for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "optouts admin" on public.optouts;
create policy "optouts admin" on public.optouts for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "campaigns admin" on public.campaigns;
create policy "campaigns admin" on public.campaigns for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists "campaign_sends admin" on public.campaign_sends;
create policy "campaign_sends admin" on public.campaign_sends for all using (public.is_admin()) with check (public.is_admin());
```

2g. Em "Dados iniciais", depois do insert de `store`:

```sql
insert into public.settings (key, value) values
  ('campaigns', '{"daily_limit": 80, "start_hour": 9, "end_hour": 20}')
on conflict (key) do nothing;
```

**Passo 3: conferir**

```bash
grep -n 'place_order(text, text, jsonb, text, text)' supabase/schema.sql
# esperado: só a linha do "drop function if exists"
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/; close ARGV if eof' supabase/schema.sql supabase/tests/cupons.sql
# esperado: nada
```

**Passo 4: commit**

```bash
git add supabase/schema.sql supabase/tests/cupons.sql
git commit -m "Banco: cupons, campanhas, lista de saída e view de clientes"
```

---

### Tarefa 4: motor do bot com cupom e "parar promoções"

**Arquivos:**
- Modificar: `supabase/functions/_shared/bot-engine.js`
- Teste: `bot/core.test.js`

O motor classifica cada mensagem com `detectIntent` (`keyword`, `unsubscribe`, `subscribe`, `site`, `order` ou `null`) e o `core.js` decide se o bot entra na conversa. Esta tarefa acrescenta o tipo `coupon` e o cupom na sessão; o `core.js` não muda (qualquer tipo não nulo já abre a conversa, e durante a pausa só `keyword` chama o bot de volta).

**Passo 1: preparar o teste com cupons falsos**

Em `bot/core.test.js`, logo depois do import de `bot-engine.js`, acrescente:

```js
import { quoteCoupon, phoneKey } from '../assets/js/coupons.js';
```

Depois de `const CRIS = ...`, acrescente:

```js
const C = { kind: 'percent', value: 10, min_order: 0, starts_on: null, ends_on: null, max_uses: null, active: true };
const COUPONS = {
  VOLTA10: { ...C, code: 'VOLTA10' },
  DOCE5: { ...C, code: 'DOCE5', kind: 'fixed', value: 5, min_order: 30 },
  FIM1: { ...C, code: 'FIM1', max_uses: 1 },
  VELHO1: { ...C, code: 'VELHO1', ends_on: '2026-09-30' },
};
const subtotalOf = (items) => items.reduce((s, i) => s + i.qty * PRODUCTS.find((p) => p.id === i.product_id).price, 0);
```

Na função `setup`, logo depois de `const news = [];`, acrescente:

```js
  const used = new Map(); // código → Set de phoneKey de quem já usou
  const checkCoupon = async (code, phone, items) => {
    const c = COUPONS[String(code).toUpperCase()];
    const u = used.get(c?.code) || new Set();
    return quoteCoupon(c, { code, subtotal: subtotalOf(items), uses: u.size, usedByPhone: u.has(phoneKey(phone)), now: clock });
  };
```

No objeto `ctx` do `setup`, troque o `placeOrder` falso (o que devolve `DD-TEST`) por:

```js
    checkCoupon,
    placeOrder: async (o) => {
      if (failOrder) throw new Error('banco fora do ar');
      const subtotal = subtotalOf(o.items);
      let discount = 0;
      if (o.coupon) {
        const q = await checkCoupon(o.coupon, o.phone, o.items);
        if (!q.valid) throw new Error(q.message);
        discount = q.discount;
        if (!used.has(q.code)) used.set(q.code, new Set());
        used.get(q.code).add(phoneKey(o.phone));
      }
      orders.push(o);
      return { code: 'DD-TEST', total: subtotal - discount, discount };
    },
```

E no `return` do `setup`, acrescente `used`:

```js
  return { core, say, rows, orders, subs, news, used, tick: (ms) => { clock += ms; } };
```

**Passo 2: escrever os testes novos**

No teste `identifica mensagens de encomenda`, acrescente ao objeto `cases`:

```js
    'cupom VOLTA10': 'coupon', 'Oi, tenho o cupom doce5': 'coupon', 'parar promoções': 'unsubscribe', 'quero receber promoções': 'subscribe',
    'qual cupom tem hoje?': null, 'tem cupom do ifood?': null,
```

No fim do arquivo, acrescente:

```js
test('cupom no pedido escrito: desconto no resumo e no pedido', async () => {
  const { say, orders } = setup();
  const [r] = await say('quero 10 brigadeiros cupom volta10');
  assert.match(r, /Cupom \*VOLTA10\* anotado: 10% de desconto/);
  assert.match(r, /Desconto VOLTA10: −R\$ 4,00/);
  assert.match(r, /\*Total: R\$ 36,00\*/);
  await say('1'); // nome do perfil
  const [done] = await say('1');
  assert.match(done, /Total: \*R\$ 36,00\* \(já com R\$ 4,00 de desconto\)/);
  assert.equal(orders[0].coupon, 'VOLTA10');
});

test('"cupom X" sozinho chama o bot e fica guardado para o pedido', async () => {
  const { say, orders } = setup();
  const [r] = await say('Oi! cupom VOLTA10');
  assert.match(r, /anotado/);
  assert.match(r, /Mande \*1\* para encomendar/);
  assert.match((await say('quero 5 casadinhos'))[0], /Desconto VOLTA10: −R\$ 2,00/);
  await say('1');
  await say('1');
  assert.equal(orders[0].coupon, 'VOLTA10');
});

test('só o código, no meio da conversa, também vale', async () => {
  const { say } = setup();
  await say('quero 10 brigadeiros');
  await say('Ana');
  const [r] = await say('VOLTA10');
  assert.match(r, /\*Total: R\$ 36,00\*/);
  assert.match(r, /\*1\* ✅ Confirmar/);
});

test('cupom recusado explica o motivo', async () => {
  for (const [code, msg] of Object.entries({ VELHO1: 'Cupom expirado', NADA99: 'Cupom não encontrado' })) {
    const { say } = setup();
    await say('quero 10 brigadeiros');
    assert.match((await say(`cupom ${code}`))[0], new RegExp(msg));
  }
});

test('pedido mínimo: o cupom fica anotado e entra quando o pedido chega lá', async () => {
  const { say } = setup();
  assert.match((await say('cupom DOCE5'))[0], /R\$ 5,00 de desconto em pedidos a partir de R\$ 30,00/);
  assert.match((await say('quero 5 brigadeiros'))[0], /não aplicado: Vale para pedidos a partir de R\$ 30,00/);
  await say('Ana');
  await say('2'); // adicionar mais itens
  await say('1'); // brigadeiro
  await say('5');
  await say('0'); // finalizar
  const [r] = await say('1'); // nome do perfil
  assert.match(r, /Desconto DOCE5: −R\$ 5,00/);
  assert.match(r, /\*Total: R\$ 35,00\*/);
});

test('cupom esgotou antes de confirmar: avisa e oferece seguir sem ele', async () => {
  const { say, used, orders } = setup();
  await say('quero 10 brigadeiros cupom FIM1');
  await say('1');
  used.set('FIM1', new Set(['outra-pessoa'])); // alguém usou a última unidade
  const [r] = await say('1');
  assert.match(r, /Cupom esgotado, então tirei o cupom/);
  assert.match(r, /\*Total: R\$ 40,00\*/);
  assert.equal(orders.length, 0);
  await say('1');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].coupon, undefined);
});

test('"parar promoções" tira das campanhas e das novidades', async () => {
  const { say, subs } = setup({ subscribed: [ANA] });
  assert.match((await say('parar promoções'))[0], /não vou mais enviar novidades nem promoções/);
  assert.ok(!subs.has(ANA));
  assert.deepEqual(await setup().say('parar promoções'), [], 'quem não recebia nada fica sem resposta (pode ser conversa)');
});
```

**Passo 3: ver falhar**

Rode: `cd bot && npm test`
Esperado: FAIL nos testes novos (por exemplo `cupom VOLTA10` ainda não é `coupon`, e o resumo não mostra desconto). Os testes antigos continuam passando.

**Passo 4: implementar no motor**

Em `supabase/functions/_shared/bot-engine.js`, faça as trocas abaixo. Cada trecho "troque" aparece uma vez só no arquivo.

4a. Logo antes do comentário `// Número de uso pessoal: o bot só entra na conversa quando a mensagem é claramente sobre encomenda.`, acrescente:

```js
// "cupom VOLTA10" → 'VOLTA10'. O código precisa ter número ou vir em maiúsculas: "qual cupom tem hoje?" não é cupom.
const COUPON_PHRASE = /\bcupom\s*:?\s*([a-z0-9]{3,20})\b/i;
export function couponCodeIn(text) {
  const m = COUPON_PHRASE.exec(String(text || ''));
  return m && (/\d/.test(m[1]) || m[1] === m[1].toUpperCase()) ? m[1].toUpperCase() : null;
}
// Só o código, no meio de uma conversa: letras e números juntos, como VOLTA10.
const BARE_CODE = /^(?=.*\d)(?=.*[a-z])[a-z0-9]{4,20}$/i;
// Mesmas mensagens de recusa de coupon_discount (supabase/schema.sql).
const COUPON_ERROR = /^(Cupom |Você já usou|Vale para pedidos)/;
const MIN_ORDER = /^Vale para pedidos/;
```

4b. Na lista de tipos do comentário, depois da linha do `'site'`, acrescente:

```js
//   'coupon'      → "cupom VOLTA10" (o motor anota o cupom para o pedido)
```

4c. Troque as linhas de `UNSUBSCRIBE` e `SUBSCRIBE` por (só muda o final: aceitam também "promoções"):

```js
export const UNSUBSCRIBE = /\b(?:parar|pare|para de|sair|cancelar|cancela|descadastrar|descadastra|remover|remove|tirar|tira|chega de|nao (?:quero|desejo) mais(?: receber)?)\b(?:\s+[a-z]+){0,4}?\s+(?:novidades|promocoes)\b/;
const SUBSCRIBE = /^(?:quero|queria|gostaria de) receber (?:as )?(?:novidades|promocoes)(?: (?:por aqui|aqui|de voces))?$/;
```

4d. Em `detectIntent`, logo depois da linha que devolve `'site'`, acrescente:

```js
  if (couponCodeIn(text)) return 'coupon';
```

4e. Troque a função `confirmText` inteira por:

```js
const cartItems = (cart) => (cart || []).map((i) => ({ product_id: i.product_id, qty: i.qty }));
const CONFIRM_OPTIONS = '\n\n*1* ✅ Confirmar\n*2* ➕ Adicionar mais itens\n*3* ❌ Cancelar';

// Resumo do pedido com o desconto do cupom, conferido de novo a cada vez (o carrinho pode ter mudado).
// Cupom que não vale mais sai da sessão; se só falta chegar ao pedido mínimo, continua anotado.
async function summary(s, ctx, phone) {
  const head = `Seu pedido até aqui:\n${cartText(s.cart)}`;
  const subtotal = cartTotal(s.cart);
  if (!s.coupon || !ctx.checkCoupon) return `${head}\n*Total: ${brl(subtotal)}*`;
  const r = await ctx.checkCoupon(s.coupon, phone, cartItems(s.cart));
  if (r.valid) return `${head}\nSubtotal: ${brl(subtotal)}\n🎟️ Desconto ${r.code}: −${brl(r.discount)}\n*Total: ${brl(r.total)}*`;
  const code = s.coupon;
  if (!MIN_ORDER.test(r.message)) delete s.coupon;
  return `${head}\n⚠️ Cupom ${code} não aplicado: ${r.message}.\n*Total: ${brl(subtotal)}*`;
}
```

4f. Em `handleMessage`:

O cupom anotado sobrevive ao "oi"/"menu". Troque:

```js
    await save({ state: 'menu', cart: s.cart || [], menuShown: true });
```

por:

```js
    await save({ state: 'menu', cart: s.cart || [], menuShown: true, coupon: s.coupon });
```

A saída vale para novidades e promoções. Troque:

```js
    return was === false ? [] : ['Ok, não vou mais enviar novidades. 💛'];
```

por:

```js
    return was === false ? [] : ['Ok, não vou mais enviar novidades nem promoções. 💛 Se mudar de ideia, mande *quero receber novidades*.'];
```

Logo antes do comentário `// Atalho: pedido em linguagem natural (...)`, acrescente o bloco do cupom:

```js
  // Cupom: "cupom VOLTA10" em qualquer mensagem, ou só o código no meio da conversa.
  const coupon = ctx.checkCoupon
    ? couponCodeIn(text) || (['menu', 'more', 'confirm'].includes(s.state) && BARE_CODE.test(text) ? text.toUpperCase() : null)
    : null;
  let note = '';
  if (coupon) {
    const r = await ctx.checkCoupon(coupon, phone, cartItems(s.cart));
    // Abaixo do pedido mínimo ainda vale anotar: o resumo confere de novo quando o carrinho crescer.
    const minOnly = !r.valid && MIN_ORDER.test(r.message || '');
    if (!r.valid && !minOnly) {
      if (s.state !== 'confirm') return [`🎟️ ${r.message}.`];
      const sum = await summary(s, ctx, phone);
      await save(s);
      return [`🎟️ ${r.message}.\n\n${sum}${CONFIRM_OPTIONS}`];
    }
    s = { ...s, coupon: r.code };
    await save(s);
    note = `🎟️ Cupom *${r.code}* anotado: ${r.label} de desconto${r.min_order ? ` em pedidos a partir de ${brl(r.min_order)}` : ''}.`;
  }
```

Troque o bloco do atalho (de `const quick = parseQuickOrder(...)` até o `}` que fecha o `if`) por:

```js
  const quick = parseQuickOrder(text.replace(/^#pedido/i, '').replace(COUPON_PHRASE, ' '), products);
  if (quick.length && ['menu', 'product', 'more'].includes(s.state)) {
    const cart = s.cart || [];
    quick.forEach(({ product, qty }) => addToCart(cart, product, qty));
    s = { ...s, cart, state: 'name', fromGroup: !!msg.isGroup || s.fromGroup };
    const sum = await summary(s, ctx, phone);
    await save(s);
    const intro = msg.isGroup ? `Anotado, ${msg.profileName || 'pessoal'}! Vou continuar com você no privado 😉\n\n` : '';
    return [`${intro}${note ? `${note}\n\n` : ''}${sum}\n\nPara quem é o pedido? Mande seu *nome*${msg.profileName ? ` ou *1* para usar "${msg.profileName}"` : ''}.`];
  }

  // Mensagem só com o cupom: anota e segue de onde a conversa estava.
  if (note) {
    if (s.state === 'confirm') {
      const sum = await summary(s, ctx, phone);
      await save(s);
      return [`${note}\n\n${sum}${CONFIRM_OPTIONS}`];
    }
    s = { ...s, state: s.cart?.length ? 'more' : 'menu', pending: undefined };
    await save(s);
    return [s.cart?.length
      ? `${note}\n\nQuer mais alguma coisa? Mande o *número* de outro produto ou *0* para finalizar.\n\n${catalogText(products)}`
      : `${note}\n\nMande *1* para encomendar ou escreva direto, tipo "quero 10 brigadeiros".`];
  }
```

No `case 'qty'`, o cupom passa adiante nos dois `save`:

```js
      if (!p) { await save({ state: 'product', cart: s.cart, coupon: s.coupon }); return ['Ops, perdi o produto. Escolha de novo, por favor.']; }
```

```js
      await save({ state: 'more', cart, coupon: s.coupon });
```

No `case 'name'`, troque o fim (`await save(next);` e `return [confirmText(next)];`) por:

```js
      const sum = await summary(next, ctx, phone);
      await save(next);
      return [`${sum}${CONFIRM_OPTIONS}`];
```

No `case 'confirm'`, troque a gravação do pedido (de `const r = await ctx.placeOrder({` até o `return` com "Pedido ... recebido!") por:

```js
        let r;
        try {
          r = await ctx.placeOrder({
            customer_name: s.name, phone, channel: s.fromGroup ? 'grupo' : 'whatsapp', items: cartItems(s.cart),
            ...(s.coupon ? { coupon: s.coupon } : {}),
          });
        } catch (e) {
          // O cupom deixou de valer entre o resumo e a confirmação (esgotou, expirou): segue sem ele.
          if (!s.coupon || !COUPON_ERROR.test(e.message)) throw e;
          const next = { ...s, coupon: undefined };
          await save(next);
          return [`🎟️ ${e.message}, então tirei o cupom.\n\n${await summary(next, ctx, phone)}${CONFIRM_OPTIONS}`];
        }
        await save(null);
        const pix = settings.pix_key ? `\n\n💸 Pix: *${settings.pix_key}*` : '';
        const off = Number(r.discount) > 0 ? ` (já com ${brl(r.discount)} de desconto)` : '';
        return [`🎓 Pedido *${r.code}* recebido!\nTotal: *${brl(r.total)}*${off}${pix}\n\nTe aviso por aqui quando estiver pronto. Obrigada, ${s.name.split(' ')[0]}! 💛`];
```

e, na última linha do `case 'confirm'`, troque `return [confirmText(s)];` por:

```js
      const sum = await summary(s, ctx, phone);
      await save(s);
      return [`${sum}${CONFIRM_OPTIONS}`];
```

Ao final, `confirmText` não pode aparecer mais no arquivo (`grep -n confirmText supabase/functions/_shared/bot-engine.js` não mostra nada).

**Passo 5: ver passar**

Rode: `cd bot && npm test`
Esperado: todos passam, os antigos e os novos.

**Passo 6: commit**

```bash
git add supabase/functions/_shared/bot-engine.js bot/core.test.js
git commit -m "Bot entende cupom e \"parar promoções\""
```

---

### Tarefa 5: envio das campanhas (ritmo e regras)

**Arquivos:**
- Criar: `bot/sender.js`
- Teste: `bot/sender.test.js`

**Passo 1: escrever o teste**

`bot/sender.test.js`:

```js
// npm test: ritmo e regras do envio de campanhas (sender.js), com banco e WhatsApp falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSender, STALE_MS } from './sender.js';

const at = (iso) => Date.parse(iso);
const NOON = at('2026-10-02T15:00:00Z'); // 12h em Brasília
const iso = (ms) => new Date(ms).toISOString();

function setup({ people = 3, settings = {}, optedOut = [], noWa = [], failSend = () => false } = {}) {
  let clock = NOON;
  let online = true;
  const campaigns = [{ id: 'c1', name: 'Volta', body: 'Oi, {nome}! Tem novidade.', coupon_code: 'VOLTA10', status: 'enviando', pause_reason: null }];
  const sends = Array.from({ length: people }, (_, i) => ({
    id: `s${i}`, campaign_id: 'c1', phone: `551198888000${i}`, phone_key: `k${i}`, name: `Pessoa${i} Silva`,
    status: 'pendente', error: null, claimed_at: null, sent_at: null,
  }));
  const sent = [];
  const db = {
    settings: async () => settings,
    requeueStale: async (before) => sends.filter((s) => s.status === 'enviando' && s.claimed_at < before).forEach((s) => { s.status = 'pendente'; }),
    sentSince: async (since) => sends.filter((s) => s.status === 'enviada' && s.sent_at >= since).length,
    nextCampaign: async () => campaigns.find((c) => c.status === 'enviando') || null,
    claim: async (campaignId, now) => {
      const s = sends.find((x) => x.campaign_id === campaignId && x.status === 'pendente');
      if (s) Object.assign(s, { status: 'enviando', claimed_at: now });
      return s || null;
    },
    isOptedOut: async (key) => optedOut.includes(key),
    mark: async (id, patch) => { Object.assign(sends.find((s) => s.id === id), patch); },
    pause: async (id, reason) => { Object.assign(campaigns.find((c) => c.id === id), { status: 'pausada', pause_reason: reason }); },
    finish: async (id) => {
      if (sends.some((s) => s.campaign_id === id && ['pendente', 'enviando'].includes(s.status))) return false;
      Object.assign(campaigns.find((c) => c.id === id), { status: 'concluida' });
      return true;
    },
  };
  const wa = {
    online: () => online,
    lookup: async (phone) => (noWa.includes(phone) ? null : `${phone}@s.whatsapp.net`),
    send: async (jid, text) => { if (failSend(jid)) return false; sent.push({ jid, text }); return true; },
  };
  const sender = createSender({ db, wa, siteUrl: 'https://umdoceateodiploma.com.br/', now: () => clock, random: () => 0.5, log: () => {} });
  return {
    tick: () => sender.tick(), sends, sent, campaigns,
    wait: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; }, setOnline: (v) => { online = v; },
  };
}

test('envia uma por vez e espera entre uma e outra', async () => {
  const { tick, wait, sent } = setup();
  assert.equal(await tick(), 'enviada');
  assert.equal(await tick(), 'aguardando', 'logo em seguida ainda não');
  wait(40e3); // random 0,5 → 40 s
  assert.equal(await tick(), 'enviada');
  assert.match(sent[0].text, /^Oi, Pessoa0! Tem novidade\./);
  assert.match(sent[0].text, /\?cupom=VOLTA10/);
  assert.match(sent[0].text, /parar promoções/);
  assert.equal(sent[0].jid, '5511988880000@s.whatsapp.net');
});

test('só no horário de Brasília', async () => {
  const { tick, setClock } = setup();
  setClock(at('2026-10-02T11:30:00Z')); // 8h30
  assert.equal(await tick(), 'fora do horário');
  setClock(at('2026-10-02T22:59:00Z')); // 19h59
  assert.equal(await tick(), 'enviada');
  setClock(at('2026-10-02T23:00:00Z')); // 20h
  assert.equal(await tick(), 'fora do horário');
});

test('limite do dia, e no dia seguinte continua', async () => {
  const { tick, wait, setClock } = setup({ people: 5, settings: { daily_limit: 2 } });
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'limite do dia');
  setClock(at('2026-10-03T12:00:00Z')); // 9h do dia seguinte
  assert.equal(await tick(), 'enviada');
});

test('pula quem saiu e marca número sem WhatsApp, sem travar a fila', async () => {
  const { tick, sends } = setup({ optedOut: ['k0'], noWa: ['5511988880001'] });
  assert.equal(await tick(), 'pulada');
  assert.equal(await tick(), 'sem whatsapp');
  assert.equal(await tick(), 'enviada');
  assert.deepEqual(sends.map((s) => s.status), ['pulada', 'falhou', 'enviada']);
  assert.equal(sends[1].error, 'Número sem WhatsApp');
});

test('5 erros de envio seguidos pausam a campanha', async () => {
  const { tick, wait, campaigns } = setup({ people: 6, failSend: () => true });
  for (let i = 0; i < 5; i++) {
    assert.equal(await tick(), 'falhou');
    wait(40e3);
  }
  assert.equal(campaigns[0].status, 'pausada');
  assert.match(campaigns[0].pause_reason, /5 envios seguidos falharam/);
  assert.equal(await tick(), 'sem campanha');
});

test('mensagem presa em "enviando" volta para a fila; campanha só conclui no fim', async () => {
  const { tick, wait, sends, campaigns } = setup({ people: 2 });
  Object.assign(sends[0], { status: 'enviando', claimed_at: iso(NOON - STALE_MS - 1000) }); // bot caiu há mais de 5 min
  Object.assign(sends[1], { status: 'enviando', claimed_at: iso(NOON - 60e3) }); // ainda pode estar saindo
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'aguardando', 'não conclui com mensagem ainda em envio');
  wait(STALE_MS);
  assert.equal(await tick(), 'enviada');
  wait(40e3);
  assert.equal(await tick(), 'concluída');
  assert.equal(campaigns[0].status, 'concluida');
});

test('WhatsApp desconectado: a fila só espera', async () => {
  const { tick, setOnline, sent } = setup();
  setOnline(false);
  assert.equal(await tick(), 'offline');
  assert.equal(sent.length, 0);
});
```

**Passo 2: ver falhar**

Rode: `cd bot && node --test sender.test.js`
Esperado: FAIL, `Cannot find module './sender.js'`.

**Passo 3: implementar**

`bot/sender.js`:

```js
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
```

**Passo 4: ver passar**

Rode: `cd bot && npm test`
Esperado: todos passam.

**Passo 5: commit**

```bash
git add bot/sender.js bot/sender.test.js
git commit -m "Envio das campanhas com ritmo seguro, com testes"
```

---

### Tarefa 6: ligar cupom, saída e envio no bot do Mac

**Arquivos:**
- Modificar: `bot/index.js`

Sem teste automático (é a cola com Baileys e Supabase). A verificação é `node --check` agora e o teste real na Tarefa 12.

**Passo 1: imports e constante**

Depois de `import { createCore, PAUSE_TTL_MS } from './core.js';`:

```js
import { createSender } from './sender.js';
import { phoneKey } from '../assets/js/coupons.js';
```

Depois de `const TICK_MS = 30_000;`:

```js
const CAMPAIGN_TICK_MS = 5_000; // o ritmo de verdade (20 a 60 s entre mensagens) fica em sender.js
```

**Passo 2: adaptador do motor (`ctx`)**

Troque `subscribe` e `placeOrder` (são vizinhos no objeto) e acrescente `checkCoupon`:

```js
  // "parar novidades/promoções" vale para tudo: sai dos inscritos e entra na lista de quem não quer receber.
  // Devolve false quando a pessoa nem era inscrita nem recebeu campanha: o motor fica quieto (pode ser só conversa).
  subscribe: async (phone, name, on) => {
    const key = phoneKey(phone);
    if (on) {
      await db.from('subscribers').upsert({ phone, name });
      await db.from('optouts').delete().eq('phone_key', key);
      return;
    }
    const { data } = await db.from('subscribers').delete().eq('phone', phone).select('phone');
    const { count } = await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('phone_key', key).eq('status', 'enviada');
    await db.from('optouts').upsert({ phone_key: key, phone });
    return !!data?.length || count > 0;
  },
  checkCoupon: async (code, phone, items) => {
    const { data, error } = await db.rpc('check_coupon', { p_code: code, p_phone: phone, p_items: items });
    if (error) throw new Error(error.message);
    return data;
  },
  placeOrder: async (o) => {
    const { data, error } = await db.rpc('place_order', {
      p_name: o.customer_name, p_phone: o.phone, p_items: o.items, p_channel: o.channel, p_notes: '', p_coupon: o.coupon ?? null,
    });
    if (error) throw new Error(error.message);
    return data;
  },
```

**Passo 3: fila das campanhas**

Depois de `const core = createCore({ ctx, sessions });`, acrescente:

```js
// Fila das campanhas (tabelas campaigns e campaign_sends). Ritmo e regras ficam em sender.js.
const must = ({ data, error, count }) => {
  if (error) throw new Error(error.message);
  return count ?? data;
};
const campaignDb = {
  settings: async () => must(await db.from('settings').select('value').eq('key', 'campaigns').maybeSingle())?.value ?? {},
  requeueStale: async (before) => must(await db.from('campaign_sends').update({ status: 'pendente' }).eq('status', 'enviando').lt('claimed_at', before)),
  sentSince: async (since) => must(await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('status', 'enviada').gte('sent_at', since)) || 0,
  nextCampaign: async () => {
    const c = must(await db.from('campaigns').select('id, name, body, coupons(code)').eq('status', 'enviando').order('created_at').limit(1).maybeSingle());
    return c && { ...c, coupon_code: c.coupons?.code || null };
  },
  // Pega o próximo da fila marcando "enviando" só se ainda estiver pendente.
  claim: async (campaignId, now) => {
    for (let i = 0; i < 3; i++) {
      const next = must(await db.from('campaign_sends').select('id').eq('campaign_id', campaignId).eq('status', 'pendente').order('id').limit(1).maybeSingle());
      if (!next) return null;
      const row = must(await db.from('campaign_sends').update({ status: 'enviando', claimed_at: now }).eq('id', next.id).eq('status', 'pendente').select().maybeSingle());
      if (row) return row;
    }
    return null;
  },
  isOptedOut: async (key) => !!must(await db.from('optouts').select('phone_key').eq('phone_key', key).maybeSingle()),
  mark: async (id, patch) => must(await db.from('campaign_sends').update(patch).eq('id', id)),
  pause: async (id, reason) => must(await db.from('campaigns').update({ status: 'pausada', pause_reason: reason }).eq('id', id)),
  finish: async (id) => {
    const open = must(await db.from('campaign_sends').select('id', { count: 'exact', head: true }).eq('campaign_id', id).in('status', ['pendente', 'enviando']));
    if (open) return false;
    must(await db.from('campaigns').update({ status: 'concluida', finished_at: new Date().toISOString() }).eq('id', id).eq('status', 'enviando'));
    return true;
  },
};
const sender = createSender({
  db: campaignDb,
  siteUrl: SITE_URL,
  log,
  wa: {
    online: () => online,
    // O WhatsApp devolve o endereço certo (com ou sem o 9); null = número sem WhatsApp.
    lookup: async (phone) => {
      try {
        const [r] = (await sock.onWhatsApp(toJid(phone))) || [];
        return r?.exists ? r.jid : null;
      } catch {
        return toJid(phone);
      }
    },
    send: (jid, text) => sendText(jid, text),
  },
});
```

Observação: `sendText` já guarda o id da mensagem em `sentIds`, então o envio da campanha não pausa o bot com aquela pessoa.

**Passo 4: ligar o envio**

Na última linha, depois do `setInterval` existente, acrescente:

```js
setInterval(() => sender.tick().catch((e) => console.error('erro no envio de campanhas', e.message)), CAMPAIGN_TICK_MS);
```

**Passo 5: conferir**

```bash
node --check bot/index.js && cd bot && npm test
```

Esperado: sem erro de sintaxe; todos os testes passam.

**Passo 6: commit**

```bash
git add bot/index.js
git commit -m "Bot do Mac: cupom, lista de saída e envio das campanhas"
```

---

### Tarefa 7: camada de dados (`store.js`)

**Arquivos:**
- Modificar: `assets/js/store.js`

Os dois adaptadores (`DemoStore` e `SupabaseStore`) ganham a mesma interface nova:

| Método | O que faz |
|---|---|
| `placeOrder({ ..., coupon })` | cupom opcional; devolve `{ code, total, subtotal, discount, coupon }` |
| `checkCoupon(code, phone, items)` | prévia no formato de `check_coupon` |
| `listCustomers()` | linhas de `admin_customers` |
| `listCoupons()`, `saveCoupon(c)` | cupons (sem excluir: pausar resolve) |
| `listCampaigns()` | campanhas com `coupon_code` e `sends` |
| `createCampaign({ name, body, coupon_id, audience, recipients })` | grava campanha e fila |
| `setCampaignStatus(id, status)` | pausar, retomar, cancelar |
| `getCampaignSettings()`, `saveCampaignSettings(s)` | ritmo (`settings.campaigns`) |

**Passo 1: imports**

```js
import { quoteCoupon, phoneKey, normCode } from './coupons.js';
import { customersFromOrders } from './campaigns.js';
```

**Passo 2: modo demonstração**

2a. Em `seedDemo`, antes de `write('seeded', true);`:

```js
  write('coupons', [{ id: uid(), code: 'VOLTA10', kind: 'percent', value: 10, min_order: 0, starts_on: null, ends_on: null, max_uses: 50, active: true, created_at: new Date(now).toISOString() }]);
  write('optouts', []);
  write('campaigns', []);
  write('campaign_sends', []);
```

2b. Em `buildOrder`, inclua `coupon_code: null, discount: 0` no objeto devolvido.

2c. Troque `placeOrder` do `DemoStore` e acrescente `checkCoupon` e `listCustomers`:

```js
  async placeOrder({ customer_name, phone, items, channel = 'web', notes = '', coupon = null }) {
    const products = read('products', []);
    const lines = items.map(({ product_id, qty }) => {
      const p = products.find((x) => x.id === product_id && x.active);
      if (!p) throw new Error('Produto indisponível');
      return { product_id, name: p.name, qty: Math.max(1, Math.min(500, Math.floor(qty))), unit_price: p.price, unit_cost: p.cost };
    });
    if (!lines.length) throw new Error('Escolha ao menos um produto');
    const order = buildOrder({ customer_name: customer_name.trim(), phone, items: lines, channel, notes });
    const subtotal = order.total;
    if (normCode(coupon)) {
      const q = await this.checkCoupon(coupon, phone, items);
      if (!q.valid) throw new Error(q.message);
      Object.assign(order, { coupon_code: q.code, discount: q.discount, total: q.total });
    }
    write('orders', [order, ...read('orders', [])]);
    return { code: order.code, total: order.total, subtotal, discount: order.discount, coupon: order.coupon_code };
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
    return customersFromOrders(read('orders', []), new Set(read('optouts', []).map((o) => o.phone_key)));
  },
```

2d. Troque `subscribe` do `DemoStore` (usado pelo simulador):

```js
  async subscribe(phone, name, on = true) {
    const key = phoneKey(phone);
    const subs = read('subscribers', []).filter((s) => s.phone !== phone);
    const outs = read('optouts', []).filter((o) => o.phone_key !== key);
    if (on) subs.push({ phone, name, created_at: new Date().toISOString() });
    else outs.push({ phone_key: key, phone, created_at: new Date().toISOString() });
    write('subscribers', subs);
    write('optouts', outs);
  },
```

2e. Acrescente, antes de `resetDemo()`:

```js
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
```

**Passo 3: Supabase**

3a. Troque `placeOrder` do `SupabaseStore`:

```js
  async placeOrder({ customer_name, phone, items, channel = 'web', notes = '', coupon = null }) {
    return must(await sb.rpc('place_order', {
      p_name: customer_name, p_phone: normalizePhone(phone), p_items: items, p_channel: channel, p_notes: notes, p_coupon: normCode(coupon) || null,
    }));
  },
  async checkCoupon(code, phone = '', items = []) {
    return must(await sb.rpc('check_coupon', { p_code: code, p_phone: phone ? normalizePhone(phone) : '', p_items: items }));
  },
  // A API devolve no máximo 1000 linhas por vez.
  async listCustomers() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const page = must(await sb.from('admin_customers').select('*').order('phone_key').range(from, from + 999));
      out.push(...page);
      if (page.length < 1000) return out;
    }
  },
```

3b. Acrescente, antes de `botStatus()`:

```js
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
```

**Passo 4: conferir**

```bash
node --check assets/js/store.js && cd bot && npm test
```

**Passo 5: commit**

```bash
git add assets/js/store.js
git commit -m "Camada de dados: cupons, clientes e campanhas nos dois modos"
```

---

### Tarefa 8: loja com campo de cupom

**Arquivos:**
- Modificar: `index.html`, `assets/css/shop.css`, `assets/js/shop.js`

**Passo 1: HTML**

Em `index.html`, logo depois do `</details>` das observações (antes de `<p class="err" id="formErr" ...>`):

```html
          <details class="notes" id="couponBox">
            <summary>Tem cupom de desconto?</summary>
            <div class="coupon-row">
              <input class="input" name="coupon" id="couponIn" maxlength="20" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Ex.: VOLTA10" aria-describedby="couponMsg" />
              <button type="button" class="btn btn--soft btn--sm" id="couponApply">Aplicar</button>
            </div>
            <p class="coupon-msg" id="couponMsg" aria-live="polite"></p>
          </details>
```

E logo antes de `<div class="order-total">`:

```html
          <div class="order-discount" id="orderDiscount" hidden>
            <span id="discountLabel">Desconto</span>
            <b id="discountValue"></b>
          </div>
```

**Passo 2: CSS**

No fim de `assets/css/shop.css`:

```css
.coupon-row { display: flex; gap: 8px; margin-top: 8px; }
.coupon-row .input { flex: 1; text-transform: uppercase; }
.coupon-msg { margin: 6px 0 0; font-size: 0.88rem; font-weight: 700; color: var(--ink-soft); }
.coupon-msg.ok { color: var(--leaf); }
.coupon-msg.bad { color: #b44d42; }
.order-discount { display: flex; justify-content: space-between; align-items: baseline; font-weight: 700; color: var(--leaf); }
```

**Passo 3: JS**

3a. Import (depois do import de `utils.js`):

```js
import { isCouponError, normCode } from './coupons.js';
```

3b. Estado, junto de `let cart = ...`:

```js
const coupon = { code: '', result: null }; // result = resposta de checkCoupon
```

3c. Em `boot()`, logo depois de `wireForm();`: `wireCoupon();`

3d. Em `renderLines()`, troque as linhas `$('#orderTotal').textContent = money(cartTotal());` e `$('#mbarTotal').textContent = money(cartTotal());` (apague as duas) e, no lugar da segunda, coloque:

```js
  if (coupon.code) refreshCoupon(); // o desconto depende do carrinho
  paintTotals();
```

3e. Acrescente a seção do cupom (antes de `/* ---------- envio ---------- */`):

```js
/* ---------- cupom ---------- */
function wireCoupon() {
  const input = $('#couponIn');
  const fromLink = normCode(new URLSearchParams(location.search).get('cupom'));
  if (fromLink) {
    input.value = fromLink;
    $('#couponBox').open = true;
    setCoupon(fromLink);
  }
  $('#couponApply').addEventListener('click', () => setCoupon(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setCoupon(input.value); } });
  input.addEventListener('input', () => { if (!normCode(input.value) && coupon.code) setCoupon(''); });
  $('#orderForm').phone.addEventListener('change', () => coupon.code && refreshCoupon()); // "uma vez por WhatsApp"
}

function setCoupon(code) {
  coupon.code = normCode(code);
  coupon.result = null;
  refreshCoupon();
}

let couponSeq = 0;
async function refreshCoupon() {
  const seq = ++couponSeq;
  if (!coupon.code) { coupon.result = null; paintCoupon(); return; }
  const phone = $('#orderForm').phone.value;
  try {
    const r = await store.checkCoupon(coupon.code, isValidPhone(phone) ? phone : '', cart.map(({ product_id, qty }) => ({ product_id, qty })));
    if (seq === couponSeq) coupon.result = r;
  } catch (e) {
    console.error(e);
    if (seq === couponSeq) coupon.result = { valid: false, message: 'Não consegui conferir o cupom agora' };
  }
  if (seq === couponSeq) paintCoupon();
}

const discount = () => (coupon.result?.valid ? Number(coupon.result.discount) : 0);

function paintCoupon() {
  const msg = $('#couponMsg');
  const r = coupon.result;
  msg.className = 'coupon-msg';
  if (!coupon.code) msg.textContent = '';
  else if (!r) msg.textContent = 'Conferindo…';
  else if (r.valid) { msg.textContent = `🎟️ ${r.code} aplicado: ${r.label} de desconto`; msg.classList.add('ok'); }
  else if (!cart.length && /^Vale para pedidos/.test(r.message)) msg.textContent = `🎟️ ${r.code}: ${r.label} de desconto. ${r.message}.`;
  else { msg.textContent = `${r.message}.`; msg.classList.add('bad'); }
  paintTotals();
}

function paintTotals() {
  const d = discount();
  const total = Math.max(0, cartTotal() - d);
  $('#orderDiscount').hidden = !d;
  if (d) {
    $('#discountLabel').textContent = `Cupom ${coupon.result.code}`;
    $('#discountValue').textContent = `−${money(d)}`;
  }
  $('#orderTotal').textContent = money(total);
  $('#mbarTotal').textContent = money(total);
}
```

3f. No `submit` de `wireForm`, depois da validação do telefone (`if (!isValidPhone(...)) {...}`), acrescente:

```js
    if (coupon.code && !coupon.result?.valid) {
      $('#couponBox').open = true;
      err.textContent = coupon.result
        ? `Cupom ${coupon.code}: ${coupon.result.message}. Ajuste o pedido ou apague o cupom.`
        : 'Ainda estou conferindo o cupom, tente de novo em instantes.';
      return;
    }
```

No `store.placeOrder({...})`, acrescente `coupon: coupon.code || null,`.

Depois de `showDone(...)` (no `try`), acrescente:

```js
      $('#couponIn').value = '';
      setCoupon('');
      if (location.search) history.replaceState(null, '', location.pathname + location.hash); // o link com ?cupom= já foi usado
```

No `catch`, troque a mensagem:

```js
      err.textContent = isCouponError(ex.message)
        ? `${ex.message}. Ajuste o pedido ou apague o cupom.`
        : 'Não foi possível enviar agora. Tente de novo ou peça pelo WhatsApp.';
      if (isCouponError(ex.message)) refreshCoupon();
```

3g. Em `showDone`, inclua o desconto na mensagem do WhatsApp:

```js
  const off = Number(r.discount) > 0 ? `\nCupom ${r.coupon}: −${money(r.discount)}` : '';
  const msg = `Oi! Acabei de fazer o pedido *${r.code}* pelo site 🎓\n\n${lines.map((l) => `• ${l.qty}x ${l.p.name}`).join('\n')}${off}\n\nTotal: *${money(r.total)}*\nNome: ${name}`;
```

(O motor do bot trata essa mensagem pelo código DD-XXXX antes de olhar cupom, então o "Cupom VOLTA10" dela não é aplicado de novo.)

**Passo 4: conferir no modo demonstração**

Monte uma cópia em modo demonstração numa pasta temporária (no Claude Code, a pasta de scratchpad da sessão), sem mexer no repositório:

```bash
DEMO="<pasta temporária>/umdoce-demo"
rm -rf "$DEMO" && mkdir -p "$DEMO" && rsync -a --exclude .git --exclude bot/node_modules ./ "$DEMO/"
sed -i '' -e "s#SUPABASE_URL: '[^']*'#SUPABASE_URL: ''#" -e "s#SUPABASE_ANON_KEY: '[^']*'#SUPABASE_ANON_KEY: ''#" "$DEMO/assets/js/config.js"
cd "$DEMO" && python3 -m http.server 8080
```

Abra `http://localhost:8080/admin.html` (admin@doce.com / diploma2026), vá em **Ajustes → Restaurar dados de exemplo** (cria o cupom VOLTA10) e depois `http://localhost:8080/?cupom=VOLTA10`. Confira:

- o campo "Tem cupom?" abre com VOLTA10 e mostra "aplicado: 10% de desconto";
- a linha "Cupom VOLTA10 −R$ X" aparece e o total (e a barra fixa no celular) cai 10%;
- mudar a quantidade recalcula o desconto;
- `NADA1` mostra "Cupom não encontrado." em vermelho e bloqueia o envio com a explicação;
- depois de enviar, a mensagem do WhatsApp tem a linha do cupom, o endereço perde o `?cupom=` e um segundo pedido com o mesmo telefone recebe "Você já usou este cupom".

Para automatizar, dá para usar o skill de testes web (Playwright). Repita a cópia depois de cada tarefa de interface.

**Passo 5: commit**

```bash
git add index.html assets/css/shop.css assets/js/shop.js
git commit -m "Loja: campo de cupom e link com cupom aplicado"
```

---

### Tarefa 9: painel, menu e aba Clientes

**Arquivos:**
- Modificar: `assets/js/icons.js`, `admin.html`, `assets/js/admin.js`

**Passo 1: ícone de cupom**

Em `assets/js/icons.js`, dentro de `P`, acrescente:

```js
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
```

**Passo 2: menu lateral**

Em `admin.html`, depois do link de Novidades:

```html
        <a href="#clientes" data-view="clientes"><i data-i="users"></i><span>Clientes</span></a>
        <a href="#campanhas" data-view="campanhas"><i data-i="send"></i><span>Campanhas</span></a>
        <a href="#cupons" data-view="cupons"><i data-i="tag"></i><span>Cupons</span></a>
```

**Passo 3: rotas, estado e menu "Mais" do celular**

Em `assets/js/admin.js`:

- Imports novos:

```js
import { couponState, couponLabel, normCode } from './coupons.js';
import { AUDIENCES, PACE, pickAudience, campaignText, finishText, spDayStart } from './campaigns.js';
```

- `S` ganha `customers: null, customersAt: 0, coupons: [], campaigns: [], campaignCfg: {}`.
- Em `VIEWS`, depois de `novidades`:

```js
  clientes: ['Clientes', viewCustomers],
  campanhas: ['Campanhas', viewCampaigns],
  cupons: ['Cupons', viewCoupons],
```

- No menu "Mais" (`#moreBtn`), troque a lista e o mapa de ícones:

```js
    ${['produtos', 'novidades', 'clientes', 'campanhas', 'cupons', 'bot', 'ajustes'].map((v) => `<a href="#${v}" data-close>${icon({ produtos: 'box', novidades: 'news', clientes: 'users', campanhas: 'send', cupons: 'tag', bot: 'bot', ajustes: 'gear' }[v])} ${VIEWS[v][0]}</a>`).join('')}
```

- Em `loadAll`, carregue os cupons e invalide os clientes (o botão Atualizar busca de novo):

```js
async function loadAll() {
  const since = new Date(Date.now() - 400 * 864e5).toISOString();
  [S.orders, S.products, S.news, S.settings, S.admins, S.coupons] = await Promise.all([
    store.listOrders({ since }), store.listProducts({ all: true }), store.listNews({ all: true }), store.getSettings(), store.listBotAdmins(), store.listCoupons(),
  ]);
  S.customers = null;
  updateNewPill();
}
```

**Passo 4: aba Clientes**

Acrescente depois da seção Novidades:

```js
/* =================================================================== */
/* Clientes                                                             */
/* =================================================================== */
const CF = { q: '', sort: 'last_order' };
const CUSTOMER_SORTS = {
  last_order: ['Último pedido', (a, b) => String(b.last_order).localeCompare(String(a.last_order))],
  orders: ['Mais pedidos', (a, b) => b.orders - a.orders],
  spent: ['Mais gasto', (a, b) => b.spent - a.spent],
};

// Lista de clientes com cache de 1 min (a busca re-renderiza a cada tecla).
async function customers() {
  if (!S.customers || Date.now() - S.customersAt > 60e3) {
    S.customers = await store.listCustomers();
    S.customersAt = Date.now();
  }
  return S.customers;
}

async function viewCustomers(v, signal) {
  if (!S.customers) v.innerHTML = '<p class="hint">Carregando clientes…</p>';
  let all;
  try { all = await customers(); } catch (e) { v.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (signal.aborted) return;
  const q = CF.q.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  const list = all.filter((c) => !q || c.name.toLowerCase().includes(q) || (digits && c.phone.includes(digits))).sort(CUSTOMER_SORTS[CF.sort][1]);
  const since60 = Date.now() - 60 * 864e5;
  v.innerHTML = `
    <div class="kpis">
      ${kpi('Clientes', all.length, 'já compraram', 'users', true)}
      ${kpi('Voltaram a comprar', all.filter((c) => c.orders >= 2).length, '2 pedidos ou mais', 'heart')}
      ${kpi('Sumidos', all.filter((c) => new Date(c.last_order).getTime() < since60).length, 'sem pedir há 60 dias ou mais', 'clock')}
      ${kpi('Sem promoções', all.filter((c) => c.opted_out).length, 'pediram para sair', 'x')}
    </div>
    <div class="toolbar">
      <input class="input" type="search" id="cq" placeholder="Buscar por nome ou telefone" value="${esc(CF.q)}" />
      <div class="chips" role="group" aria-label="Ordenar">${Object.entries(CUSTOMER_SORTS).map(([k, [l]]) => `<button class="chip" aria-pressed="${CF.sort === k}" data-sort="${k}">${l}</button>`).join('')}</div>
      <button class="btn btn--sm" id="newCamp">${icon('send')} Nova campanha</button>
    </div>
    <section class="panel">
      <div class="table-wrap"><table class="t">
        <thead><tr><th>Cliente</th><th>WhatsApp</th><th class="num">Pedidos</th><th class="num">Total gasto</th><th>Último pedido</th><th>Mais compra</th></tr></thead>
        <tbody>${list.slice(0, 300).map((c) => `<tr>
          <td><b>${esc(c.name)}</b>${c.opted_out ? ' <span class="ch" title="Pediu para não receber promoções">sem promoções</span>' : ''}</td>
          <td><a href="${waLink('', c.phone)}" target="_blank" rel="noopener">${formatPhone(c.phone)}</a></td>
          <td class="num">${c.orders}</td>
          <td class="num">${money(c.spent)}</td>
          <td title="${fmtDateTime(c.last_order)}">${timeAgo(c.last_order)}</td>
          <td>${esc((c.top_products || []).join(', '))}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">Nenhum cliente encontrado.</td></tr>'}</tbody>
      </table></div>
      ${list.length > 300 ? `<p class="hint">Mostrando 300 de ${list.length}. Use a busca para achar alguém.</p>` : ''}
    </section>`;
  $('#cq', v).addEventListener('input', (e) => {
    CF.q = e.target.value;
    clearTimeout(viewCustomers.t);
    viewCustomers.t = setTimeout(() => { render(); const i = $('#cq'); i?.focus(); i?.setSelectionRange(i.value.length, i.value.length); }, 250);
  }, { signal });
  on(v, signal, 'click', '[data-sort]', (b) => { CF.sort = b.dataset.sort; render(); });
  $('#newCamp', v).onclick = () => campaignDialog();
}
```

`viewCampaigns`, `viewCoupons` e `campaignDialog` chegam nas próximas tarefas. Para não quebrar o painel entre um commit e outro, crie agora versões provisórias logo abaixo:

```js
function viewCoupons(v) { v.innerHTML = emptyState('Em breve', 'Cupons chegam na próxima etapa.'); }
function viewCampaigns(v) { v.innerHTML = emptyState('Em breve', 'Campanhas chegam na próxima etapa.'); }
function campaignDialog() { location.hash = 'campanhas'; }
```

**Passo 5: conferir no modo demonstração**

Refaça a cópia (Tarefa 8, Passo 4), entre no painel e abra **Clientes**: os números batem com os pedidos de exemplo (mesmo telefone vira uma linha só), a busca por nome e por telefone funciona, a ordenação muda a lista e o menu "Mais" do celular mostra as três abas novas.

**Passo 6: commit**

```bash
git add assets/js/icons.js admin.html assets/js/admin.js
git commit -m "Painel: aba Clientes e menu das abas novas"
```

---

### Tarefa 10: painel, aba Cupons

**Arquivos:**
- Modificar: `assets/js/admin.js`

**Passo 1: cupom no cartão do pedido**

Em `orderCard`, dentro de `ocard__top`, depois do `<span class="ch ch--...">`:

```js
${o.coupon_code ? `<span class="ch" title="Desconto de ${money(o.discount)}">🎟️ ${esc(o.coupon_code)}</span>` : ''}
```

**Passo 2: aba Cupons**

Troque a versão provisória de `viewCoupons` por:

```js
/* =================================================================== */
/* Cupons                                                               */
/* =================================================================== */
const COUPON_STATE = { ativo: ['Ativo', 'var(--leaf)'], agendado: ['Agendado', 'var(--honey)'], expirado: ['Expirado', 'var(--muted)'], esgotado: ['Esgotado', 'var(--muted)'], pausado: ['Pausado', 'var(--muted)'] };
const siteBase = () => `${location.origin}${location.pathname.replace(/admin\.html$/, '')}`;
const couponUses = (code) => S.orders.filter((o) => o.coupon_code === code && o.status !== 'cancelado');
const fmtDay = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : '');
function validity(c) {
  if (c.starts_on && c.ends_on) return `${fmtDay(c.starts_on)} a ${fmtDay(c.ends_on)}`;
  if (c.ends_on) return `até ${fmtDay(c.ends_on)}`;
  if (c.starts_on) return `a partir de ${fmtDay(c.starts_on)}`;
  return 'sem prazo';
}

function viewCoupons(v, signal) {
  v.innerHTML = `
    <div class="toolbar"><p class="hint" style="margin:0;flex:1">O cupom vale no site e no bot. Cada WhatsApp usa uma vez; pedido cancelado devolve o uso.</p>
      <button class="btn" id="addC">${icon('plus')} Novo cupom</button></div>
    <section class="panel"><div class="table-wrap"><table class="t">
      <thead><tr><th>Código</th><th>Desconto</th><th>Vigência</th><th class="num">Usos</th><th class="num">Vendas</th><th class="num">Desconto dado</th><th>Situação</th><th></th></tr></thead>
      <tbody>${S.coupons.map((c) => {
        const used = couponUses(c.code);
        const [label, color] = COUPON_STATE[couponState(c, used.length)];
        return `<tr><td><b>${esc(c.code)}</b></td>
          <td>${couponLabel(c)}${Number(c.min_order) ? `<br><small class="hint">pedido mín. ${money(c.min_order)}</small>` : ''}</td>
          <td>${validity(c)}</td>
          <td class="num">${used.length}${c.max_uses ? ` de ${c.max_uses}` : ''}</td>
          <td class="num">${money(used.reduce((s, o) => s + Number(o.total), 0))}</td>
          <td class="num">${money(used.reduce((s, o) => s + Number(o.discount || 0), 0))}</td>
          <td><span class="status-line"><span class="dot" style="background:${color}"></span>${label}</span></td>
          <td style="white-space:nowrap">
            <button class="icon-btn" data-copy="${esc(c.code)}" title="Copiar link com o cupom" aria-label="Copiar link com o cupom">${icon('copy')}</button>
            <button class="icon-btn" data-editc="${c.id}" title="Editar" aria-label="Editar">${icon('edit')}</button>
            <label class="switch" title="${c.active ? 'Pausar' : 'Ativar'}"><input type="checkbox" data-activec="${c.id}" ${c.active ? 'checked' : ''}/><i></i></label>
          </td></tr>`;
      }).join('') || '<tr><td colspan="8" class="empty">Nenhum cupom ainda. Crie o primeiro!</td></tr>'}</tbody>
    </table></div></section>`;
  $('#addC', v).onclick = () => couponDialog();
  on(v, signal, 'click', '[data-editc]', (b) => couponDialog(S.coupons.find((c) => c.id === b.dataset.editc)));
  on(v, signal, 'change', '[data-activec]', async (i) => {
    try { await store.saveCoupon({ id: i.dataset.activec, active: i.checked }); } catch (e) { toast(e.message, 'err'); }
    S.coupons = await store.listCoupons();
    render();
  });
  on(v, signal, 'click', '[data-copy]', async (b) => {
    try { await navigator.clipboard.writeText(`${siteBase()}?cupom=${b.dataset.copy}`); toast('Link copiado 🎟️'); } catch { toast('Não consegui copiar', 'err'); }
  });
}

function couponDialog(c = { code: '', kind: 'percent', value: '', min_order: 0, starts_on: null, ends_on: null, max_uses: null, active: true }) {
  const locked = !!c.id && couponUses(c.code).length > 0; // já usado: o código não muda
  openDialog(`<h2>${c.id ? 'Editar cupom' : 'Novo cupom'}</h2>
    <form class="form" id="cf">
      <div class="row">
        <label class="field"><span>Código</span><input class="input" name="code" required maxlength="20" value="${esc(c.code)}" placeholder="VOLTA10" style="text-transform:uppercase" ${locked ? 'readonly title="Já foi usado: o código não muda"' : ''} /></label>
        <label class="field"><span>Desconto</span><span style="display:flex;gap:6px">
          <select class="select" name="kind" style="width:auto"><option value="percent" ${c.kind === 'percent' ? 'selected' : ''}>%</option><option value="fixed" ${c.kind === 'fixed' ? 'selected' : ''}>R$</option></select>
          <input class="input" name="value" type="number" step="0.01" min="0.01" required value="${c.value}" /></span></label>
      </div>
      <div class="row">
        <label class="field"><span>Válido de</span><input class="input" name="starts_on" type="date" value="${c.starts_on || ''}" /></label>
        <label class="field"><span>Até (inclusive)</span><input class="input" name="ends_on" type="date" value="${c.ends_on || ''}" /></label>
      </div>
      <div class="row">
        <label class="field"><span>Cota (total de usos)</span><input class="input" name="max_uses" type="number" min="1" step="1" value="${c.max_uses ?? ''}" placeholder="Sem limite" /></label>
        <label class="field"><span>Pedido mínimo (R$)</span><input class="input" name="min_order" type="number" min="0" step="0.01" value="${Number(c.min_order) || ''}" placeholder="Sem mínimo" /></label>
      </div>
      <label class="switch"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}/><i></i>Ativo</label>
      <p class="hint">Prefira código com número (ex.: VOLTA10): no WhatsApp o cliente pode digitar em minúsculas. Cada WhatsApp usa uma vez, e a cota conta só pedidos não cancelados.</p>
      <p class="err" id="cerr"></p>
      <div class="form__actions"><button class="btn" type="submit">Salvar cupom</button></div>
    </form>`, (m, close) => {
    const f = $('#cf', m);
    const fail = (t) => { $('#cerr', m).textContent = t; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const rec = {
        code: normCode(f.code.value), kind: f.kind.value, value: Number(f.value.value), min_order: Number(f.min_order.value) || 0,
        starts_on: f.starts_on.value || null, ends_on: f.ends_on.value || null, max_uses: f.max_uses.value ? Number(f.max_uses.value) : null, active: f.active.checked,
      };
      if (!/^[A-Z0-9]{3,20}$/.test(rec.code)) return fail('Use de 3 a 20 letras e números, sem espaço nem acento.');
      if (!(rec.value > 0)) return fail('Informe o valor do desconto.');
      if (rec.kind === 'percent' && rec.value > 100) return fail('Desconto em porcentagem vai até 100.');
      if (rec.starts_on && rec.ends_on && rec.ends_on < rec.starts_on) return fail('A data final vem antes da inicial.');
      try {
        await store.saveCoupon(c.id ? { id: c.id, ...rec } : rec);
        S.coupons = await store.listCoupons();
        close();
        render();
        toast('Cupom salvo 🎟️');
      } catch (ex) { fail(ex.message); }
    };
  });
}
```

**Passo 3: conferir no modo demonstração**

Na aba **Cupons**: criar `DOCE5` (R$ 5, mínimo R$ 30, cota 2, até amanhã), editar, pausar e ativar pelo interruptor, copiar o link. Faça 2 pedidos com `DOCE5` na loja (telefones diferentes) e confira "2 de 2", situação "Esgotado", vendas e desconto dado; cancele um pedido no quadro e veja voltar para "1 de 2". O cartão do pedido mostra o selo 🎟️ DOCE5. Tente criar outro `DOCE5`: aparece "Já existe um cupom com esse código".

**Passo 4: commit**

```bash
git add assets/js/admin.js
git commit -m "Painel: aba Cupons com cota, vigência e resultado"
```

---

### Tarefa 11: painel, aba Campanhas

**Arquivos:**
- Modificar: `assets/js/admin.js`, `assets/css/admin.css`

**Passo 1: reaproveitar o "bot está vivo?"**

Acima de `viewBot`, acrescente:

```js
// O bot por QR Code grava o status a cada 30 s em settings.bot; 2 min sem sinal = desligado.
const botAlive = (b) => !!b?.last_seen && Date.now() - new Date(b.last_seen).getTime() < 120e3 && b.state !== 'desligado';
```

e, dentro de `paint` em `viewBot`, troque a linha `const alive = ...` por `const alive = botAlive(b);`.

**Passo 2: simulador entende cupom**

Em `botCtx()`, acrescente:

```js
    checkCoupon: (code, phone, items) => store.checkCoupon(code, phone, items),
```

e, na lista de botões rápidos do simulador, acrescente `'cupom VOLTA10'` e `'parar promoções'`.

**Passo 3: aba Campanhas**

Troque as versões provisórias de `viewCampaigns` e `campaignDialog` por:

```js
/* =================================================================== */
/* Campanhas                                                            */
/* =================================================================== */
const CAMP_STATUS = { enviando: ['Enviando', 'var(--leaf)'], pausada: ['Pausada', 'var(--honey)'], concluida: ['Concluída', 'var(--cocoa)'], cancelada: ['Cancelada', 'var(--muted)'] };
const SEND_LABEL = { pendente: 'na fila', enviando: 'enviando', enviada: 'enviada', falhou: 'falhou', pulada: 'pulada (pediu para sair)' };
const countBy = (sends) => sends.reduce((a, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {});
const sentToday = () => S.campaigns.flatMap((c) => c.sends).filter((s) => s.status === 'enviada' && Date.parse(s.sent_at) >= spDayStart()).length;

function campaignCard(c) {
  const n = countBy(c.sends);
  const total = c.sends.length;
  const done = (n.enviada || 0) + (n.falhou || 0) + (n.pulada || 0);
  const queued = (n.pendente || 0) + (n.enviando || 0);
  const [label, color] = CAMP_STATUS[c.status] || CAMP_STATUS.pausada;
  return `<article class="camp">
    <div class="camp__head"><h3>${esc(c.name)}</h3><span class="status-line"><span class="dot" style="background:${color}"></span>${label}</span></div>
    <p class="hint">${fmtDateTime(c.created_at)} · ${esc(AUDIENCES[c.audience?.type] || 'Público escolhido')}${c.coupon_code ? ` · cupom <b>${esc(c.coupon_code)}</b>` : ''}</p>
    <div class="progress" role="progressbar" aria-label="Progresso" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
    <p class="camp__nums"><b>${n.enviada || 0}</b> enviadas de ${total}${queued ? ` · ${queued} na fila` : ''}${n.falhou ? ` · ${n.falhou} falharam` : ''}${n.pulada ? ` · ${n.pulada} puladas` : ''}</p>
    ${c.status === 'pausada' && c.pause_reason ? `<p class="err">${esc(c.pause_reason)}</p>` : ''}
    <div class="camp__actions">
      ${c.status === 'enviando' ? `<button class="btn btn--soft btn--sm" data-camp="${c.id}" data-to="pausada">Pausar</button>` : ''}
      ${c.status === 'pausada' ? `<button class="btn btn--sm" data-camp="${c.id}" data-to="enviando">Retomar</button>` : ''}
      ${['enviando', 'pausada'].includes(c.status) ? `<button class="btn btn--ghost btn--sm" data-camp="${c.id}" data-to="cancelada">Cancelar</button>` : ''}
      <details><summary>Ver lista</summary><ul class="camp__list">${c.sends.map((s) => `<li>${esc(s.name || formatPhone(s.phone))} <small>${SEND_LABEL[s.status] || s.status}${s.error ? `: ${esc(s.error)}` : ''}</small></li>`).join('')}</ul></details>
    </div>
  </article>`;
}

function campaignBotLine(b) {
  const line = (color, text) => `<p class="status-line"><span class="dot" style="background:var(--${color})"></span>${text}</p>`;
  if (IS_DEMO) return line('honey', 'Modo demonstração: as campanhas são simuladas e nada é enviado.');
  if (botAlive(b) && b.state === 'online') return line('leaf', 'Bot online: enviando no ritmo abaixo.');
  return line('honey', 'Bot desligado ou desconectado: os envios ficam parados até ele voltar (aba Bot WhatsApp).');
}

async function viewCampaigns(v, signal) {
  const load = async () => {
    [S.campaigns, S.campaignCfg] = await Promise.all([store.listCampaigns(), store.getCampaignSettings()]);
  };
  v.innerHTML = '<p class="hint">Carregando campanhas…</p>';
  try { await load(); } catch (e) { v.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  if (signal.aborted) return;
  const cfg = { ...PACE, ...S.campaignCfg };
  v.innerHTML = `
    <div class="cols cols--2">
      <section class="panel"><div class="panel__head"><div><h2>Campanhas</h2><p>Mensagens em massa pelo WhatsApp do bot</p></div><button class="btn btn--sm" id="newCamp">${icon('plus')} Nova campanha</button></div>
        <div id="campList"></div>
      </section>
      <section class="panel" style="align-self:start"><div class="panel__head"><div><h2>Ritmo de envio</h2><p>Devagar para o WhatsApp não bloquear o número</p></div></div>
        <div id="campBot"></div>
        <form class="form" id="paceF">
          <div class="row">
            <label class="field"><span>Mensagens por dia</span><input class="input" name="daily_limit" type="number" min="10" max="300" required value="${cfg.daily_limit}" /></label>
            <label class="field"><span>Das (hora)</span><input class="input" name="start_hour" type="number" min="0" max="23" required value="${cfg.start_hour}" /></label>
          </div>
          <div class="row">
            <label class="field"><span>Até (hora)</span><input class="input" name="end_hour" type="number" min="1" max="24" required value="${cfg.end_hour}" /></label>
            <span></span>
          </div>
          <p class="hint">Entre uma mensagem e outra o bot espera de 20 a 60 segundos. O que passar do limite do dia continua no dia seguinte. Quem responder "parar promoções" sai da lista.</p>
          <div class="form__actions"><button class="btn btn--soft btn--sm" type="submit">Salvar ritmo</button></div>
        </form>
      </section>
    </div>`;
  const paintList = () => {
    $('#campList', v).innerHTML = S.campaigns.map(campaignCard).join('') || emptyState('Nenhuma ainda', 'Crie a primeira campanha.');
  };
  const paintBot = () => store.botStatus().then((b) => { if (!signal.aborted) $('#campBot', v).innerHTML = campaignBotLine(b); }).catch(() => {});
  paintList();
  paintBot();

  $('#newCamp', v).onclick = () => campaignDialog();
  on(v, signal, 'click', '[data-camp]', async (b) => {
    const to = b.dataset.to;
    if (to === 'cancelada' && !confirm('Cancelar esta campanha? Quem ainda não recebeu não vai receber.')) return;
    try {
      await store.setCampaignStatus(b.dataset.camp, to);
      await load();
      paintList();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#paceF', v).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const s = { daily_limit: Number(f.daily_limit.value), start_hour: Number(f.start_hour.value), end_hour: Number(f.end_hour.value) };
    if (s.start_hour >= s.end_hour) { toast('O horário final precisa ser depois do inicial', 'err'); return; }
    await store.saveCampaignSettings(s);
    S.campaignCfg = await store.getCampaignSettings();
    toast('Ritmo salvo');
  };

  // Progresso ao vivo, sem fechar a lista que estiver aberta.
  const timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      await load();
      if (!signal.aborted && !v.querySelector('.camp details[open]')) paintList();
      paintBot();
    } catch {}
  }, 15000);
  signal.addEventListener('abort', () => clearInterval(timer));
}

async function campaignDialog() {
  let all;
  let subscribers;
  try { [all, subscribers] = await Promise.all([customers(), store.listSubscribers()]); } catch (e) { toast(e.message, 'err'); return; }
  const usable = S.coupons.filter((c) => ['ativo', 'agendado'].includes(couponState(c, couponUses(c.code).length)));
  const excluded = new Set();
  openDialog(`<h2>Nova campanha</h2>
    <form class="form" id="cpf">
      <label class="field"><span>Nome (só você vê)</span><input class="input" name="name" required maxlength="60" placeholder="Ex.: Kit semana de provas" /></label>
      <div class="row">
        <label class="field"><span>Quem recebe</span><select class="select" name="type">${Object.entries(AUDIENCES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field" id="fDays" hidden><span>Sem pedir há</span><select class="select" name="days"><option value="30">30 dias ou mais</option><option value="60" selected>60 dias ou mais</option><option value="90">90 dias ou mais</option></select></label>
        <label class="field" id="fProd" hidden><span>Produto</span><select class="select" name="product_id">${S.products.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      </div>
      <details class="aud"><summary id="audCount"></summary><div class="aud__list" id="audList"></div></details>
      <label class="field"><span>Mensagem</span><textarea class="textarea" name="body" required maxlength="700" rows="5">Oi, {nome}! 🎓🍫 </textarea></label>
      <p class="hint"><code>{nome}</code> vira o primeiro nome de cada cliente. Use *asteriscos* para negrito.</p>
      <label class="field"><span>Cupom</span><select class="select" name="coupon_id"><option value="">Sem cupom</option>${usable.map((c) => `<option value="${c.id}">${esc(c.code)} (${couponLabel(c)})</option>`).join('')}</select></label>
      <div class="field"><span>Prévia</span><div class="msg msg--in preview-msg" id="cpPrev"></div></div>
      <p class="hint" id="cpEta"></p>
      <p class="err" id="cperr"></p>
      <div class="form__actions"><button class="btn" type="submit" id="cpSend">${icon('send')} Enviar</button></div>
    </form>`, (m, close) => {
    const f = $('#cpf', m);
    const filter = () => ({ type: f.type.value, days: Number(f.days.value), product_id: f.product_id.value });
    const audience = () => pickAudience(all, subscribers, filter());
    const recipients = () => audience().filter((r) => !excluded.has(r.phone_key));
    const couponCode = () => S.coupons.find((c) => c.id === f.coupon_id.value)?.code || null;
    const paintSummary = () => {
      const list = recipients();
      const off = audience().length - list.length;
      $('#audCount', m).textContent = `${list.length} ${list.length === 1 ? 'pessoa vai' : 'pessoas vão'} receber${off ? ` (${off} desmarcada${off > 1 ? 's' : ''})` : ''} · ver lista`;
      $('#cpPrev', m).innerHTML = waFormat(campaignText({ body: f.body.value, coupon_code: couponCode() }, list[0]?.name || 'Ana', siteBase()));
      $('#cpEta', m).textContent = !list.length ? 'Ninguém nesse grupo.'
        : IS_DEMO ? `${list.length} mensagens · no modo demonstração nada é enviado de verdade`
        : `${list.length} mensagens · ${finishText(list.length, S.campaignCfg, { sentToday: sentToday() })}`;
      $('#cpSend', m).disabled = !list.length;
      $('#cpSend', m).innerHTML = `${icon('send')} Enviar para ${list.length}`;
    };
    const paintAudience = () => {
      const fl = filter();
      $('#fDays', m).hidden = fl.type !== 'sumidos';
      $('#fProd', m).hidden = fl.type !== 'produto';
      $('#audList', m).innerHTML = audience().map((r) => `<label><input type="checkbox" data-pk="${esc(r.phone_key)}" ${excluded.has(r.phone_key) ? '' : 'checked'} /> ${esc(r.name || 'Sem nome')} <small>${formatPhone(r.phone)}</small></label>`).join('');
      paintSummary();
    };
    paintAudience();
    f.type.onchange = f.days.onchange = f.product_id.onchange = () => { excluded.clear(); paintAudience(); };
    f.body.oninput = paintSummary;
    f.coupon_id.onchange = paintSummary;
    $('#audList', m).addEventListener('change', (e) => {
      const pk = e.target.dataset.pk;
      if (!pk) return;
      if (e.target.checked) excluded.delete(pk); else excluded.add(pk);
      paintSummary();
    });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const list = recipients();
      if (!list.length || !f.body.value.trim()) return;
      if (!confirm(`Enviar "${f.name.value.trim()}" para ${list.length} pessoa(s)? O bot manda aos poucos, no ritmo configurado.`)) return;
      $('#cpSend', m).disabled = true;
      try {
        await store.createCampaign({ name: f.name.value.trim(), body: f.body.value.trim(), coupon_id: f.coupon_id.value || null, audience: filter(), recipients: list });
        close();
        toast(IS_DEMO ? 'Campanha simulada (modo demonstração) ✨' : 'Campanha criada! O bot começa a enviar em instantes 📲');
        if (S.view === 'campanhas') render(); else location.hash = 'campanhas';
      } catch (ex) {
        $('#cperr', m).textContent = ex.message;
        $('#cpSend', m).disabled = false;
      }
    };
  }, { wide: true });
}
```

**Passo 4: CSS**

No fim de `assets/css/admin.css`:

```css
.camp { padding: 14px 0; border-bottom: 1px solid var(--line); display: grid; gap: 6px; }
.camp:last-child { border-bottom: 0; }
.camp__head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.camp__head h3 { margin: 0; font-family: var(--f-display); font-size: 1.05rem; color: var(--choc); }
.camp .hint, .camp__nums { margin: 0; }
.camp__nums { font-size: 0.9rem; color: var(--ink-soft); }
.camp__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.camp__list { margin: 8px 0 0; padding-left: 18px; max-height: 220px; overflow: auto; font-size: 0.88rem; }
.camp__list small { color: var(--ink-soft); }
.progress { height: 8px; border-radius: 99px; background: var(--sand); overflow: hidden; }
.progress i { display: block; height: 100%; background: var(--leaf); border-radius: inherit; transition: width 0.4s; }
.aud summary { cursor: pointer; font-weight: 800; color: var(--choc); }
.aud__list { display: grid; gap: 4px; max-height: 220px; overflow: auto; margin-top: 8px; font-size: 0.9rem; }
.aud__list small { color: var(--ink-soft); }
.preview-msg { max-width: none; }
```

**Passo 5: conferir no modo demonstração**

- **Campanhas → Nova campanha**: cada filtro muda a contagem; "Sumidos" e "Já compraram um produto" mostram o campo extra; desmarcar alguém baixa a contagem sem fechar a lista; a prévia troca `{nome}` pelo primeiro nome e mostra cupom, link `?cupom=` e o rodapé "parar promoções".
- Enviar: confirma, a campanha aparece como "Concluída" com as pessoas na lista ("pulada" para quem saiu).
- **Bot WhatsApp → Simulador**: "cupom VOLTA10" anota o cupom; "quero 10 brigadeiros" mostra o desconto; "parar promoções" responde e, em **Clientes**, a pessoa ganha o selo "sem promoções" (se já tiver comprado) e some dos públicos.
- **Ritmo de envio**: salvar 50 por dia, das 10 às 19; reabrir a aba e ver os valores; a estimativa da nova campanha usa o ritmo novo.

**Passo 6: commit**

```bash
git add assets/js/admin.js assets/css/admin.css
git commit -m "Painel: aba Campanhas com público, prévia, ritmo e progresso"
```

---

### Tarefa 12: documentação, verificação final e implantação

**Arquivos:**
- Modificar: `README.md`, `docs/ESPECIFICACAO.md`, `docs/plans/2026-10-02-campanhas-cupons-design.md`

**Passo 1: README**

Depois da seção "## 4. Bot no WhatsApp comum (QR Code)" e antes de "## Estrutura", acrescente:

```md
## 5. Clientes, campanhas e cupons

- **Clientes** (painel): todo mundo que já comprou, agrupado pelo WhatsApp (com e sem o 9 é a mesma pessoa).
- **Cupons**: desconto em % ou em R$, pedido mínimo, vigência por data e cota de usos. Cada WhatsApp usa uma vez; pedido cancelado devolve o uso. Vale no site (o link `?cupom=CODIGO` já aplica) e no bot ("cupom CODIGO").
- **Campanhas**: escolha o público (todos, sumidos, quem comprou um produto, melhores clientes, inscritos), escreva a mensagem com `{nome}` e, se quiser, um cupom. O bot envia aos poucos: uma mensagem a cada 20 a 60 s, só no horário configurado e até o limite do dia (padrão 80). Quem responde "parar promoções" não recebe mais campanhas nem novidades.
- Ao atualizar: rode o `supabase/schema.sql` de novo no SQL Editor e depois o `supabase/tests/cupons.sql`, que confere as regras do cupom e desfaz tudo no final. Reinicie o bot com `./instalar-servico-mac.sh`.
```

Na lista de arquivos de "## Estrutura", inclua `coupons.js` e `campaigns.js` em `assets/js` e `sender.js` em `bot/`.

**Passo 2: especificação**

Em `docs/ESPECIFICACAO.md`:
- seção 3 (dados): tabelas `coupons`, `optouts`, `campaigns`, `campaign_sends`, colunas `orders.coupon_code` e `orders.discount`, funções `check_coupon` e `phone_key`, view `admin_customers`;
- seção 2.5 (painel): abas Clientes, Campanhas e Cupons;
- seção 2.1 e 2.2: cupom no site e no bot;
- seção 7: tirar "Cupons para turmas de formandos" (feito).

No documento de desenho, troque "Situação: aprovado, ainda não implementado" por "Situação: implementado".

**Passo 3: verificação completa**

```bash
cd bot && npm test                                   # todos passam
cd .. && for f in assets/js/*.js supabase/functions/_shared/bot-engine.js bot/*.js; do node --check "$f" || echo "ERRO: $f"; done
git ls-files -co --exclude-standard | grep -v -E 'package-lock|\.(png|jpg)$' | xargs perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/; close ARGV if eof'   # esperado: nada
git ls-files -co --exclude-standard | grep -v -E 'package-lock|\.(png|jpg)$|^docs/plans/' | xargs grep -n -i -E 'campus|faculdade'   # esperado: nada (o plano cita as palavras só para definir a regra)
```

Refaça a cópia em modo demonstração e passe de novo pelos roteiros das Tarefas 8 a 11.

**Passo 4: commit**

```bash
git add README.md docs/
git commit -m "Documentação de clientes, campanhas e cupons"
```

**Passo 5: implantação (com a pessoa dona do projeto)**

1. Supabase → SQL Editor: rodar `supabase/schema.sql` inteiro. Depois rodar `supabase/tests/cupons.sql`: precisa terminar sem erro.
2. No Mac do bot: `cd bot && npm install && ./instalar-servico-mac.sh` (reinicia o serviço com o código novo). No log (`bot/bot.log`) não pode aparecer "erro no envio de campanhas".
3. Teste real pequeno: um cupom de teste, uma campanha para "Inscritos nas novidades" com só o próprio número marcado, conferir a mensagem no celular, responder "cupom CODIGO" e "parar promoções".
4. Juntar a branch na `main` e fazer push (o GitHub Pages publica o site), só com o ok da pessoa.

---

## Ajustes feitos na implementação

- **Funciona antes do SQL novo.** Pedido sem cupom chama `place_order` sem o `p_coupon` (no site e no bot), então loja e bot seguem recebendo pedidos enquanto o banco não é atualizado. O painel abre mesmo sem as tabelas novas, e as abas Clientes, Cupons e Campanhas explicam que falta rodar o `schema.sql`. No bot, erro no envio de campanhas espera 1 min antes da próxima tentativa e aparece no log no máximo a cada 10 min.
- **`place_order` com `set search_path = public, extensions`.** No Supabase o pgcrypto (`gen_random_bytes`, usado no código do pedido) fica no esquema `extensions`; só com `public` a função falha e nenhum pedido grava. O banco de teste local passou a instalar o pgcrypto em `extensions`, como no Supabase.
- **SQL testado num PostgreSQL 16 local**, com papéis e esquema `auth` iguais aos do Supabase: o `schema.sql` roda duas vezes seguidas sem erro, o `supabase/tests/cupons.sql` passa, e as regras de acesso (anônimo, logado sem ser admin e administradora) se comportam como descrito no desenho.
