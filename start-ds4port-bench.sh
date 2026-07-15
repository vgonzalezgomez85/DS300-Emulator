#!/bin/bash
# ── Banco completo DS 4-port ────────────────────────────────────────────────────
# Levanta 4 DS-300 (emulator.js) + el agrupador (ds4port.js) con todo el plumbing
# de puertos socat, y deja PitWall con UN solo COM que ver.
#
#   emulator 3100 ─→ /tmp/ds300-emu1 ══ /tmp/ds300-app1 ─┐
#   emulator 3101 ─→ /tmp/ds300-emu2 ══ /tmp/ds300-app2 ─┤
#   emulator 3102 ─→ /tmp/ds300-emu3 ══ /tmp/ds300-app3 ─┼─[ds4port 3200]─→ /tmp/ds4-out ══ /tmp/ds4-app ─→ PitWall
#   emulator 3103 ─→ /tmp/ds300-emu4 ══ /tmp/ds300-app4 ─┘
set -u
cd "$(dirname "$0")"
LOG=/tmp/ds4bench
mkdir -p $LOG

echo "▶ Limpiando instancias previas…"
pkill -f "ds4port.js"  2>/dev/null
pkill -f "director.js" 2>/dev/null
pkill -f "emulator.js" 2>/dev/null
pkill -f "socat.*ds300-emu[1-4]" 2>/dev/null
pkill -f "socat.*ds4-out"        2>/dev/null
sleep 0.5
rm -f /tmp/ds300-emu[1-4] /tmp/ds300-app[1-4] /tmp/ds4-out /tmp/ds4-app 2>/dev/null

echo "▶ Creando pares de puertos socat…"
for i in 1 2 3 4; do
  nohup socat -d -d pty,raw,echo=0,link=/tmp/ds300-emu$i pty,raw,echo=0,link=/tmp/ds300-app$i \
    >$LOG/socat-in$i.log 2>&1 &
done
nohup socat -d -d pty,raw,echo=0,link=/tmp/ds4-out pty,raw,echo=0,link=/tmp/ds4-app \
  >$LOG/socat-out.log 2>&1 &
sleep 1.5

echo "▶ Arrancando 4 emuladores DS-300 (puertos HTTP 3100-3103)…"
for i in 0 1 2 3; do
  port=$((3100 + i))
  DS_HTTP_PORT=$port DS_LANES=8 nohup node emulator.js >$LOG/emu$((i+1)).log 2>&1 &
done
sleep 2

echo "▶ Conectando cada emulador a su puerto serie…"
for i in 0 1 2 3; do
  port=$((3100 + i))
  emu=/tmp/ds300-emu$((i+1))
  curl -s -X POST http://localhost:$port/api/connect \
    -H 'Content-Type: application/json' -d "{\"port\":\"$emu\",\"baud\":56000}" >/dev/null
done
sleep 0.5

echo "▶ Arrancando agrupador DS 4-port (HTTP 3200), auto-conectando entradas + salida…"
DS4_HTTP_PORT=3200 \
DS4_OUT=/tmp/ds4-out \
DS4_IN1=/tmp/ds300-app1 \
DS4_IN2=/tmp/ds300-app2 \
DS4_IN3=/tmp/ds300-app3 \
DS4_IN4=/tmp/ds300-app4 \
  nohup node ds4port.js >$LOG/ds4port.log 2>&1 &
sleep 2

echo "▶ Arrancando director de carrera (HTTP 3099, escanea 3100-3103)…"
nohup node director.js >$LOG/director.log 2>&1 &
sleep 1

echo ""
echo "✓ Banco levantado. Logs en $LOG/"
echo "  Director:  http://localhost:3099   (GO/pausa/stop de los 4 a la vez)"
echo "  Agrupador: http://localhost:3200   (mux en vivo)"
echo "  PitWall  → /tmp/ds4-app"
