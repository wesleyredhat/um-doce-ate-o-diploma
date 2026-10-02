# Um Doce Até o Diploma

Sistema de encomendas para confeitaria: **loja web**, **bot de WhatsApp** e **painel administrativo** com controle financeiro.
Roda 100% estático no **GitHub Pages**; dados e login ficam no **Supabase** (plano gratuito).

| | |
|---|---|
| Loja | `index.html`: carrossel de destaques, cardápio, pedido simplificado (nome, WhatsApp, produto, quantidade), novidades, Carteirinha do Formando |
| Painel | `admin.html`: login, quadro de pedidos (arrastar e soltar), lista de produção, produtos com margem, financeiro, novidades, clientes, campanhas, cupons, bot, ajustes |
| Bot | `bot/`: WhatsApp comum conectado por QR Code; motor em `supabase/functions/_shared/bot-engine.js` (o mesmo usado pelo simulador do painel) |
| Banco | `supabase/schema.sql`: tabelas, RLS e funções `place_order` / `check_coupon` / `loyalty_stamps` |
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
3. Endereço: `https://umdoceateodiploma.com.br/` (painel em `/admin.html`). Domínio no registro.br: 4 registros A para os IPs do GitHub Pages (185.199.108-111.153) e CNAME `www` → `wesleyredhat.github.io`.

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

A chave `anon` pode ficar no código público: o acesso é controlado pelas políticas RLS. Clientes só conseguem criar pedidos pela função `place_order` (preço, custo e desconto são calculados no servidor), conferir um cupom pela `check_coupon` (diz se o código vale, o desconto e se aquele WhatsApp já usou) e consultar a contagem de selos. Pedidos, custos, finanças, clientes, cupons e campanhas só são visíveis para usuários na tabela `admins`.

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
4. `./instalar-servico-mac.sh` → o bot passa a rodar em segundo plano, liga sozinho com o Mac e reinicia se cair (log em `bot/bot.log`; para desinstalar, `./instalar-servico-mac.sh remover`). Para testar no terminal sem instalar: `npm start`.
5. Conecte o WhatsApp: o QR Code aparece no painel, aba **Bot WhatsApp** (e também no terminal/log). No celular da loja: **WhatsApp → Aparelhos conectados → Conectar um aparelho** → escaneie. A mesma aba mostra depois se o bot está online.
   - O QR precisa ser lido pelo próprio WhatsApp (a câmera comum do celular não conecta). Se não ler, aumente o brilho da tela e aproxime o celular.
   - Alternativa sem QR: preencha `PAIRING_PHONE` no `bot/.env` com o número da loja (55 + DDD + número) e reinicie o bot. O painel mostra um código de 8 letras para digitar em **Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone**.

**Quando o bot responde** (o número da loja também é de uso pessoal; regras em `bot/core.js`, testes em `bot/core.test.js`, `npm test`):

- Só mensagens identificadas como encomenda: `menu`, `cardápio` ou `#pedido` (a mensagem inteira, como "me manda o cardápio"), os botões do site ("Vim pelo site…", "Acabei de fazer o pedido DD-XXXX", "Quero receber as novidades") ou o pedido escrito: verbo de pedido perto do produto ("quero 10 brigadeiros"), pergunta de preço ("quanto custa o brigadeiro?") ou mensagem curta que começa pela quantidade ("10 brigadeiros"). Conversas pessoais ficam sem resposta automática, mesmo citando doces ("comi 2 brigadeiros da festa", "comprei caixinhas de leite").
- Palavras comuns do nome de um produto só contam junto do resto do nome: "caixinha de docinhos", "morango cravejado".
- Cupom: "cupom VOLTA10" chama o bot quando o cupom existe; no meio de uma conversa vale mandar só o código. Cupom que não existe numa conversa pessoal ("usei o cupom IFOOD10") fica sem resposta.
- Saída das campanhas e novidades: "parar promoções", "pare de me mandar promoção" e "parar novidades" funcionam sempre; "parar" ou "sair" sozinho vale para quem recebeu campanha nos últimos 30 dias.
- Depois de entrar na conversa, segue até o pedido terminar ou até 30 min sem resposta. O menu completo aparece no máximo uma vez por conversa.
- Se alguém da loja responder pelo celular, o bot fica 12 h quieto com aquela pessoa; só `menu`, `cardápio` ou `#pedido` chamam o bot de volta. Pedido para sair das novidades ("parar de receber novidades") funciona sempre.
- Mensagens que chegam com o bot desligado não recebem resposta atrasada (ficam para a loja responder pelo celular).
- A mensagem do site com o código do pedido só confirma o pedido (que já foi gravado pelo site) e não cria outro.
- Grupos: só mensagens que começam com `#pedido`; a conversa continua no privado.

