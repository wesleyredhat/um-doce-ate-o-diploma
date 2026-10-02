# Um Doce Até o Diploma

Sistema de encomendas para confeitaria: **loja web**, **bot de WhatsApp** e **painel administrativo** com controle financeiro.
Roda 100% estático no **GitHub Pages**; dados e login ficam no **Supabase** (plano gratuito).

| | |
|---|---|
| Loja | `index.html` — carrossel de destaques, cardápio, pedido simplificado (nome, WhatsApp, produto, quantidade), novidades, Carteirinha do Formando |
| Painel | `admin.html` — login, quadro de pedidos (arrastar e soltar), lista de produção, produtos com margem, financeiro, novidades, bot, ajustes |
| Bot | `bot/` — WhatsApp comum conectado por QR Code; motor em `supabase/functions/_shared/bot-engine.js` (o mesmo usado pelo simulador do painel) |
| Banco | `supabase/schema.sql` — tabelas, RLS e funções `place_order` / `loyalty_stamps` |
| Especificação | [`docs/ESPECIFICACAO.md`](docs/ESPECIFICACAO.md) |

## 1. Testar agora (modo demonstração)

Sem configurar nada, o sistema roda em **modo demo**: dados de exemplo no `localStorage` do navegador.

```bash
python3 -m http.server 8080
# loja:   http://localhost:8080
# painel: http://localhost:8080/admin.html   →  admin@doce.com / diploma2026
```

> Modo demo serve para apresentar e testar. Pedidos feitos em um celular **não** aparecem no painel de outro aparelho. Para vender de verdade, faça o passo 3.

## 2. Publicar no GitHub Pages

1. Crie o repositório `um-doce-ate-o-diploma` e envie os arquivos para a branch `main`.
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**.
3. Endereço: `https://<seu-usuario>.github.io/um-doce-ate-o-diploma/` (painel em `/admin.html`).

O arquivo `.nojekyll` garante que todas as pastas sejam servidas como estão.

## 3. Ativar produção (Supabase)

1. Crie um projeto em [supabase.com](https://supabase.com) (região São Paulo).
2. **SQL Editor** → cole e execute `supabase/schema.sql`.
3. **Authentication → Users → Add user**: crie o e-mail e senha da administradora.
4. Libere o acesso ao painel (SQL Editor):
   ```sql
   insert into public.admins (user_id, name)
   select id, 'Cris' from auth.users where email = 'email-da-cris@exemplo.com';
   ```
5. **Project Settings → API**: copie `Project URL` e a chave `anon public` para `assets/js/config.js`:
   ```js
   SUPABASE_URL: 'https://xxxx.supabase.co',
   SUPABASE_ANON_KEY: 'eyJ...',
   WHATSAPP_NUMBER: '5511999999999',
   ```
6. Em **Authentication → URL Configuration**, adicione a URL do GitHub Pages.

A chave `anon` pode ficar no código público: o acesso é controlado pelas políticas RLS. Clientes só conseguem criar pedidos pela função `place_order` (preço e custo são calculados no servidor) e consultar a contagem de selos. Pedidos, custos e finanças só são visíveis para usuários na tabela `admins`.

## 4. Bot no WhatsApp comum (QR Code)

Funciona com o WhatsApp normal (não precisa de conta Business nem da API da Meta): o bot entra como um "aparelho conectado", igual ao WhatsApp Web. Precisa de um computador ligado com [Node.js](https://nodejs.org) 20+.

1. No Supabase, **SQL Editor**, rode (uma vez):
   ```sql
   alter table public.news add column if not exists wa_sent_at timestamptz;
   ```
2. No terminal:
   ```bash
   cd bot
   npm install
   cp .env.example .env
   ```
3. Abra `bot/.env` e cole em `SUPABASE_SECRET_KEY` a **Secret key** (Supabase → Project Settings → API Keys). Essa chave dá acesso total ao banco: fica só nesse arquivo, que não vai para o GitHub.
4. `npm start` → aparece um QR Code. No celular da loja: **WhatsApp → Aparelhos conectados → Conectar um aparelho** → escaneie.
5. Deixe o terminal aberto. A aba **Bot WhatsApp** do painel mostra se o bot está online.

- A sessão fica salva em `bot/auth/`; ao reiniciar não pede QR de novo. Para trocar de número, apague essa pasta.
- Novidades publicadas no painel com o canal **WhatsApp** são enviadas pelo bot em até 1 minuto aos clientes inscritos (opção 4 do menu), com pausa de alguns segundos entre cada envio.
- **Risco**: conexão por QR não é oficial. O WhatsApp pode bloquear números que mandam muitas mensagens para quem não tem o contato salvo. Use para responder clientes e envie novidades só a quem se inscreveu.
- **Grupos**: o bot responde no grupo apenas a mensagens que começam com `#pedido` e continua a conversa no privado.

A alternativa oficial (WhatsApp Business Cloud API, paga por conversa) continua em `supabase/functions/whatsapp-bot`; para usá-la, preencha `BOT_FUNCTION_URL` em `config.js`.

## Estrutura

```
index.html  admin.html  manifest.webmanifest  favicon.png  .nojekyll
assets/
  css/  base.css (tokens da paleta)  shop.css  admin.css
  js/   config.js  store.js (demo | supabase)  shop.js  admin.js  charts.js  icons.js  utils.js
  img/  fotos dos produtos e logo (recortadas da arte da cliente)
supabase/
  schema.sql
  functions/_shared/bot-engine.js     motor de conversa (navegador + Deno)
  functions/whatsapp-bot/index.ts     webhook + envio de novidades
docs/ESPECIFICACAO.md
```
