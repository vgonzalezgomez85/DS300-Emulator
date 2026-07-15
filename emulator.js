'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT     = parseInt(process.env.DS_HTTP_PORT || '3100', 10);
const DEFAULT_DURATION_MIN = parseInt(process.env.DS_DURATION_MIN || '5', 10);
let RACE_DURATION_MS = DEFAULT_DURATION_MIN * 60 * 1000;
const NUM_LANES        = parseInt(process.env.DS_LANES || '8', 10);
// Id de caja del AGRUPADOR (byte[4]). Un DS-300 suelto lleva 0x00 ahí; el aparato
// que agrupa varias cajas en un puerto sobrescribe ese byte con el nº de caja
// (0x01, 0x02, 0x03, 0x04). Poniendo DS_BOX_ID=2 este emulador imita la caja 2 de
// un agrupador, y PitWall (modo "DS-300 agrupador") mapea sus carriles al 9–16.
const BOX_ID           = parseInt(process.env.DS_BOX_ID || '0', 10) & 0xFF;
// Media de vuelta fija para todos los carriles (ms). Si no se define DS_AVG_MS,
// se usa la media aleatoria por carril de siempre (9-12s).
const AVG_LAP_MS       = process.env.DS_AVG_MS ? parseInt(process.env.DS_AVG_MS, 10) : null;
// Cadencia mínima entre tramas, medida en 2 registros reales (RegistroCarrera /
// registro carrera 2, 8000+ tramas cada uno): el DS-300 NUNCA manda dos tramas
// a menos de ~160 ms — pico clarísimo en 160 ms, cero huecos < 75 ms. Cuando
// tiene varios cruces buffereados los serializa a ~160 ms cada uno (no hace
// ráfagas en el cable). Antes estaba en 110 (irrealmente apretado).
const FRAME_GAP_MS     = 160;

// ── DS-300 frame protocol (verified against real hardware capture) ──────────
//
// Frame: 21 bytes
//   [0]    = 0xE0  (sync)
//   [1]    = counter (increments per frame, 0x00-0xFF, rolls over)
//   [2-6]  = 15 03 00 04 4C (fixed header)
//   [7]    = 0x3E (GO marker) | 0x1B (crossing) | 0x00 (control: A2/A3/A4/A7)
//   [8]    = event type
//   [9]    = 0x00
//   [10]   = lane bitmask | BCD duration (GO) | 0x00 (control)
//   [11]   = 0x00
//   [12]   = lap counter (1..N) for crossings, 0x00 for control
//   [13]   = 0x00
//   [14]   = 0xAA → first-crossing marker (invalid time) | BCD mins
//   [15-17]= BCD secs/cents/dmils (or pseudo-bytes if first crossing)
//   [18]   = checksum-like byte (varies)
//   [19]   = 0x00
//   [20]   = 0xEB  (end marker)
//
// GO sequence (3 frames, real hardware timing):
//   Trama 1 (t=0):       [7]=0x3E [8]=0xA1 [10]=BCD(durationMins)  ← race info + start
//   Trama 2 (t≈+2500ms): [7]=0x00 [8]=0xA2                          ← intermediate step
//   Trama 3 (t≈+2953ms): [7]=0x00 [8]=0xA3                          ← current ON / countdown starts
//
// Other control frames:
//   Finish:      [7]=0x00 [8]=0xA4
//   ForcedStop:  [7]=0x00 [8]=0xA7
//   Pause:       [1]=0x0C (frame counter override, no lane)
//   Resume:      [1]=0x0F

const LANE_MASK = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];

let frameCounter = 0xD0; // start at a recognizable value

function nextCounter() {
  frameCounter = (frameCounter + 1) & 0xFF;
  return frameCounter;
}

// BCD encode: 12 → 0x12, 59 → 0x59
function bcd(n) {
  n = Math.min(99, Math.max(0, Math.round(n)));
  return ((Math.floor(n / 10)) << 4) | (n % 10);
}

// Encode lap time (integer ms) into 4 DS-300 BCD bytes
// Formula inverse: ms = mins*60000 + secs*1000 + cents*10 + dmils*0.1
function encodeLapTime(ms) {
  const t     = Math.round(ms);
  const mins  = Math.floor(t / 60000);
  const secs  = Math.floor((t % 60000) / 1000);
  const cents = Math.floor((t % 1000) / 10);
  const dmils = (t % 10) * 10; // ten-thousandths (always 0 for integer ms)
  return [bcd(mins), bcd(secs), bcd(cents), bcd(dmils)];
}

// Checksum B18 = (B1 + B2 + ... + B17) mod 256, per DS-300 protocol.
// B0 (0xE0) and B20 (0xEB) excluded.
function computeChecksum(b1, b2, b3, b4, b5, b6, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17) {
  return (b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9 + b10 + b11 + b12 + b13 + b14 + b15 + b16 + b17) & 0xFF;
}

