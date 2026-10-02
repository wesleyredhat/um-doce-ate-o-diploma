# Um Doce Até o Diploma: especificação técnica e de design

Sistema de encomendas para um pequeno negócio de doces e salgados que vende principalmente para estudantes (identidade visual: formatura + odontologia, “porque sorrisos também se comem”).

Objetivo: **receber pedidos com o mínimo de atrito** (site e WhatsApp), **organizar a produção** e **mostrar se o negócio dá lucro**, com custo de infraestrutura zero no início.

---

## 1. Arquitetura geral

```
                 ┌──────────────────────────── GitHub Pages (estático, grátis) ───────────────────────────┐
 Cliente ──────► │ index.html  loja: carrossel, cardápio, pedido, novidades, carteirinha                │
 Confeiteira ──► │ admin.html  painel: login, pedidos, produção, produtos, financeiro, novidades,        │
                 │             clientes, campanhas, cupons                                               │
                 │ bot/        página /bot/: conexão do WhatsApp, números autorizados, simulador         │
                 └───────────────┬─────────────────────────────────────────────────────────────────────┘
                                 │ supabase-js (HTTPS, chave anon + JWT da admin)
                 ┌───────────────▼──────────────── Supabase (plano gratuito) ─────────────────────────────┐
                 │ Postgres + RLS   products · orders · news · settings · admins · bot_admins ·          │
                 │                  subscribers · bot_sessions · coupons · optouts · campaigns ·         │
                 │                  campaign_sends · view admin_customers                                │
                 │ RPC              place_order() · check_coupon() · loyalty_stamps() · is_admin()       │
                 │ Auth             e-mail/senha da administradora                                       │
                 │ Edge Function    whatsapp-bot  ◄── webhook ── WhatsApp Cloud API (Meta) ◄── Cliente   │
                 │                  └─ bot-engine.js (mesmo motor do simulador do painel)                │
                 └────────────────────────────────────────────────────────────────────────────────────────┘
```

Decisões:

| Decisão | Motivo |
|---|---|
| Front estático, sem build (HTML + CSS + ES Modules) | Exigência de GitHub Pages; qualquer pessoa edita e publica; carregamento rápido em 4G |
| Supabase como backend | Postgres + Auth + funções serverless num só lugar, plano gratuito folgado para o volume de uma confeitaria, SDK que funciona direto do navegador |
| Toda regra sensível no banco (RLS + funções `security definer`) | O código do site é público; a segurança não pode depender dele |
| Motor do bot em JS puro, compartilhado | O simulador do painel e o bot real têm exatamente o mesmo comportamento; dá para testar sem conta na Meta |
| Camada `store.js` com dois adaptadores (demo/Supabase) | Apresentar para a cliente hoje, ligar a produção depois sem mudar telas |

## 2. Fluxos de usuário

### 2.1 Pedido pelo site (meta: menos de 60 s)

1. Cliente chega pelo link (Instagram, grupo, QR code no balcão) → vê o hero com carrossel dos destaques.
2. Toca em **Adicionar** no cardápio ou em **Quero** no carrossel → o item aparece no pedido; no celular surge a barra fixa “N itens · R$ X · Finalizar”.
3. Na seção **Faça já o seu pedido!**: cada linha tem produto (select) e quantidade (stepper); informa **nome** e **WhatsApp** (máscara automática, validação de DDD). Observação é opcional e fica recolhida.
4. **Enviar pedido** → `place_order()` recalcula preços no servidor e devolve o código `DD-XXXX`.
5. Tela de sucesso com chuva de capelos, código do pedido e botão **Enviar resumo no WhatsApp** (mensagem pronta para a loja).
6. Nome e telefone ficam guardados no aparelho para a próxima compra; o carrinho sobrevive a recarregamento e esvazia depois de 30 min sem mexer (`CART_EXPIRES_MINUTES` em `config.js`), com um aviso.
7. **Cupom** (opcional): campo **Tem cupom de desconto?** ou link com `?cupom=CODIGO`. O desconto e o novo total aparecem antes de enviar (`check_coupon()`), e `place_order()` confere tudo de novo no servidor.

Sem cadastro, sem senha, sem pagamento online: o padrão do mercado para confeitarias pequenas é confirmar e cobrar via Pix no WhatsApp, e cada etapa a mais derruba a conversão.

### 2.2 Pedido pelo WhatsApp (bot)