- A sessão fica salva em `bot/auth/`. Se o aparelho for desconectado no celular, o bot apaga a sessão e mostra um QR Code novo no painel.
- Novidades publicadas no painel (ou por `#novidade`) com o canal **WhatsApp** são enviadas pelo bot em até 1 minuto aos clientes inscritos (opção 4 do menu), com pausa de alguns segundos entre cada envio.
- **Risco**: conexão por QR não é oficial. O WhatsApp pode bloquear números que mandam muitas mensagens para quem não tem o contato salvo. Use para responder clientes e envie novidades só a quem se inscreveu.

A alternativa oficial (WhatsApp Business Cloud API, paga por conversa) continua em `supabase/functions/whatsapp-bot`; para usá-la, preencha `BOT_FUNCTION_URL` em `config.js`.

## 5. Clientes, campanhas e cupons

Ao atualizar o código, rode de novo o `supabase/schema.sql` inteiro no **SQL Editor** (pode rodar quantas vezes quiser). Depois rode o `supabase/tests/cupons.sql`, que confere as regras do cupom direto no banco: ele precisa terminar sem erro e desfaz tudo no final. Por fim, reinicie o bot com `./instalar-servico-mac.sh`. Enquanto o banco não for atualizado, a loja e o bot continuam recebendo pedidos sem cupom, e as abas novas do painel avisam o que falta.

- **Clientes** (painel): todo mundo que já comprou, agrupado pelo WhatsApp (com e sem o 9 é a mesma pessoa), com número de pedidos, total gasto, último pedido e o que mais compra.
- **Cupons**: desconto em % ou em R$, pedido mínimo, vigência por data (dia inteiro, horário de Brasília) e cota de usos. Cada WhatsApp usa uma vez, e pedido cancelado devolve o uso. Vale no site (o link `?cupom=CODIGO` já aplica) e no bot ("cupom CODIGO"). Prefira código com número, como VOLTA10.
- **Campanhas**: escolha o público (todos, sumidos, quem comprou um produto, quem fez 3 pedidos ou mais, os 20 que mais gastaram ou os inscritos nas novidades), escreva a mensagem com `{nome}` e, se quiser, um cupom. O bot envia aos poucos: uma mensagem a cada 20 a 60 s, só no horário configurado e até o limite do dia (padrão: 80 por dia, das 9h às 20h). Quem responde "parar promoções" ou "parar novidades" não recebe mais campanhas nem novidades.
- **Risco**: mesmo nesse ritmo, disparo em massa pelo WhatsApp comum pode levar ao bloqueio do número. Comece com campanhas pequenas, para quem já conversou com a loja.

## Estrutura

```
index.html  admin.html  manifest.webmanifest  favicon.png  .nojekyll
assets/
  css/  base.css (tokens da paleta)  shop.css  admin.css
  js/   config.js  store.js (demo | supabase)  shop.js  admin.js  charts.js  icons.js  utils.js
        coupons.js (regras do cupom)  campaigns.js (público, texto e ritmo das campanhas)
  img/  fotos dos produtos e logo (recortadas da arte da cliente)
bot/
  index.js (WhatsApp por QR Code)  core.js (quando o bot fala)  sender.js (envio das campanhas)  *.test.js
supabase/
  schema.sql
  tests/cupons.sql                    testes das regras do cupom no banco
  functions/_shared/bot-engine.js     motor de conversa (navegador + Deno)
  functions/whatsapp-bot/index.ts     webhook + envio de novidades
docs/ESPECIFICACAO.md  docs/plans/ (desenho e plano de clientes, campanhas e cupons)
```
