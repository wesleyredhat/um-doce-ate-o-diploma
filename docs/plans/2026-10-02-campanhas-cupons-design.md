# Clientes, campanhas e cupons: desenho

Data: 2026-10-02 · Situação: implementado (passo a passo em [2026-10-02-campanhas-cupons.md](2026-10-02-campanhas-cupons.md)). A aplicação ainda não está em produção, então não há preocupação com compatibilidade de versões antigas.

## Objetivo

1. Ver no painel todos os clientes que já compraram.
2. Disparar campanhas e promoções em massa pelo WhatsApp do bot (conexão por QR Code).
3. Oferecer cupons de desconto com cota, vigência e valor, aplicados automaticamente no site e no bot.

## Restrição principal: risco de bloqueio do número

O bot usa o WhatsApp comum por QR Code (não oficial), e o número também é de uso pessoal. Envio em massa é a principal causa de bloqueio. Por isso o envio é lento, só em horário comercial, com limite diário, personalizado por cliente e com saída fácil ("parar promoções"). Esses limites não são opcionais.

## Decisões

| Tema | Decisão |
|---|---|
| Envio | Fila no banco (uma linha por destinatário); o bot envia aos poucos e marca cada envio |
| Público | Filtros prontos, com contagem e opção de desmarcar pessoas |
| Cupom | Automático no site e no bot, validado no servidor |
| Uso do cupom | Um código por campanha; qualquer pessoa usa, uma vez por WhatsApp |
| Fora desta versão | Foto na mensagem, agendamento, migrar as Novidades para a nova fila |

## 1. Clientes

Aba nova **Clientes** no painel, montada a partir dos pedidos (sem cadastro à parte).

- Fonte: view `admin_customers` (`security_invoker`, então vale a mesma regra de acesso de `orders`: só admin). Cobre todo o histórico; o painel hoje só carrega 400 dias de pedidos.
- Agrupada por `phone_key(phone)`, que unifica celulares com e sem o 9 (mesma regra de `samePhone` no motor do bot).
- Colunas: telefone (o mais recente), nome (do último pedido), pedidos (sem cancelados), total gasto, primeiro e último pedido, `product_ids` (produtos já comprados) e `top_products` (3 mais comprados por quantidade).
- Na tela: busca, ordenação, botão de WhatsApp individual e selo "sem promoções" para quem está em `optouts`.

Filtros de público para campanhas:

- Todos os clientes
- Sumidos: último pedido há mais de 30, 60 ou 90 dias
- Compraram um produto específico
- Melhores clientes: 3 ou mais pedidos, ou os 20 que mais gastaram
- Inscritos nas novidades (`subscribers`), incluindo quem nunca comprou

Quem está em `optouts` nunca entra em nenhum filtro.

## 2. Cupons

Tabela `coupons`:

| Coluna | Regra |
|---|---|
| `code` | único, guardado em maiúsculas |
| `kind` | `percent` ou `fixed` |
| `value` | maior que 0; em `percent`, no máximo 100 |
| `min_order` | pedido mínimo, padrão 0 |
| `starts_on`, `ends_on` | vigência em datas; vale das 00:00 do início às 23:59 do fim, em America/Sao_Paulo; `ends_on` pode ser vazio |
| `max_uses` | cota total; vazio = ilimitado |
| `active` | liga/desliga na hora |

Regras (iguais no SQL e no JS do modo demonstração):

- Uso contado pelos pedidos com aquele cupom que não estão cancelados. Pedido cancelado devolve a cota e libera o cliente para usar de novo.
- Uma vez por `phone_key`.
- Desconto nunca maior que o subtotal; arredondado em centavos.
- Mensagens de recusa: "Cupom não encontrado", "Cupom pausado", "Cupom ainda não começou", "Cupom expirado", "Cupom esgotado", "Você já usou este cupom", "Vale para pedidos a partir de R$ X".

Banco:

- `orders` ganha `coupon_code text` e `discount numeric(10,2) default 0`. `total` passa a ser o valor final (subtotal menos desconto), então receita, lucro e margem do financeiro continuam certos sem mudança.
- `place_order(p_name, p_phone, p_items, p_channel, p_notes, p_coupon default null)`: calcula o subtotal, trava a linha do cupom (`select ... for update`) para dois pedidos simultâneos não passarem da cota, valida e grava. A assinatura antiga de 5 parâmetros é removida (`drop function`) para não haver ambiguidade no PostgREST.
- `check_coupon(p_code, p_phone, p_items)`: mesma validação sem gravar; devolve `{ valid, code, discount, subtotal, total, message }`. Usada pelo site e pelo bot para mostrar o desconto antes de confirmar.
- `phone_key(text)`: só dígitos, com o 55 e com o 9 do celular (número antigo sem o 9 ganha o 9; fixo fica como está), a mesma regra de `samePhone` no motor do bot.

Site:

- `?cupom=CODIGO` na URL preenche o cupom; o formulário ganha o campo "Tem cupom de desconto?".
- Mostra desconto e novo total antes de enviar (`check_coupon`). A regra "uma vez por WhatsApp" é conferida quando o telefone está preenchido e de novo ao gravar.
- A mensagem de WhatsApp enviada depois do pedido inclui o cupom e o desconto.

Bot (motor em `supabase/functions/_shared/bot-engine.js`):

