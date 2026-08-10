#!/bin/bash
# ── Banco 3 DS-300 (sin agrupador) ──────────────────────────────────────────────
# 3 DS-300 independientes + director. PitWall ve 3 COM separados (C1/C2/C3).
#
#   emulator 3100 ─→ /tmp/ds300-emu1 ══ /tmp/ds300-app1 ─→ PitWall C1
#   emulator 3101 ─→ /tmp/ds300-emu2 ══ /tmp/ds300-app2 ─→ PitWall C2
#   emulator 3102 ─→ /tmp/ds300-emu3 ══ /tmp/ds300-app3 ─→ PitWall C3
#   director 3099 ─→ GO/pausa/reanudar/stop de los 3 a la vez
set -u
cd "$(dirname "$0")"
LOG=/tmp/ds3bench
mkdir -p $LOG

echo "▶ Limpiando instancias previas…"
pkill -f "director.js"                2>/dev/null
pkill -f "emulator.js"                2>/dev/null
pkill -f "socat.*ds300-emu[1-3]"      2>/dev/null
sleep 0.5
rm -f /tmp/ds300-emu[1-3] /tmp/ds300-app[1-3] 2>/dev/null

echo "▶ Creando 3 pares de puertos socat…"
for i in 1 2 3; do
  nohup socat -d -d pty,raw,echo=0,link=/tmp/ds300-emu$i pty,raw,echo=0,link=/tmp/ds300-app$i \
    >$LOG/socat$i.log 2>&1 &
done
sleep 1.5

echo "▶ Arrancando 3 emuladores DS-300 (HTTP 3100-3102)…"
for i in 0 1 2; do
  port=$((3100 + i))
  DS_HTTP_PORT=$port DS_LANES=8 nohup node emulator.js >$LOG/emu$((i+1)).log 2>&1 &
done
sleep 2

echo "▶ Conectando cada emulador a su puerto serie…"
for i in 0 1 2; do
  port=$((3100 + i))
  emu=/tmp/ds300-emu$((i+1))
  curl -s -X POST http://localhost:$port/api/connect \
    -H 'Content-Type: application/json' -d "{\"port\":\"$emu\",\"baud\":56000}" >/dev/null
done
sleep 0.5

echo "▶ Arrancando director de carrera (HTTP 3099, escanea 3100-3102)…"
DS_DIRECTOR_SCAN=3100-3102 nohup node director.js >$LOG/director.log 2>&1 &
sleep 1

echo ""
echo "✓ Banco de 3 DS levantado. Logs en $LOG/"
echo "  Director:   http://localhost:3099"
echo "  Emuladores: http://localhost:3100  /3101  /3102"
echo "  PitWall  →  /tmp/ds300-app1  /app2  /app3"