```
Cliente: oi
Bot:     menu → 1 Fazer encomenda · 2 Cardápio · 3 Novidades · 4 Receber novidades · 5 Falar com a gente
Cliente: 1 → número do produto → quantidade → (mais itens | 0 finalizar) → nome (ou 1 = nome do perfil)
Bot:     resumo + total → 1 Confirmar · 2 Adicionar · 3 Cancelar
Cliente: 1
Bot:     Como prefere receber? 1 Na faculdade, em dia de aula (→ próximas 4 datas: seg, ter, qua, sex) · 2 Outro local ou retirada
Bot:     resumo com 📍 Entrega → 1 Confirmar
Bot:     🎓 Pedido DD-XXXX recebido! Total R$ … · vou conferir a agenda e confirmo com a chave Pix
Painel:  Confirmar → Bot: pedido confirmado (itens, total, entrega, chave legível) + (2ª mensagem) só o Pix Copia e Cola com o valor
Painel:  Pronto    → Bot: prontinho; no ponto, o lugar e o dia; senão a observação do pedido ou "vamos combinar"
Painel:  Entregue  → Bot: obrigada pela preferência + capelos da Carteirinha do Formando (ou "completou!")
```

- **Avisos do pedido**: um gatilho do banco (`orders_notice`) cria a fila em `order_notices` quando o pedido sai de Novo (Pix), chega em Pronto e chega em Entregue (agradecimento); o bot do Mac envia em até 10 s (`bot/notices.js`). Uma vez por pedido e tipo; pedido cancelado, "pronto" já entregue ou aviso com mais de 1 dia (bot desligado) é pulado.

- **Atalho em linguagem natural**: “quero 10 brigadeiros e 2 empadinhas”, “uma dúzia de casadinhos” → o bot monta o carrinho e pula direto para o nome.
- **Comandos globais**: `menu`, `oi`, `cancelar`.
- **Atendimento humano** (opção 5): bot fica em silêncio e avisa a dona (`OWNER_PHONE`) até o cliente mandar `menu`.
- **Inscrição em novidades** (opção 4) com saída por “parar novidades” ou “parar promoções” (exigência de opt-in da Meta). Quem sai também deixa de receber campanhas, e “parar” ou “sair” sozinho vale como saída para quem recebeu campanha nos últimos 30 dias.
- **Cupom**: “cupom VOLTA10” em qualquer momento, ou só o código no meio da conversa (se o cupom existir), anota o cupom; o pedido escrito na mesma mensagem segue mesmo se o cupom for recusado, e cupom que não existe numa conversa pessoal fica sem resposta; o resumo mostra o desconto e o total final. Se o cupom deixar de valer na confirmação, o bot explica e oferece seguir sem ele.

### 2.3 Grupo

- O bot ignora conversas normais do grupo e **só responde mensagens com `#pedido`** (ex.: `#pedido 6 casadinhos`), seguindo no privado para não poluir o grupo. O pedido é registrado com canal `grupo`.
- Novidades no grupo: botão **Compartilhar no grupo** em cada novidade do painel (abre o WhatsApp com o texto pronto e o link da loja). Funciona hoje, independentemente de suporte a grupos na API.

### 2.4 Administradora no WhatsApp

Números cadastrados em **Bot → Números autorizados**, com duas permissões:

| Comando | Permissão | Efeito |
|---|---|---|
| `#novidade Título \| texto` | Postar novidades | Publica no site e envia aos inscritos |
| `#pedidos` | Ver pedidos | Lista pedidos em aberto |
| `#producao` | Ver pedidos | Soma o que precisa ser produzido |

### 2.5 Painel

1. Login (Supabase Auth; sessão expira; só e-mails da tabela `admins` entram).
2. **Início**: saudação, KPIs do dia contra ontem, faturamento de 14 dias, canais, mais vendidos, pedidos em aberto.
3. **Pedidos**: quadro Novo → Confirmado → Em produção → Pronto → Entregue (arrastar ou botão de avançar). Busca, filtro por canal, botão de WhatsApp com **mensagem pronta para cada status** (confirmação com Pix, “está no forno”, “prontinho”, agradecimento com contagem da carteirinha). Atualiza a cada 30 s, também com a aba em segundo plano, com aviso sonoro e contador na aba do navegador. Enquanto o navegador não libera o som (painel aberto já logado, sem clique), aparece o botão **Ativar som**.
4. **Produção**: soma de unidades por produto dos pedidos não prontos, com detalhamento por pedido e impressão.
5. **Novo pedido**: lançamento manual (balcão, telefone, Instagram).
6. **Clientes**: quem já comprou, agrupado por telefone (com e sem o 9 é a mesma pessoa), com pedidos, total gasto, último pedido e produtos favoritos.
7. **Cupons**: % ou R$, pedido mínimo, vigência por data, cota de usos, uma vez por WhatsApp; mostra usos, vendas e desconto dado.
8. **Campanhas**: público por filtro (todos, sumidos, quem comprou um produto, 3 pedidos ou mais, os 20 que mais gastaram, inscritos), mensagem com `{nome}` e cupom opcional, prévia, estimativa de término e progresso. O bot envia uma mensagem a cada 20 a 60 s, no horário e no limite diário configurados.
9. **Bot WhatsApp** fica fora do menu do painel, na página `/bot/` (`bot/index.html`, mesmo login): conexão do WhatsApp (QR Code ou código), números autorizados e simulador.

