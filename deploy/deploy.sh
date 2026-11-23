#!/usr/bin/env bash
# Выкладка игры на свой сервер: ./deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
H=root@38.97.56.42; APP=tactical-loot-chess
S="ssh -i $HOME/.ssh/id_ed25519_gameserver -o IdentitiesOnly=yes"
rsync -az --delete -e "$S" --exclude node_modules --exclude data server.js accounts.js ai.js package.json package-lock.json public art $H:/srv/$APP/
$S $H "cd /srv/$APP && chown -R tlc:tlc . && sudo -u tlc -H npm ci --omit=dev --silent && systemctl restart $APP && sleep 1 && systemctl is-active $APP"