- "cupom VOLTA10" em qualquer mensagem é reconhecido; também conta como intenção explícita, então chama o bot mesmo fora de conversa. O código precisa ter número ou vir em maiúsculas: "qual cupom tem hoje?" não é cupom.
- Dentro de uma conversa, uma mensagem que é só um código (ex.: "VOLTA10") também é testada como cupom.
- O cupom fica na sessão; a confirmação mostra "Desconto VOLTA10: −R$ 4,00" e o total final, recalculado se o carrinho mudar.
- Se o cupom deixar de valer na hora de gravar, o bot explica o motivo e oferece confirmar sem cupom.

Painel: área de cupons com lista (código, desconto, vigência, usos "12 de 50", situação: ativo, agendado, expirado, esgotado ou pausado), criar, editar e pausar. Cada cupom mostra usos, receita gerada e desconto concedido.

## 3. Campanhas e envio

Tabelas:

- `campaigns`: `name`, `body` (texto com `{nome}`), `coupon_id` (opcional), `audience jsonb` (filtro usado, para registro), `status` (`enviando`, `pausada`, `concluida`, `cancelada`; sem rascunho, a campanha nasce na hora do envio), `pause_reason`, `created_at`, `finished_at`.
- `campaign_sends`: `campaign_id`, `phone`, `phone_key`, `name`, `status` (`pendente`, `enviando`, `enviada`, `falhou`, `pulada`), `error`, `claimed_at`, `sent_at`; único por (`campaign_id`, `phone_key`).
- `optouts`: `phone_key` (chave), `phone`, `created_at`.
- `settings` chave `campaigns` (só admin lê): `{ daily_limit: 80, start_hour: 9, end_hour: 20 }`, editável na aba Campanhas (Ritmo de envio).

Criar campanha (aba **Campanhas**): nome interno, público (filtro, contagem, desmarcar), mensagem com `{nome}`, cupom opcional (acrescenta o código e o link `?cupom=`), prévia no formato do WhatsApp. Rodapé fixo: "_Para não receber mais promoções, responda *parar promoções*._". Ao enviar, o painel grava a campanha e as linhas de `campaign_sends` e mostra a estimativa ("47 mensagens · termina hoje por volta das 16h").

Envio pelo bot (módulo novo `bot/sender.js`, sem Baileys nem Supabase, testável como `bot/core.js`; público, texto e ritmo ficam em `assets/js/campaigns.js`, usado também pelo painel):

- Uma mensagem a cada 20 a 60 s (aleatório), só entre `start_hour` e `end_hour` no horário de Brasília, até `daily_limit` por dia somando todas as campanhas. O que sobra continua no dia seguinte.
- Pega o próximo `pendente` da campanha `enviando` mais antiga, marca `enviando` (claim atômico), confere `optouts` (vira `pulada`), confere se o número tem WhatsApp (`onWhatsApp`; senão `falhou`), envia com `{nome}` trocado pelo primeiro nome e marca `enviada`.
- 5 erros de envio seguidos: campanha vai para `pausada` com o motivo. WhatsApp desconectado: a fila só espera, e o painel avisa.
- Linha em `enviando` há mais de 5 min (bot caiu no meio) volta para `pendente`. No pior caso, uma pessoa recebe a mensagem duas vezes.
- Quando não sobra `pendente`, a campanha vira `concluida`.

Painel acompanha o progresso (enviadas, pendentes, falhas, puladas) e permite pausar, retomar e cancelar. Com o bot desligado, mostra "bot desligado, envios parados".

Saída e volta:

- "parar promoções" ou "parar novidades": grava em `optouts` e remove de `subscribers`. Vale para campanhas e novidades. O bot confirma.
- "quero receber novidades" (ou a opção 4 do menu): remove de `optouts` e inscreve de novo.
- Quem sai também é removido de `subscribers`, então as Novidades deixam de chegar sem mudar o envio delas.

Respostas à campanha seguem as regras atuais de `bot/core.js`: "menu", pedido escrito ou "cupom X" chamam o bot; o resto fica para atendimento humano. A mensagem sugere "Peça pelo link ou responda *menu*".

## 4. Erros, testes e implantação

Modo demonstração: tudo funciona com localStorage; o simulador do painel aceita cupom; campanhas são simuladas (nada é enviado). As regras do cupom ficam num módulo JS puro (`assets/js/coupons.js`) usado pelo DemoStore e pelos testes, espelhando o SQL.

Testes (`npm test` em `bot/`, relógio falso):

- Cupom no bot: aplicado, ainda não começou, expirado, esgotado, já usado (com e sem o 9), abaixo do mínimo, pausado, recusado na hora de gravar.
- `coupons.js`: percentual, valor fixo, teto no subtotal, arredondamento, limites de data no fuso de Brasília.
- "parar promoções", "parar novidades" e "quero receber novidades".
- `assets/js/campaigns.js`: filtros de público, clientes a partir dos pedidos, `{nome}`, texto com cupom e link, estimativa de término.
- `bot/sender.js`: janela de horário, limite diário, retomada no dia seguinte, pausa após 5 falhas, pular opt-out, devolver `enviando` antigo para a fila.
- SQL: `supabase/tests/cupons.sql`, roda no SQL Editor dentro de uma transação com `rollback` e confere as regras do cupom direto em `place_order` e `check_coupon`.

Implantação: rodar o SQL novo no Supabase (idempotente), atualizar o bot no Mac (`./instalar-servico-mac.sh`) e fazer push do site. Atualizar README e `docs/ESPECIFICACAO.md`.
