'use strict';

// ── Emulador del "DS 4-port" (agrupador de puertos) ────────────────────────────
// Reproduce el aparato físico que une de 1 a 4 DS-300 (cada uno en su COM) y
// vuelca TODO por un único COM hacia el PC con el software (PitWall/SloTime).
//
// PASARELA PURA: NO simula carreras. Abre hasta 4 puertos serie de ENTRADA
// (donde enchufas los DS-300 reales, o los pares socat de instancias de
// emulator.js) y un puerto serie de SALIDA. Cada trama que llega por una entrada
// se REETIQUETA y se reenvía por la salida.
//
//   DS real/emu 1 ─COM─┐
//   DS real/emu 2 ─COM─┤
//   DS real/emu 3 ─COM─┼─[ DS4PORT ]─COM─→ PitWall
//   DS real/emu 4 ─COM─┘   reetiqueta
//
// ── Qué reescribe el agrupador (verificado byte a byte contra tramas_15_julio) ──
// Cabecera de un DS-300 suelto: E0 CC 15 03 00 04 4C … (byte[4]=00, contador propio).
// En el stream fusionado:
//   • byte[1]  = CONTADOR GLOBAL único (F6,F7,F8… +1 por trama, sea del puerto que
//                sea). El agrupador descarta el contador propio de cada DS.
//   • byte[4]  = nº de circuito/puerto de origen (01..04). Antes valía 00.
//   • byte[18] = checksum = (B1+…+B17) mod 256, RECALCULADO tras estampar 1 y 4.
//   • byte[19], byte[20] se pasan tal cual (normalmente 00 y 0xEB).
// El resto de la trama (tipo, subtipo, tiempos BCD, máscara de carril) intacto.

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ds4port.html')));

const HTTP_PORT = parseInt(process.env.DS4_HTTP_PORT || '3200', 10);
const NUM_SLOTS = 4;                 // el aparato admite hasta 4 DS-300
const BAUD_IN   = parseInt(process.env.DS4_BAUD_IN  || '56000', 10);
const BAUD_OUT  = parseInt(process.env.DS4_BAUD_OUT || '56000', 10);

const FRAME_LEN = 21;                // trama DS-300 fija: 21 bytes E0…EB
const SYNC = 0xE0, END = 0xEB;

// ── Estado del agrupador ────────────────────────────────────────────────────────

let globalCounter = 0x00;            // byte[1] común a TODAS las salidas
let totalForwarded = 0;

const output = { path: null, port: null, baud: BAUD_OUT };

// slots[0..3] → circuitId 1..4 por defecto (byte[4]). Editable por slot.
const slots = Array.from({ length: NUM_SLOTS }, (_, i) => ({
  idx:        i + 1,
  circuitId:  i + 1,          // valor que se estampa en byte[4]
  path:       null,
  port:       null,
  baud:       BAUD_IN,
  buf:        Buffer.alloc(0), // acumulador para el framer
  frameCount: 0,
  dropped:    0,               // bytes descartados por resync
  lastHex:    null,
  lastType:   null,
}));

// ── Framer: extrae tramas de 21 bytes (E0…EB) de un stream por trozos ───────────
const MAX_BUF = 4096;   // si crece sin una trama válida, es basura → recortar

function ingest(slot, chunk) {
  slot.buf = slot.buf.length ? Buffer.concat([slot.buf, chunk]) : chunk;

  while (slot.buf.length >= FRAME_LEN) {
    if (slot.buf[0] === SYNC && slot.buf[FRAME_LEN - 1] === END) {
      const frame = slot.buf.subarray(0, FRAME_LEN);
      forward(slot, frame);
      slot.buf = slot.buf.subarray(FRAME_LEN);
    } else {
      // Desalineado o basura: descarta 1 byte y reintenta el enganche.
      slot.buf = slot.buf.subarray(1);
      slot.dropped++;
    }
  }
  // Salvaguarda: buffer enorme sin trama válida → nos quedamos con la cola.
  if (slot.buf.length > MAX_BUF) {
    slot.dropped += slot.buf.length - FRAME_LEN;
    slot.buf = slot.buf.subarray(slot.buf.length - FRAME_LEN);
  }
}

// ── Reetiqueta y reenvía por la salida ──────────────────────────────────────────
function forward(slot, frame) {
  const out = Buffer.from(frame);          // copia (no mutar el buffer de entrada)

  out[1] = globalCounter;                  // contador GLOBAL
  globalCounter = (globalCounter + 1) & 0xFF;
  out[4] = slot.circuitId & 0xFF;          // nº de circuito de origen

  let sum = 0;                             // checksum B18 = (B1..B17) mod 256
  for (let i = 1; i <= 17; i++) sum += out[i];
  out[18] = sum & 0xFF;
  // out[19] y out[20] se conservan de la trama original.

  slot.frameCount++;
  slot.lastHex  = hex(out);
  slot.lastType = describeFrame(out);
  totalForwarded++;

  if (output.port && output.port.isOpen) {
    output.port.write(out, err => {
      if (err) { console.error('[Out] write error:', err.message); io.emit('log', `✗ Salida: ${err.message}`, 'error'); }
    });
  } else {
    // Sin salida abierta: la trama se pierde (como el aparato sin cable al PC).
    io.emit('log', `⚠ Trama de circuito ${slot.circuitId} descartada: salida sin conectar`, 'warn');
  }

  io.emit('frame', {
    slot:       slot.idx,
    circuitId:  slot.circuitId,
    outCounter: out[1],
    type:       slot.lastType,
    hexIn:      hex(frame),
    hexOut:     slot.lastHex,
  });
}