function buildFrame(b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17, _b18Ignored, b19, overrideCounter) {
  const cnt = overrideCounter !== undefined ? overrideCounter : nextCounter();
  // byte[4] = BOX_ID (0 = DS suelto; 1..4 = caja del agrupador). El checksum lo
  // incluye para casar con el hardware real (aunque PitWall no lo verifique).
  const b18 = computeChecksum(cnt, 0x15, 0x03, BOX_ID, 0x04, 0x4C, b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17);
  return Buffer.from([
    0xE0, cnt, 0x15, 0x03, BOX_ID, 0x04, 0x4C,
    b7, b8, b9, b10, b11, b12, b13, b14, b15, b16, b17, b18, b19,
    0xEB
  ]);
}

// DS-300 GO sequence per protocolo (DS300-protocolo.md):
//   Trama GO:   B7=0x3E B8=0xA1  B9=BCD(centenas) B10=BCD(unidades) → duración en minutos
//   Confirm 1:  B7=0x00 B8=0xA2  (ignorada por el receptor)
//   Confirm 2:  B7=0x00 B8=0xA3  (ignorada por el receptor)
// Ejemplo del protocolo (6 min): E0 59 15 03 00 04 4C 3E A1 00 06 00 00 00 00 00 00 00 A6 00 EB
//   → checksum B18 = (0x59+0x15+0x03+0x00+0x04+0x4C+0x3E+0xA1+0x00+0x06) mod 256 = 0xA6 ✓
function goFrame1() {
  const durationMins = Math.max(1, Math.round(RACE_DURATION_MS / 60000));
  const hundreds = Math.floor(durationMins / 100);
  const units    = durationMins % 100;
  return buildFrame(0x3E, 0xA1, bcd(hundreds), bcd(units), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function goFrame2() {
  return buildFrame(0x00, 0xA2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function goFrame3() {
  return buildFrame(0x00, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// Real GO sub-frame timing (ms from trama 1)
const GO_T2_DELAY_MS = 2500;
const GO_T3_DELAY_MS = 2953;

// First crossing: byte[14]=0xAA marks invalid time; [12] holds the lap counter (=1)
function firstCrossingFrame(lane) {
  const lb = LANE_MASK[lane - 1];
  return buildFrame(0x1B, 0xA9, 0x00, lb, 0x00, 0x01, 0x00, 0xAA, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// Normal lap crossing: BCD lap time in [14..17], lap counter in [12]
function lapCrossingFrame(lane, lapTimeMs, lapNum) {
  const lb = LANE_MASK[lane - 1];
  const [m, s, c, d] = encodeLapTime(lapTimeMs);
  return buildFrame(0x1B, 0x00, 0x00, lb, 0x00, bcd(lapNum % 100), 0x00, m, s, c, d, 0x00, 0x00, 0x00);
}

// Pause: B7=0x00 (control), B8=0xA5 (per DS-300 protocol).
function pauseFrame() {
  return buildFrame(0x00, 0xA5, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// Resume: secuencia de 3 tramas (similar al GO):
//   Trama 1 (t=0):       B7=0x00 B8=0xA6   ← marca reanudación
//   Trama 2 (t≈+2500ms): B7=0x00 B8=0xA2   ← confirm 1
//   Trama 3 (t≈+2953ms): B7=0x00 B8=0xA3   ← current ON / carrera vuelve a correr
function resumeFrame1() {
  return buildFrame(0x00, 0xA6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function resumeFrame2() {
  return buildFrame(0x00, 0xA2, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}
function resumeFrame3() {
  return buildFrame(0x00, 0xA3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// Resume sub-frame timing (reusa los delays del GO por similitud de patrón)
const RESUME_T2_DELAY_MS = GO_T2_DELAY_MS;
const RESUME_T3_DELAY_MS = GO_T3_DELAY_MS;

// Normal end / finish: [7]=0x00 [8]=0xA4
function finishFrame() {
  return buildFrame(0x00, 0xA4, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// Forced stop: [7]=0x00 [8]=0xA7
function stopFrame() {
  return buildFrame(0x00, 0xA7, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
}

// ── Latido ────────────────────────────────────────────────────────────────────
// El DS-300 emite una trama de latido cada 60 s mientras la carrera CORRE, crucen
// o no coches: [7]=0x00 [8]=0xC0, con B14 = minuto transcurrido. Es la señal con
// la que PitWall distingue "la caja está viva pero callada" de "la caja se ha
// muerto". Sin emitirla, el banco no puede probar ese watchdog — y peor: una
// manga larga sin cruces lo dispararía por un fallo del emulador, no del código.
const HEARTBEAT_MS = 60000;
let heartbeatTimer = null;
let heartbeatMin   = 0;

function heartbeatFrame(minute) {
  return buildFrame(0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, minute & 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatMin = 0;
  heartbeatTimer = setInterval(() => {
    if (raceState !== STATE.RUNNING) return;   // en pausa la caja calla
    heartbeatMin += 1;
    queueFrame(heartbeatFrame(heartbeatMin));
    io.emit('log', `♥ latido (min ${heartbeatMin})`);
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── Serial port & frame queue ─────────────────────────────────────────────────

let serialPort   = null;
let frameQueue   = [];
let drainTimer   = null;

function queueFrame(buf) {
  frameQueue.push(buf);
  console.log(`[Queue] Encolado frame (byte[7]=${buf[7]?.toString(16)}, byte[8]=${buf[8]?.toString(16)}), total en cola: ${frameQueue.length}`);
  if (!drainTimer) drainQueue();
}

function drainQueue() {
  drainTimer = null;
  if (!serialPort) {
    console.log(`[Drain] Abortado: no puerto abierto`);
    return;
  }
  if (frameQueue.length === 0) {
    console.log(`[Drain] Cola vacía`);
    return;
  }
  const buf = frameQueue.shift();
  console.log(`[Drain] Escribiendo frame (byte[7]=${buf[7]?.toString(16)}, byte[8]=${buf[8]?.toString(16)}), ${frameQueue.length} restantes en cola`);
  serialPort.write(buf, err => {
    if (err) console.error('[Serial] Write error:', err.message);
  });
  drainTimer = setTimeout(drainQueue, FRAME_GAP_MS);
}

async function connectPort(portPath, baudRate = 56000) {
  if (serialPort) {
    await new Promise(r => serialPort.close(r));
    serialPort = null;
  }
  frameQueue = [];
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }

  // Try the requested baud rate; if macOS rejects it (pty + non-standard rate),
  // fall back to 57600 — for virtual ports the rate is irrelevant.
  const rates = baudRate !== 57600 ? [baudRate, 57600] : [57600];
  let lastErr;
  for (const rate of rates) {
    const p = new SerialPort({ path: portPath, baudRate: rate, autoOpen: false });
    const err = await new Promise(r => p.open(e => r(e)));
    if (!err) {
      serialPort = p;
      serialPort.on('error', e => {
        console.error('[Serial] Port error:', e.message);
        io.emit('port_error', e.message);
      });
      console.log(`[Serial] Connected to ${portPath} @ ${rate} baud`);
      return;
    }
    lastErr = err;
    console.warn(`[Serial] ${portPath} @ ${rate} failed: ${err.message}`);
  }
  throw lastErr;
}

async function listPorts() {
  const fs = require('fs');
  let real = [];
  try { real = await SerialPort.list(); } catch {}
  const out = real.map(p => ({ path: p.path }));
  // Add /dev/ttys* (socat ptys) and common USB-serial paths — SerialPort.list()
  // does not return them on macOS/Linux.
  if (process.platform !== 'win32') {
    try {
      fs.readdirSync('/dev')
        .filter(n => /^ttys\d{3,}$|^tty\.(usbserial|usbmodem|SLAB|wchusbserial)/i.test(n))
        .map(n => '/dev/' + n)
        .filter(p => !out.find(o => o.path === p))
        .forEach(path => out.push({ path }));
    } catch {}
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ── Race state ────────────────────────────────────────────────────────────────

const STATE = { IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused', FINISHED: 'finished' };

let raceState      = STATE.IDLE;
let raceStartAt    = null;   // Date.now() when GO pressed
let pauseStartAt   = null;   // Date.now() when paused
let totalPausedMs  = 0;      // accumulated pause time
let finishTimer    = null;
let tickTimer      = null;

// Per-lane state
const laneState = {};
for (let i = 1; i <= NUM_LANES; i++) {
  laneState[i] = {
    lapCount:       0,
    lastLapMs:      null,
    lastCrossingAt: null,  // Date.now() of last crossing
    remainingInLap: null,  // ms remaining when paused
    timer:          null,
    avgLapMs:       AVG_LAP_MS ?? (9000 + (i - 1) * 300 + Math.floor(Math.random() * 800)), // 9-12s per lane (o DS_AVG_MS)
  };
}

function resetLanes() {
  for (let i = 1; i <= NUM_LANES; i++) {
    if (laneState[i].timer) clearTimeout(laneState[i].timer);
    laneState[i].lapCount       = 0;
    laneState[i].lastLapMs      = null;
    laneState[i].lastCrossingAt = null;
    laneState[i].remainingInLap = null;
    laneState[i].timer          = null;
    // Re-randomize slightly each race
    laneState[i].avgLapMs = AVG_LAP_MS ?? (9000 + (i - 1) * 300 + Math.floor(Math.random() * 800));
  }
}

function elapsedMs() {
  if (!raceStartAt) return 0;
  return (Date.now() - raceStartAt) - totalPausedMs;
}

function remainingMs() {
  return Math.max(0, RACE_DURATION_MS - elapsedMs());
}

// Random lap time with ±15% variation around average.
// Anomalías aleatorias adicionales:
//   - CRASH: penalización +3..15s (salida de pista)
//   - PIT:   factor 1.8..2.2× avg  (parada en boxes / mecánica)
const CRASH_PROB    = 0.03;   // ~3% de las vueltas
const CRASH_MIN_MS  = 3000;
const CRASH_MAX_MS  = 15000;
const PIT_PROB      = 0.015;  // ~1.5% de las vueltas
const PIT_MIN_MULT  = 1.8;
const PIT_MAX_MULT  = 2.2;
const DEG_MS_PER_LAP = parseFloat(process.env.DS_DEG_MS_PER_LAP || '0');  // degradación goma (ms/vuelta)
function randomLapMs(avgMs) {
  const variation = avgMs * 0.15;
  let lap = avgMs + (Math.random() * variation * 2 - variation);
  if (Math.random() < CRASH_PROB) {
    const penalty = CRASH_MIN_MS + Math.random() * (CRASH_MAX_MS - CRASH_MIN_MS);
    lap += penalty;
    console.log(`[Crash] Salida de pista simulada: +${(penalty/1000).toFixed(1)}s`);
  } else if (Math.random() < PIT_PROB) {
    const mult = PIT_MIN_MULT + Math.random() * (PIT_MAX_MULT - PIT_MIN_MULT);
    lap = avgMs * mult;
    console.log(`[Pit] Pit-stop simulado: ×${mult.toFixed(2)} (${(lap/1000).toFixed(2)}s)`);
  }
  return Math.round(lap);
}

function emitState() {
  const lanes = {};
  for (let i = 1; i <= NUM_LANES; i++) {
    lanes[i] = { lapCount: laneState[i].lapCount, lastLapMs: laneState[i].lastLapMs };
  }
  io.emit('race_state', {
    state:       raceState,
    remainingMs: remainingMs(),
    elapsedMs:   elapsedMs(),
    lanes,
  });
}

function scheduleLap(lane, delayMs) {
  if (laneState[lane].timer) clearTimeout(laneState[lane].timer);
  laneState[lane].timer = setTimeout(() => {
    if (raceState !== STATE.RUNNING) return;
    doLapCrossing(lane);
  }, delayMs);
}

// ── Vuelta fantasma (ghost lap) — modelo físico de cruce mal atribuido ─────────
//
// Fenómeno REAL del DS-300 (calibrado contra tramas_Italia_24h.txt, 160 595
// cruces): el cross-talk entre carriles FÍSICAMENTE ADYACENTES hace que, cuando
// el coche del carril R cruza, el sensor asigne el pulso al carril vecino G.
// En la captura real esto se ve como vueltas de tiempo IMPOSIBLE (11 cruces con
// t<4s sobre 160 595, todos en el rango 1,0–3,5 s; una vuelta normal ≈ 9,8 s).
//
// La cadena de consecuencias que reproducimos (una sola causa, dos carriles):
//   • Carril G (FANTASMA): registra un cruce que no hizo → +1 vuelta con tiempo
//     CORTO = (now − último cruce real de G), self-consistente con el reloj.
//     Su coche real sigue en pista, así que su PRÓXIMO cruce real produce el
//     "complemento" (~resto hasta una vuelta). Firma: 2 vueltas cortas que suman
//     ~una normal. No reprogramamos su timer: el complemento sale solo.
//   • Carril R (REAL): su cruce fue "robado" → VUELTA PERDIDA. No emite trama ni
//     cuenta. Su siguiente cruce real reporta una vuelta ≈DOBLE (2 fusionadas),
//     porque no actualizamos su lastCrossingAt aquí.
//
// Esto es lo que PitWall debe reconciliar: una corta imposible en G ↔ una doble
// en R. El cross-talk sólo ocurre cuando un vecino cruzó HACE POCO (los dos
// coches cerca de la línea): por eso exigimos que G sea adyacente y que su hueco
// caiga en [GHOST_MIN_MS, GHOST_MAX_MS] — así el tiempo corto es realista Y
// consistente con el reloj (no un valor inventado).
const GHOST_PROB   = parseFloat(process.env.DS_GHOST_PROB || '0.03'); // prob. por oportunidad (vecino recién cruzado)
const GHOST_MIN_MS = parseInt(process.env.DS_GHOST_MIN_MS || '700', 10);  // > MIN_CROSSING_MS(500) de PitWall: debe PASAR el filtro
const GHOST_MAX_MS = parseInt(process.env.DS_GHOST_MAX_MS || '3500', 10); // techo del cruce corto observado en real

function maybeGhostLap(lane, now) {
  // NUNCA en la apertura. Tras el GO el DS emite varios "primeros cruces" (AA,
  // tiempo inválido) por carril durante el warmup, y la 1ª vuelta cronometrada
  // no llega hasta ~1 vuelta después. Un cruce corto ahí es un PRIMER CRUCE, no
  // un fantasma. Exigimos que el carril real ya tenga ≥1 vuelta cronometrada
  // (lapCount>=2: el 1er cruce deja lapCount=1) antes de poder "robarle" un cruce.
  if (laneState[lane].lapCount < 2) return false;

  // Sólo carriles FÍSICAMENTE adyacentes (cross-talk real) y en régimen estable:
  // el vecino también debe haber cronometrado ≥1 vuelta, para que su tiempo corto
  // sea inequívocamente IMPOSIBLE (y no un primer cruce de apertura).
  const qualified = [];
  for (const g of [lane - 1, lane + 1]) {
    if (g < 1 || g > NUM_LANES) continue;
    const gs = laneState[g];
    if (gs.lastCrossingAt === null || gs.lapCount < 2) continue;
    const gap = now - gs.lastCrossingAt;
    // El vecino cruzó hace poco → el tiempo fantasma será corto e imposible.
    // Techo = min(GHOST_MAX_MS, mitad de su media): así el fantasma es "media
    // vuelta o menos" Y el complemento (resto hasta su próximo cruce real) nunca
    // baja de ~500 ms, aunque la media del carril sea corta (no lo filtraría PitWall).
    const maxGap = Math.min(GHOST_MAX_MS, Math.floor(gs.avgLapMs * 0.5));
    if (gap >= GHOST_MIN_MS && gap <= maxGap) qualified.push({ g, gap });
  }
  if (qualified.length === 0) return false;          // geometría no propicia: cruce normal
  if (Math.random() >= GHOST_PROB) return false;     // hay oportunidad, pero no toca

  const { g: ghost, gap: ghostLapMs } = qualified[Math.floor(Math.random() * qualified.length)];
  const gS = laneState[ghost];

  // 1) FANTASMA en el vecino adyacente: vuelta corta, self-consistente con el reloj.
  //    NO tocamos su timer → cuando su coche real cruce, saldrá el "complemento".
  gS.lapCount++;
  gS.lastLapMs      = ghostLapMs;
  gS.lastCrossingAt = now;
  queueFrame(lapCrossingFrame(ghost, ghostLapMs, gS.lapCount));
  io.emit('lap', { lane: ghost, lapCount: gS.lapCount, lapTimeMs: ghostLapMs, ghost: true, ghostType: 'phantom' });

  // 2) Carril REAL (lane): cruce robado → VUELTA PERDIDA. No emitimos trama ni
  //    incrementamos ni actualizamos lastCrossingAt: su próximo cruce real saldrá
  //    ≈doble. Sólo avisamos al panel del emulador (no va por serie a PitWall).
  io.emit('lap', { lane, ghost: true, ghostType: 'lost' });

  console.log(`[Ghost] Cruce del carril ${lane} mal atribuido al adyacente ${ghost}: ` +
              `fantasma ${(ghostLapMs/1000).toFixed(2)}s en ${ghost} (+ complemento después) | ` +
              `vuelta PERDIDA en ${lane} (su próxima saldrá ≈doble)`);
  return true;
}

function doLapCrossing(lane) {
  const s = laneState[lane];
  const now = Date.now();

  if (s.lastCrossingAt === null) {
    // First crossing — no lap time. El DS-300 real cuenta ESTE cruce en byte12
    // (=1) igual que PitWall lo cuenta como vuelta 1; el siguiente cruce lleva
    // byte12=2. (Antes se ponía lapCount=0 y el 1er cruce real reutilizaba
    // byte12=1, desalineando el contador respecto al hardware real.)
    queueFrame(firstCrossingFrame(lane));
    s.lastCrossingAt = now;
    s.lapCount       = 1;
  } else if (maybeGhostLap(lane, now)) {
    // Cruce mal atribuido: el fantasma ya emitió su trama corta en el vecino y
    // este carril (lane) queda con la vuelta PERDIDA (no se toca su estado).
    // La reprogramación de abajo hace que su próximo cruce real salga ≈doble.
  } else {
    const lapTimeMs = now - s.lastCrossingAt;
    s.lapCount++;
    s.lastLapMs      = lapTimeMs;
    s.lastCrossingAt = now;
    queueFrame(lapCrossingFrame(lane, lapTimeMs, s.lapCount));
    io.emit('lap', { lane, lapCount: s.lapCount, lapTimeMs });
  }

  // Schedule next crossing. Degradación: la media crece DEG_MS_PER_LAP por
  // vuelta del stint (simula goma desgastándose), para validar la estrategia
  // de neumáticos. DS_DEG_MS_PER_LAP=0 (def.) → sin degradación.
  const degradedAvg = s.avgLapMs + DEG_MS_PER_LAP * s.lapCount;
  const nextLap = randomLapMs(degradedAvg);
  s.remainingInLap = nextLap;
  scheduleLap(lane, nextLap);
  emitState();
}

function startRace(durationMin) {
  if (raceState === STATE.RUNNING) return;
  if (durationMin && durationMin > 0) {
    RACE_DURATION_MS = Math.min(999, Math.max(1, Math.round(durationMin))) * 60 * 1000;
  }
  resetLanes();
  raceState     = STATE.RUNNING;
  totalPausedMs = 0;
  // El cronómetro real empieza al enviar T3 (A3 = current ON). Hasta entonces
  // raceStartAt = null para que elapsedMs() devuelva 0 durante la cuenta atrás.
  raceStartAt   = null;
  startHeartbeat();

  // Real DS-300 GO sequence: 3 frames at t=0 / +2500ms / +2953ms
  queueFrame(goFrame1());
  setTimeout(() => queueFrame(goFrame2()), GO_T2_DELAY_MS);
  setTimeout(() => {
    queueFrame(goFrame3());
    // T3 enviada: ahora arranca la carrera de verdad
    raceStartAt = Date.now();
    finishTimer = setTimeout(finishRace, RACE_DURATION_MS);
    tickTimer = setInterval(() => {
      emitState();
      if (remainingMs() <= 0) clearInterval(tickTimer);
    }, 1000);

    // Arranque REAL: en el GO todos los coches salen A LA VEZ y cruzan la línea
    // casi simultáneamente (y la 1ª vuelta también la cierran casi juntos). Por
    // eso agrupamos las primeras cruzadas en una ventana muy estrecha (~0–300ms,
    // jitter pequeño por reacción/posición de parrilla) en lugar de escalonarlas.
    // El DS las serializa a FRAME_GAP_MS (160ms): con 32 carriles eso son ~5s de
    // ráfaga de cruces al inicio — exactamente el comportamiento real.
    for (let i = 1; i <= NUM_LANES; i++) {
      scheduleLap(i, 30 + Math.round(Math.random() * 270));
    }
    emitState();
  }, GO_T3_DELAY_MS);

  console.log(`[Race] GO pressed — duración ${RACE_DURATION_MS/60000} min, T3 en ${GO_T3_DELAY_MS}ms`);
  emitState();
}

function pauseRace() {
  if (raceState !== STATE.RUNNING) return;
  raceState    = STATE.PAUSED;
  pauseStartAt = Date.now();

  // Cancel all lane timers and save remaining time
  for (let i = 1; i <= NUM_LANES; i++) {
    const s = laneState[i];
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
      // Estimate remaining time in current lap based on when it was scheduled
      // (remainingInLap was set at last crossing; subtract elapsed since then)
      const elapsed = s.lastCrossingAt ? Date.now() - s.lastCrossingAt : 0;
      s.remainingInLap = Math.max(500, (s.remainingInLap ?? s.avgLapMs) - elapsed);
    }
  }

  // Pause the finish timer
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  if (tickTimer)   { clearInterval(tickTimer);  tickTimer   = null; }

  queueFrame(pauseFrame());
  console.log('[Race] Paused');
  emitState();
}

function resumeRace() {
  if (raceState !== STATE.PAUSED) return;

  // Secuencia real DS-300: A6 → A2 → A3 (mismos delays que GO).
  // Hasta que se envía T3 (A3) la carrera sigue lógicamente PAUSED:
  // los lap timers y el finishTimer no se rearman hasta entonces.
  queueFrame(resumeFrame1());
  console.log('[Race] Resume sequence — T1 (0xA6)');
  emitState();

  setTimeout(() => {
    if (raceState !== STATE.PAUSED) return;
    queueFrame(resumeFrame2());
    console.log('[Race] Resume sequence — T2 (0xA2)');
  }, RESUME_T2_DELAY_MS);

  setTimeout(() => {
    if (raceState !== STATE.PAUSED) return;
    queueFrame(resumeFrame3());
    console.log('[Race] Resume sequence — T3 (0xA3) — running');

    // Ahora sí: carrera corriendo otra vez
    const pausedDuration = Date.now() - pauseStartAt;
    totalPausedMs += pausedDuration;
    raceState = STATE.RUNNING;

    // Ajusta lastCrossingAt por toda la pausa (incluyendo los ~3s de secuencia)
    for (let i = 1; i <= NUM_LANES; i++) {
      const s = laneState[i];
      if (s.lastCrossingAt) s.lastCrossingAt += pausedDuration;
      if (s.remainingInLap != null) scheduleLap(i, s.remainingInLap);
    }

    finishTimer = setTimeout(finishRace, remainingMs());
    tickTimer   = setInterval(() => {
      emitState();
      if (remainingMs() <= 0) clearInterval(tickTimer);
    }, 1000);

    emitState();
  }, RESUME_T3_DELAY_MS);
}

function finishRace() {
  if (raceState === STATE.FINISHED || raceState === STATE.IDLE) return;
  raceState = STATE.FINISHED;
  stopHeartbeat();

  for (let i = 1; i <= NUM_LANES; i++) {
    if (laneState[i].timer) { clearTimeout(laneState[i].timer); laneState[i].timer = null; }
  }
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  if (tickTimer)   { clearInterval(tickTimer);  tickTimer   = null; }

  queueFrame(finishFrame());

  // TEST-ONLY (DS_FLAG_LANES): coches que cruzan JUSTO en la bandera. El DS
  // cuenta la vuelta (byte12++) pero manda el frame del cruce DESPUÉS del A4 de
  // fin (llega ~160ms después por la cola). Reproduce el bug del "cruce en la
  // bandera" que el receptor descartaba por circuito ya 'finished'.
  // Formato: DS_FLAG_LANES="1,3,5" (vacío/ausente = desactivado).
  const flagLanes = (process.env.DS_FLAG_LANES || '')
    .split(',').map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= 1 && n <= NUM_LANES);
  for (const lane of flagLanes) {
    const s = laneState[lane];
    if (!s || s.lastCrossingAt === null) continue;   // sin vueltas previas: nada que cerrar
    const lapMs = Math.max(1000, Date.now() - s.lastCrossingAt);
    s.lapCount++;
    s.lastLapMs      = lapMs;
    s.lastCrossingAt = Date.now();
    queueFrame(lapCrossingFrame(lane, lapMs, s.lapCount));
    console.log(`[Race] Flag crossing (post-A4) carril ${lane} → lap ${s.lapCount} (${(lapMs/1000).toFixed(2)}s, byte12=${s.lapCount})`);
  }

  console.log('[Race] Finished');
  emitState();
}

function stopRace() {
  if (raceState === STATE.IDLE) return;
  raceState = STATE.IDLE;
  stopHeartbeat();

  for (let i = 1; i <= NUM_LANES; i++) {
    if (laneState[i].timer) { clearTimeout(laneState[i].timer); laneState[i].timer = null; }
  }
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  if (tickTimer)   { clearInterval(tickTimer);  tickTimer   = null; }

  // Reset reloj de carrera: si no se ponen a null, elapsedMs() sigue creciendo
  // contra el raceStartAt viejo y la UI muestra una cuenta atrás "fantasma".
  raceStartAt   = null;
  pauseStartAt  = null;
  totalPausedMs = 0;

  queueFrame(stopFrame());
  resetLanes();
  console.log('[Race] Stopped');
  emitState();
}

// ── Modo REPLAY (máxima fidelidad) ────────────────────────────────────────────
// Reproduce un registro REAL (RegistroCarrera.txt: "HH:MM:SS.mmm  B0..B20")
// trama a trama con su TIMING REAL. Es la forma más fiel de emular el DS-300:
// envía exactamente lo que mandó el aparato, con sus tiempos. Escribe directo
// al puerto (sin la cola de FRAME_GAP_MS: el espaciado real ya está en los
// deltas del registro). `speed` acelera/ralentiza; `maxGapMs` recorta esperas
// largas (idle) para no aguardar minutos entre cruces.
const fsRP = require('fs');
const DEFAULT_REPLAY_FILE = process.env.DS_REPLAY_FILE
  || '/Users/victor/SloTime/info para proyecto infolap slot/registro carrera 2/RegistroCarrera.txt';
let replayTimer  = null;
let replayActive = false;

function parseCaptureFile(filePath) {
  const text = fsRP.readFileSync(filePath, 'utf8');
  const frames = [];
  let prevMs = null;
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/);
    const m = parts[0] && parts[0].match(/^(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})$/);
    if (!m) continue;
    const ms  = ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000) + +m[4];
    const hex = parts.slice(1).filter(h => /^[0-9a-fA-F]{2}$/.test(h));
    if (hex.length < 2) continue;
    let delta = (prevMs == null) ? 0 : ms - prevMs;
    if (delta < 0) delta = FRAME_GAP_MS;   // rollover de medianoche / línea corrupta
    prevMs = ms;
    frames.push({ delta, buf: Buffer.from(hex.map(h => parseInt(h, 16))) });
  }
  return frames;
}

function stopReplay() {
  if (replayTimer) { clearTimeout(replayTimer); replayTimer = null; }
  replayActive = false;
}

function startReplay(filePath, speed = 1, maxGapMs = null) {
  stopRace();                 // corta la simulación generativa
  stopReplay();
  frameQueue = [];
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  if (!serialPort) { io.emit('log', '✗ Replay: no hay puerto conectado'); return { ok: false, error: 'no_port' }; }

  let frames;
  try { frames = parseCaptureFile(filePath); }
  catch (e) { io.emit('log', `✗ Replay: ${e.message}`); return { ok: false, error: e.message }; }
  if (!frames.length) { io.emit('log', '✗ Replay: registro vacío o ilegible'); return { ok: false, error: 'empty' }; }

  speed = Math.max(0.1, Math.min(50, Number(speed) || 1));
  replayActive = true;
  io.emit('log', `▶ Replay: ${frames.length} tramas (${filePath.split('/').pop()}) @ ${speed}x`);
  console.log(`[Replay] ${frames.length} frames @ ${speed}x — ${filePath}`);

  let i = 0;
  (function step() {
    if (!replayActive || !serialPort) { stopReplay(); return; }
    if (i >= frames.length) { io.emit('log', '✓ Replay terminado'); console.log('[Replay] done'); stopReplay(); return; }
    serialPort.write(frames[i++].buf, err => { if (err) console.error('[Replay] write error:', err.message); });
    let wait = frames[i] ? frames[i].delta : 0;
    if (maxGapMs != null) wait = Math.min(wait, maxGapMs);
    replayTimer = setTimeout(step, Math.max(0, Math.round(wait / speed)));
  })();
  return { ok: true, frames: frames.length, speed };
}

// ── Modo STRESS (TEST, NO realista) ───────────────────────────────────────────
// El DS real NUNCA manda tramas a <160ms (medido). Esto NO emula al DS: escribe
// N tramas de cruce en UNA sola escritura (pegadas, sin hueco) para simular lo
// que ve el receptor cuando su event loop se bloquea y el SO le entrega varias
// tramas juntas. Sirve para verificar que el de-merge de SloTime las separa.
function burstTest(count = 6) {
  if (!serialPort) { io.emit('log', '✗ Stress: no hay puerto'); return { ok: false, error: 'no_port' }; }
  count = Math.max(2, Math.min(12, count | 0));
  const bufs = [];
  for (let lane = 1; lane <= count; lane++) {
    const s = laneState[((lane - 1) % NUM_LANES) + 1];
    bufs.push(lapCrossingFrame(((lane - 1) % NUM_LANES) + 1, 9000 + lane * 100, (s.lapCount || 0) + 1));
  }
  serialPort.write(Buffer.concat(bufs), err => { if (err) console.error('[Stress] write error:', err.message); });
  io.emit('log', `⚠ Stress: ${count} tramas escritas PEGADAS (test de-merge, no realista)`);
  console.log(`[Stress] ${count} frames back-to-back (${count * 21} bytes en una escritura)`);
  return { ok: true, count };
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', async (socket) => {
  console.log('[WS] Client connected');

  const ports = await listPorts();
  socket.emit('ports', ports.map(p => p.path));
  socket.emit('race_state', {
    state:       raceState,
    remainingMs: remainingMs(),
    elapsedMs:   elapsedMs(),
    lanes:       Object.fromEntries(
      Array.from({ length: NUM_LANES }, (_, i) => [i + 1, {
        lapCount: laneState[i + 1].lapCount,
        lastLapMs: laneState[i + 1].lastLapMs,
      }])
    ),
    connected: !!serialPort,
  });

  socket.on('connect_port', async ({ port, baud }) => {
    try {
      await connectPort(port, baud || 56000);
      socket.emit('connected', { port });
      io.emit('log', `✓ Conectado a ${port} @ ${baud || 56000} baud`);
    } catch (err) {
      socket.emit('port_error', err.message);
      io.emit('log', `✗ Error: ${err.message}`);
    }
  });

  socket.on('disconnect_port', async () => {
    if (serialPort) {
      await new Promise(r => serialPort.close(r)).catch(() => {});
      serialPort = null;
      io.emit('disconnected');
      io.emit('log', 'Puerto desconectado');
    }
  });

  socket.on('list_ports', async () => {
    const ports = await listPorts();
    socket.emit('ports', ports.map(p => p.path));
  });

  socket.on('go',     (payload) => {
    const mins = payload && payload.durationMin;
    startRace(mins);
    io.emit('log', `▶ GO — carrera iniciada (${RACE_DURATION_MS/60000} min)`);
  });
  socket.on('pause',  () => { pauseRace();  io.emit('log', '⏸ Carrera pausada'); });
  socket.on('resume', () => { resumeRace(); io.emit('log', '▶ Carrera reanudada'); });
  socket.on('stop',   () => { stopRace();   io.emit('log', '⏹ Carrera detenida'); });

  socket.on('set_avg_lap', ({ lane, ms }) => {
    if (lane >= 1 && lane <= NUM_LANES) {
      laneState[lane].avgLapMs = Math.max(3000, Math.min(60000, ms));
      io.emit('log', `Carril ${lane}: media ajustada a ${(ms/1000).toFixed(1)}s`);
    }
  });
});

// REST endpoints for automated testing / CLI control
app.post('/api/connect', express.json(), async (req, res) => {
  try {
    const port = (req.body && req.body.port) || '/dev/ttys002';
    const baud = (req.body && req.body.baud) || 56000;
    await connectPort(port, baud);
    io.emit('connected', { port });
    io.emit('log', `✓ Conectado a ${port} @ ${baud} baud`);
    res.json({ ok: true, port });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/api/go',   express.json(), (req, res) => {
  const mins = req.body && req.body.durationMin;
  startRace(mins);
  io.emit('log', `▶ GO — carrera iniciada (${RACE_DURATION_MS / 60000} min)`);
  res.json({ ok: true, durationMin: RACE_DURATION_MS / 60000, state: raceState });
});
app.post('/api/pause',  (req, res) => { pauseRace();  io.emit('log', '⏸ Carrera pausada');   res.json({ ok: true, state: raceState }); });
app.post('/api/resume', (req, res) => { resumeRace(); io.emit('log', '▶ Carrera reanudada'); res.json({ ok: true, state: raceState }); });
app.post('/api/stop', (req, res) => { stopReplay(); stopRace(); io.emit('log', '⏹ Carrera detenida'); res.json({ ok: true, state: raceState }); });

// Estado actual del DS — lo consume el Director de carrera para pintar cada unidad.
app.get('/api/status', (req, res) => {
  res.json({
    ok:          true,
    connected:   !!serialPort,
    port:        serialPort ? serialPort.path : null,
    state:       raceState,
    remainingMs: remainingMs(),
    elapsedMs:   elapsedMs(),
    durationMin: RACE_DURATION_MS / 60000,
    lanes:       NUM_LANES,
    avgLapMs:    Array.from({ length: NUM_LANES }, (_, i) => laneState[i + 1].avgLapMs),
  });
});

// Replay de un registro real con timing real. body: { file?, speed?, maxGapMs? }
app.post('/api/replay', express.json(), (req, res) => {
  const file     = (req.body && req.body.file)     || DEFAULT_REPLAY_FILE;
  const speed    = (req.body && req.body.speed)    || 1;
  const maxGapMs = (req.body && req.body.maxGapMs != null) ? req.body.maxGapMs : null;
  const r = startReplay(file, speed, maxGapMs);
  res.status(r.ok ? 200 : 400).json(r);
});

// Test de-merge (NO realista): escribe N tramas pegadas. body: { count? }
app.post('/api/burst', express.json(), (req, res) => {
  const r = burstTest((req.body && req.body.count) || 6);
  res.status(r.ok ? 200 : 400).json(r);
});

server.listen(PORT, () => {
  console.log(`DS-300 Emulator → http://localhost:${PORT}`);
  console.log('');
  console.log('Para crear un par de puertos virtuales en macOS:');
  console.log('  socat -d -d pty,raw,echo=0 pty,raw,echo=0');
  console.log('Luego conecta el emulador a /dev/ttys00X y SloTime a /dev/ttys00Y');
});
