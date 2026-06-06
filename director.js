'use strict';

// ── Director de carrera multi-DS ───────────────────────────────────────────────
// Panel maestro para carreras de 2-4 circuitos. Cada circuito es un emulador
// DS-300 independiente (proceso + puerto serie propio, igual que 4 DS reales),
// arrancados por start-emulators.sh en los puertos HTTP 3100, 3101, 3102, 3103.
//
// Este servidor NO emula nada: solo descubre los emuladores vivos y reenvía
// GO / pausa / resume / stop a los que marques, EN PARALELO (fan-out server-side,
// sin CORS). Así un solo clic dispara el GO en los 4 DS casi a la vez — sin
// necesitar 4 manos.
//
// Variables de entorno:
//   DS_DIRECTOR_PORT  (default 3099)        puerto HTTP del director
//   DS_DIRECTOR_SCAN  (default "3100-3103") rango/lista de puertos a escanear

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = parseInt(process.env.DS_DIRECTOR_PORT || '3099', 10);

// Parsea "3100-3103" o "3100,3101,3105" → [3100,3101,...]
function parseScan(spec) {
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.push(p);
    } else if (/^\d+$/.test(part.trim())) {
      out.push(+part.trim());
    }
  }
  return [...new Set(out)];
}

const SCAN_PORTS = parseScan(process.env.DS_DIRECTOR_SCAN || '3100-3103');

app.use(express.json());
// La raíz sirve el DIRECTOR (no el index.html del emulador). Va ANTES del static
// y el static con index:false para que no intercepte "/" con index.html.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'director.html')));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// fetch con timeout corto: un puerto sin emulador debe descartarse rápido.
async function fetchTimeout(url, opts = {}, ms = 1200) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Sondea un emulador concreto. Devuelve siempre un objeto (online:false si cae).
async function probe(httpPort, idx) {
  const url = `http://localhost:${httpPort}`;
  try {
    const r = await fetchTimeout(`${url}/api/status`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const s = await r.json();
    return {
      idx, httpPort, url,
      online:      true,
      connected:   !!s.connected,
      serialPath:  s.port || null,
      state:       s.state || 'idle',
      remainingMs: s.remainingMs || 0,
      durationMin: s.durationMin || null,
      lanes:       s.lanes || null,
    };
  } catch (e) {
    return { idx, httpPort, url, online: false, connected: false, serialPath: null,
             state: 'offline', remainingMs: 0, durationMin: null, lanes: null };
  }
}

// Lista de unidades (sondeo en paralelo de todos los puertos del scan).
app.get('/api/units', async (req, res) => {
  const ports = req.query.scan ? parseScan(req.query.scan) : SCAN_PORTS;
  const units = await Promise.all(ports.map((p, i) => probe(p, i + 1)));
  res.json({ ok: true, units });
});

const ACTION_TO_PATH = {
  go:     '/api/go',
  pause:  '/api/pause',
  resume: '/api/resume',
  stop:   '/api/stop',
};

// Fan-out de una acción a los puertos indicados, EN PARALELO.
app.post('/api/control', async (req, res) => {
  const { action, ports, durationMin } = req.body || {};
  const apiPath = ACTION_TO_PATH[action];
  if (!apiPath) return res.status(400).json({ ok: false, error: 'acción inválida' });
  if (!Array.isArray(ports) || ports.length === 0) {
    return res.status(400).json({ ok: false, error: 'sin puertos seleccionados' });
  }

  const body = action === 'go' && durationMin ? JSON.stringify({ durationMin }) : undefined;

  const results = await Promise.all(ports.map(async (httpPort) => {
    try {
      const r = await fetchTimeout(`http://localhost:${httpPort}${apiPath}`, {
        method:  'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body,
      });
      const data = await r.json().catch(() => ({}));
      return { httpPort, ok: r.ok, state: data.state };
    } catch (e) {
      return { httpPort, ok: false, error: e.message };
    }
  }));

  const okCount = results.filter(r => r.ok).length;
  console.log(`[Director] ${action.toUpperCase()} → ${okCount}/${ports.length} OK ` +
              `(puertos: ${ports.join(', ')})`);
  res.json({ ok: okCount > 0, action, results });
});

app.listen(PORT, () => {
  console.log(`DS-300 Director de carrera → http://localhost:${PORT}`);
  console.log(`Escaneando emuladores en puertos: ${SCAN_PORTS.join(', ')}`);
});