function hex(buf) {
  return Array.from(buf, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// Describe una trama por su tipo (byte7/byte8) para el log/UI.
function describeFrame(f) {
  const b7 = f[7], b8 = f[8];
  if (b7 === 0x3E && b8 === 0xA1) return 'GO';
  if (b7 === 0x1B && b8 === 0xA9) return 'primer cruce';
  if (b7 === 0x1B && b8 === 0x00) return 'cruce';
  if (b7 === 0x00) {
    switch (b8) {
      case 0xA2: return 'conf A2';
      case 0xA3: return 'A3 (run)';
      case 0xA4: return 'fin';
      case 0xA5: return 'pausa';
      case 0xA6: return 'reanudar';
      case 0xA7: return 'stop';
      case 0xC0: return 'latido';
    }
  }
  return `B7=${b7.toString(16)} B8=${b8.toString(16)}`;
}

// ── Puertos serie ───────────────────────────────────────────────────────────────

// Abre un SerialPort probando el baud pedido y, si falla, 57600 (los PTY socat
// ignoran el baud; para puertos virtuales da igual el valor).
async function openSerial(portPath, baud) {
  const rates = baud !== 57600 ? [baud, 57600] : [57600];
  let lastErr;
  for (const rate of rates) {
    const p = new SerialPort({ path: portPath, baudRate: rate, autoOpen: false });
    const err = await new Promise(r => p.open(e => r(e)));
    if (!err) { console.log(`[Serial] ${portPath} @ ${rate} baud OK`); return p; }
    lastErr = err;
    console.warn(`[Serial] ${portPath} @ ${rate} falló: ${err.message}`);
  }
  throw lastErr;
}

async function connectOutput(portPath, baud = BAUD_OUT) {
  await disconnectOutput();
  const p = await openSerial(portPath, baud);
  p.on('error', e => { console.error('[Out] port error:', e.message); io.emit('log', `✗ Salida: ${e.message}`, 'error'); });
  output.port = p; output.path = portPath; output.baud = baud;
  io.emit('log', `✓ Salida conectada a ${portPath}`, 'info');
  pushStatus();
}

async function disconnectOutput() {
  if (output.port) {
    await new Promise(r => output.port.close(r)).catch(() => {});
    output.port = null; output.path = null;
  }
}

async function connectInput(slot, portPath, baud = BAUD_IN) {
  await disconnectInput(slot);
  const p = await openSerial(portPath, baud);
  p.on('data', chunk => ingest(slot, chunk));
  p.on('error', e => { console.error(`[In${slot.idx}] port error:`, e.message); io.emit('log', `✗ Entrada ${slot.idx}: ${e.message}`, 'error'); });
  slot.port = p; slot.path = portPath; slot.baud = baud; slot.buf = Buffer.alloc(0);
  io.emit('log', `✓ Entrada ${slot.idx} (circuito ${slot.circuitId}) conectada a ${portPath}`, 'info');
  pushStatus();
}

async function disconnectInput(slot) {
  if (slot.port) {
    await new Promise(r => slot.port.close(r)).catch(() => {});
    slot.port = null; slot.path = null; slot.buf = Buffer.alloc(0);
  }
}

async function listPorts() {
  let real = [];
  try { real = await SerialPort.list(); } catch {}
  const out = real.map(p => ({ path: p.path }));
  if (process.platform !== 'win32') {
    try {
      fs.readdirSync('/dev')
        .filter(n => /^ttys\d{3,}$|^tty\.(usbserial|usbmodem|SLAB|wchusbserial)/i.test(n))
        .map(n => '/dev/' + n)
        .filter(p => !out.find(o => o.path === p))
        .forEach(pth => out.push({ path: pth }));
    } catch {}
  }
  // Enlaces socat conocidos (/tmp/ds300-*, /tmp/ds4-*).
  try {
    fs.readdirSync('/tmp')
      .filter(n => /^ds300-|^ds4-/.test(n))
      .map(n => '/tmp/' + n)
      .filter(p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } })
      .filter(p => !out.find(o => o.path === p))
      .forEach(pth => out.push({ path: pth }));
  } catch {}
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function statusSnapshot() {
  return {
    ok: true,
    output: {
      connected: !!(output.port && output.port.isOpen),
      path:      output.path,
      baud:      output.baud,
    },
    globalCounter,
    totalForwarded,
    slots: slots.map(s => ({
      idx:        s.idx,
      circuitId:  s.circuitId,
      connected:  !!(s.port && s.port.isOpen),
      path:       s.path,
      baud:       s.baud,
      frameCount: s.frameCount,
      dropped:    s.dropped,
      lastHex:    s.lastHex,
      lastType:   s.lastType,
    })),
  };
}

function pushStatus() { io.emit('status', statusSnapshot()); }

// ── Socket.io ───────────────────────────────────────────────────────────────────

io.on('connection', async (socket) => {
  socket.emit('ports', (await listPorts()).map(p => p.path));
  socket.emit('status', statusSnapshot());

  socket.on('list_ports', async () => socket.emit('ports', (await listPorts()).map(p => p.path)));

  socket.on('connect_output', async ({ path: p, baud }) => {
    try { await connectOutput(p, baud || BAUD_OUT); }
    catch (e) { io.emit('log', `✗ Salida: ${e.message}`, 'error'); }
  });
  socket.on('disconnect_output', async () => { await disconnectOutput(); io.emit('log', 'Salida desconectada'); pushStatus(); });

  socket.on('connect_input', async ({ slot, path: p, baud }) => {
    const s = slots[(slot | 0) - 1];
    if (!s) return;
    try { await connectInput(s, p, baud || BAUD_IN); }
    catch (e) { io.emit('log', `✗ Entrada ${slot}: ${e.message}`, 'error'); }
  });
  socket.on('disconnect_input', async ({ slot }) => {
    const s = slots[(slot | 0) - 1];
    if (!s) return;
    await disconnectInput(s); io.emit('log', `Entrada ${slot} desconectada`); pushStatus();
  });

  socket.on('set_circuit', ({ slot, circuitId }) => {
    const s = slots[(slot | 0) - 1];
    if (!s) return;
    s.circuitId = Math.max(0, Math.min(255, circuitId | 0));
    io.emit('log', `Entrada ${slot}: byte[4] (circuito) = ${s.circuitId}`, 'info');
    pushStatus();
  });

  socket.on('reset_counter', () => {
    globalCounter = 0x00; totalForwarded = 0;
    slots.forEach(s => { s.frameCount = 0; s.dropped = 0; s.lastHex = null; s.lastType = null; });
    io.emit('log', 'Contador global y estadísticas reiniciados', 'info');
    pushStatus();
  });
});

// ── REST (control automatizado / CLI) ───────────────────────────────────────────

app.get('/api/status', (req, res) => res.json(statusSnapshot()));
app.get('/api/ports',  async (req, res) => res.json({ ok: true, ports: (await listPorts()).map(p => p.path) }));

app.post('/api/output', express.json(), async (req, res) => {
  try { await connectOutput(req.body.path, req.body.baud || BAUD_OUT); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/input', express.json(), async (req, res) => {
  const s = slots[(req.body.slot | 0) - 1];
  if (!s) return res.status(400).json({ ok: false, error: 'slot inválido (1-4)' });
  if (req.body.circuitId != null) s.circuitId = Math.max(0, Math.min(255, req.body.circuitId | 0));
  try { await connectInput(s, req.body.path, req.body.baud || BAUD_IN); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Auto-conexión por variables de entorno ──────────────────────────────────────
async function autoConnect() {
  if (process.env.DS4_OUT) {
    try { await connectOutput(process.env.DS4_OUT, BAUD_OUT); }
    catch (e) { console.warn('[Auto] salida:', e.message); }
  }
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const p = process.env[`DS4_IN${i}`];
    if (!p) continue;
    try { await connectInput(slots[i - 1], p, BAUD_IN); }
    catch (e) { console.warn(`[Auto] entrada ${i}:`, e.message); }
  }
}

server.listen(HTTP_PORT, () => {
  console.log(`DS 4-port (agrupador) → http://localhost:${HTTP_PORT}`);
  console.log('');
  console.log('Cablea así (ejemplo con socat, 5 pares de PTY):');
  console.log('  # 4 entradas: cada DS-300/emulator.js escribe en su lado -emuN,');
  console.log('  #             y el agrupador lee del lado -appN.');
  console.log('  socat -d -d pty,raw,echo=0,link=/tmp/ds300-emu1 pty,raw,echo=0,link=/tmp/ds300-app1');
  console.log('  #             …idem emu2/app2, emu3/app3, emu4/app4');
  console.log('  # 1 salida:  el agrupador escribe en -out, PitWall lee de -app.');
  console.log('  socat -d -d pty,raw,echo=0,link=/tmp/ds4-out    pty,raw,echo=0,link=/tmp/ds4-app');
  console.log('');
  console.log('  Entradas del agrupador → /tmp/ds300-app1..4   Salida → /tmp/ds4-out');
  console.log('  PitWall → /tmp/ds4-app');
  autoConnect();
});