## 3. Estrutura de dados

```sql
products    (id, name, category[doces|salgados], description, price, cost, image, badge, active, featured, sort)
orders      (id, code, customer_name, phone, items jsonb, total, cost_total, channel[web|whatsapp|grupo|balcao],
             status[novo|confirmado|producao|pronto|entregue|cancelado], notes, created_at, updated_at)
             items = [{product_id, name, qty, unit_price, unit_cost}]   ← cópia no momento da venda
news        (id, title, body, image, channels text[site|whatsapp], published, author, created_at)
settings    (key, value jsonb)        'store' → accepting, notice, pix_key, bot_greeting, fixed_costs[]
                                      'campaigns' → daily_limit, start_hour, end_hour (só admin)
admins      (user_id → auth.users, name)
bot_admins  (id, phone, name, can_post, can_manage_orders)
subscribers (phone, name, created_at)
bot_sessions(phone, data jsonb, updated_at)
coupons     (id, code, kind[percent|fixed], value, min_order, starts_on, ends_on, max_uses, active, created_at)
optouts     (phone_key, phone, created_at)              quem pediu para não receber campanhas nem novidades
campaigns   (id, name, body, coupon_id, audience jsonb, status[enviando|pausada|concluida|cancelada], pause_reason, created_at, finished_at)
campaign_sends (id, campaign_id, phone, phone_key, name, status[pendente|enviando|enviada|falhou|pulada], error, claimed_at, sent_at)
orders.delivery [ponto|combinar], orders.delivery_date   ← ponto = settings.store.delivery_spot {label, days[0-6]}, de amanhã até 14 dias
order_notices (id, order_id, kind[confirmado|pronto|entregue], status[pendente|enviando|enviada|falhou|pulada], error, created_at, sent_at)   ← um por pedido e tipo
             orders também guarda coupon_code e discount (total = subtotal − desconto)
view admin_customers  quem comprou, agrupado por phone_key (só admin)
```

- **Snapshot de preço e custo no item**: mudar o preço amanhã não altera o lucro de ontem.
- **Telefone normalizado** `55DDDNÚMERO` em todo lugar (pedidos, bot, fidelidade, links `wa.me`).
- **Segurança (RLS)**: público lê produtos ativos, novidades publicadas e `settings.store`; cria pedido apenas via `place_order()` (valida canal, quantidade de 1 a 500, até 20 itens, produto ativo, loja aberta); `loyalty_stamps()` devolve só um número; `check_coupon()` só confere o cupom, sem gravar. As regras do cupom ficam em `coupon_discount()`, que o público não chama direto. Cupons, campanhas, envios, a lista de saída e a view de clientes exigem `is_admin()`, como todo o resto. `bot_sessions` só é acessível pela service role da Edge Function.

## 4. Interface

### 4.1 Identidade (extraída da arte da cliente)

| Token | Cor | Uso |
|---|---|---|
| `--cream` | `#F7ECDF` | fundo (papel) |
| `--sand` | `#EFDCC5` | etiquetas, chips, superfícies secundárias |
| `--latte` | `#E3C7A7` | bordas tracejadas, série “custo” |
| `--caramel` | `#B98A63` | detalhes, foco |
| `--cocoa` | `#8A5C45` | blobs orgânicos, textos de apoio |
| `--choc` | `#5B3522` | botões, títulos, série “lucro” |
| `--espresso` | `#3A2116` | texto, sidebar do painel |
| `--berry` | `#E3867B` | destaque (morango): contadores, selos, sublinhado |

