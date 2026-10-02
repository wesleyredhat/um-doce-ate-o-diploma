#!/bin/bash
# Deixa o bot rodando em segundo plano no Mac: liga junto com o login e reinicia se cair.
#   ./instalar-servico-mac.sh            instala/atualiza
#   ./instalar-servico-mac.sh remover    desinstala
# Antes: npm install e a Secret key do Supabase no arquivo .env.
# Se o WhatsApp ainda não estiver conectado, o QR Code aparece na página /bot do site.
# Pode rodar por ssh, desde que o mesmo usuário esteja logado na tela do Mac.
set -euo pipefail

LABEL=com.umdoce.bot
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }
stop() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 20); do loaded || return 0; sleep 0.5; done # espera o bot antigo terminar de sair
}

if [ "${1:-}" = "remover" ]; then
  stop
  rm -f "$PLIST"
  echo "Bot removido do início automático."
  exit 0
fi

# Confere tudo antes de mexer no serviço que está rodando.
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js não encontrado no PATH. Instale em https://nodejs.org ou rode: PATH=/caminho/do/node/bin:\$PATH $0"; exit 1; }
[ -d "$DIR/node_modules" ] || { echo "Rode 'npm install' na pasta bot antes."; exit 1; }
[ -f "$DIR/.env" ] || { echo "Falta o arquivo bot/.env (copie de .env.example e preencha)."; exit 1; }
grep -Eq '^SUPABASE_SECRET_KEY=(sb_secret_|eyJ).+' "$DIR/.env" || { echo "Cole a Secret key do Supabase (sb_secret_...) em SUPABASE_SECRET_KEY no arquivo bot/.env. A publishable não serve."; exit 1; }
launchctl print "$DOMAIN" >/dev/null 2>&1 || { echo "Faça login na tela do Mac com este usuário e rode de novo (o serviço roda na sessão dele)."; exit 1; }

# Sessão do WhatsApp, chave e log só para o próprio usuário.
chmod 600 "$DIR/.env"
if [ -d "$DIR/auth" ]; then chmod -R go-rwx "$DIR/auth"; fi
touch "$DIR/bot.log" && chmod 600 "$DIR/bot.log"

stop
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE</string><string>--env-file=.env</string><string>index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/bot.log</string>
  <key>StandardErrorPath</key><string>$DIR/bot.log</string>
</dict>
</plist>
EOF

for _ in 1 2 3; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    echo "✅ Bot instalado. Ele liga sozinho no login e reinicia se cair."
    echo "   Para conectar o WhatsApp: página /bot do site (QR Code). Log: tail -f \"$DIR/bot.log\""
    exit 0
  fi
  sleep 2
done
echo "Não consegui ligar o serviço. Tente de novo em alguns segundos: $0"
exit 1
