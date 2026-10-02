#!/bin/bash
# Deixa o bot rodando em segundo plano no Mac: liga junto com o login e reinicia se cair.
#   ./instalar-servico-mac.sh            instala/atualiza
#   ./instalar-servico-mac.sh remover    desinstala
# Antes, rode "npm start" uma vez e escaneie o QR Code (a sessão fica em ./auth).
set -euo pipefail

LABEL=com.umdoce.bot
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

if [ "${1:-}" = "remover" ]; then
  rm -f "$PLIST"
  echo "Bot removido do início automático."
  exit 0
fi

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js não encontrado. Instale em https://nodejs.org"; exit 1; }
[ -f "$DIR/.env" ] || { echo "Falta o arquivo bot/.env (copie de .env.example e preencha)."; exit 1; }
[ -d "$DIR/auth" ] || { echo "Rode 'npm start' uma vez e escaneie o QR Code antes de instalar o serviço."; exit 1; }

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

launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✅ Bot instalado. Ele liga sozinho no login e reinicia se cair."
echo "   Ver o log:  tail -f \"$DIR/bot.log\""
