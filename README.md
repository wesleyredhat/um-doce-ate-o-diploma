# Um Doce Até o Diploma

Sistema de encomendas para confeitaria: **loja web**, **bot de WhatsApp** e **painel administrativo** com controle financeiro.
Roda 100% estático no **GitHub Pages**; dados e login ficam no **Supabase** (plano gratuito).

| | |
|---|---|
| Loja | `index.html` — carrossel de destaques, cardápio, pedido simplificado (nome, WhatsApp, produto, quantidade), novidades, Carteirinha do Formando |
| Painel | `admin.html` — login, quadro de pedidos (arrastar e soltar), lista de produção, produtos com margem, financeiro, novidades, bot, ajustes |
| Bot | `supabase/functions/whatsapp-bot` — webhook do WhatsApp Cloud API; motor em `supabase/functions/_shared/bot-engine.js` (o mesmo usado pelo simulador do painel) |
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

## 4. Conectar o bot do WhatsApp (opcional)

O simulador na aba **Bot WhatsApp** do painel já funciona sem isso.

1. [developers.facebook.com](https://developers.facebook.com) → criar app → produto **WhatsApp** → registrar o número da loja (WhatsApp Business Platform / Cloud API).
2. Gere um token permanente (usuário de sistema) com `whatsapp_business_messaging`.
3. Deploy da função:
   ```bash
   supabase link --project-ref <ref>
   supabase secrets set WA_TOKEN=... WA_PHONE_ID=... WA_VERIFY_TOKEN=um-texto-secreto WA_APP_SECRET=... OWNER_PHONE=5511999999999 SITE_URL=https://<usuario>.github.io/um-doce-ate-o-diploma/
   supabase functions deploy whatsapp-bot --no-verify-jwt
   ```
4. No painel da Meta → WhatsApp → Configuração → Webhook: URL `https://<ref>.supabase.co/functions/v1/whatsapp-bot`, token = `WA_VERIFY_TOKEN`, assine `messages`.
5. Cole a URL da função em `BOT_FUNCTION_URL` no `config.js` (habilita "Enviar pelo bot" nas novidades).

**Novidades fora da janela de 24h**: a Meta só permite mensagens de template aprovadas. Crie um template de marketing com duas variáveis (título e texto) e informe o nome em `WA_TEMPLATE_NEWS`.

**Grupos**: o bot só responde em grupo quando a mensagem começa com `#pedido` e continua a conversa no privado. O suporte a grupos depende da API/provedor contratado. Sem ele, o botão **Compartilhar no grupo** de cada novidade abre o WhatsApp com o texto pronto.

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