Tipografia: **Caveat** (manuscrita, como “jornada” e “Faça já o seu pedido!” da arte), **Fredoka** (arredondada, como “UM DOCE ATÉ O DIPLOMA”), **Nunito** (texto). Ícones em traço desenhado à mão (coração, chapéu de chef, dente, capelo), rabiscos e blobs marrons como na arte. Fotos e logo recortados da própria arte.

### 4.2 Componentes principais

Loja: topo fixo com contador do pedido · hero com título manuscrito · **carrossel** (scroll-snap, swipe nativo, autoplay que pausa ao tocar, pontos e setas, respeita *reduced motion*) · faixa de diferenciais · cards de produto (foto, selo, preço, adicionar → stepper) · formulário de pedido em linhas · barra fixa de finalização no celular · modal de sucesso · novidades · **Carteirinha do Formando** (10 capelos; o último é o brinde) · botão de WhatsApp.

Painel: sidebar (desktop) / tab bar (celular) · KPIs · gráfico de barras empilhadas custo + lucro (altura = faturamento) com tooltip · rosca de canais · quadro kanban · cards de produto com preço, custo e margem colorida · modais de edição · simulador de WhatsApp.

### 4.3 Boas práticas de conversão aplicadas

- Pedido acessível de qualquer ponto (topo, carrossel, cards, barra fixa).
- Três campos obrigatórios; nada de conta, CEP ou pagamento no site.
- Preço sempre visível, total atualizado ao vivo.
- Prova social e diferenciais acima da dobra; foto real do produto.
- Confirmação imediata com código + ponte para o WhatsApp (canal onde o cliente já está).
- Fidelidade simples e visual, que incentiva a recompra.
- Mobile-first: alvos de toque de 44 px ou mais, sem rolagem horizontal, `safe-area` no iPhone.
- Acessibilidade: contraste AA no texto, foco visível, `aria-live` no carrinho e na carteirinha, rótulos em todos os campos.

## 5. Controle financeiro

| Indicador | Cálculo |
|---|---|
| Faturamento | Σ `total` dos pedidos não cancelados no período |
| Custo dos produtos (CMV) | Σ `cost_total` (custo unitário cadastrado × quantidade, gravado na venda) |
| Lucro bruto / margem | faturamento − CMV · (lucro ÷ faturamento) |
| Lucro líquido estimado | lucro bruto − custos fixos mensais × (dias do período ÷ 30) |
| Ticket médio / lucro por pedido | ÷ nº de pedidos |
| Comparação | mesmo indicador no período anterior de igual duração (▲▼ %) |
| Por produto | unidades, receita, custo, lucro, margem e participação no lucro |
| Por canal | pedidos e receita de Site, WhatsApp, Grupo, Balcão |

Ferramentas: períodos de 7/30/90 dias e 12 meses (barras semanais) · exportação CSV (abre no Excel, separador `;`, UTF-8 com BOM) · **simulador de preço** (ingredientes + embalagem + margem desejada → preço arredondado a R$ 0,50) · sugestão automática de preço para 60% de margem na edição de produto · cores de margem: verde ≥ 55%, amarelo ≥ 35%, vermelho abaixo.

## 6. Tecnologia e operação

| Camada | Escolha | Alternativa quando crescer |
|---|---|---|
| Hospedagem | GitHub Pages | Cloudflare Pages / Vercel (domínio próprio, preview por branch) |
| Banco/Auth | Supabase Free | Supabase Pro (backups diários, sem pausa por inatividade) |
| Bot | WhatsApp Cloud API oficial + Edge Function | BSPs (Z-API, Twilio, 360dialog) se precisar de grupos ou inbox compartilhada |
| Imagens | redimensionadas no navegador (máx. 900 px, JPEG 82%) e salvas no registro | Supabase Storage + CDN |
| Gráficos | SVG próprio (≈ 3 KB) | não precisa |

Custos: hospedagem e banco R$ 0. WhatsApp Cloud API cobra por conversa iniciada pela empresa (templates de marketing); respostas dentro da janela de 24h após mensagem do cliente não são cobradas.

Atenção operacional:
- O projeto Supabase gratuito pausa após 7 dias sem acesso; o uso diário do painel evita isso.
- Para domínio próprio: arquivo `CNAME` na raiz + DNS apontando para o GitHub Pages.

## 7. Próximos passos sugeridos

1. Notificação automática ao cliente quando o status mudar (template “pedido pronto”).
2. Agenda de produção por data de retirada (campo `pickup_at` + calendário).
3. Pix com QR code dinâmico e baixa automática (Mercado Pago / Asaas).
4. Estoque de insumos com ficha técnica por produto (custo calculado automaticamente).
