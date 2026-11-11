#!/bin/sh
set -eu

if [ -z "${BASIC_AUTH_USER:-}" ] || [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
  echo "BASIC_AUTH_USER and BASIC_AUTH_PASSWORD must be configured." >&2
  exit 1
fi

if [ -z "${VNC_PASSWORD:-}" ]; then
  echo "VNC_PASSWORD must be configured." >&2
  exit 1
fi

mkdir -p /app/data /run/livepilot-vnc
chown livepilot:livepilot /app/data
chown -R livepilot:livepilot /run/livepilot-vnc
gosu livepilot mkdir -p /app/data/browser-profiles
chmod 0700 /app/data/browser-profiles /run/livepilot-vnc

x11vnc -storepasswd "$VNC_PASSWORD" /run/livepilot-vnc/passwd >/dev/null

Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac &
sleep 1
fluxbox -display :99 >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -rfbport 5900 -rfbauth /run/livepilot-vnc/passwd \
  -listen 127.0.0.1 -forever -shared -noxdamage >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 127.0.0.1:6080 127.0.0.1:5900 >/tmp/novnc.log 2>&1 &

gosu livepilot node scripts/init-db.mjs

unset VNC_PASSWORD
gosu livepilot node_modules/.bin/next start --hostname 127.0.0.1 --port "${INTERNAL_APP_PORT:-3001}" &
NEXT_PID=$!
gosu livepilot node deploy/railway-proxy.mjs &
PROXY_PID=$!
shutdown() {
  kill -TERM "$PROXY_PID" "$NEXT_PID" 2>/dev/null || true
  wait "$PROXY_PID" 2>/dev/null || true
  wait "$NEXT_PID" 2>/dev/null || true
}
trap shutdown EXIT INT TERM
wait "$PROXY_PID"
