/*
 * Mezclador de agrupador DS-300 (banco virtual).
 *
 * Un aparato "agrupador" junta varias cajas DS-300 en UN solo puerto COM. socat
 * es punto a punto (no mezcla 4→1), así que este proceso hace de agrupador:
 * lee las tramas de N emuladores (cada uno con su DS_BOX_ID → byte[4] propio) y
 * las reenvía tal cual a un único puerto de salida, que es el que abre PitWall
 * en modo "DS-300 agrupador".
 *
 *   [emu box1 DS_BOX_ID=1] → SRC1 ┐
 *   [emu box2 DS_BOX_ID=2] → SRC2 ┼→ (este merger) → DEST → [PitWall agrupador]
 *   [emu box3 DS_BOX_ID=3] → SRC3 ┤
 *   [emu box4 DS_BOX_ID=4] → SRC4 ┘
 *
 * Uso:
 *   SOURCES=/tmp/box1-app,/tmp/box2-app,/tmp/box3-app,/tmp/box4-app \
 *   DEST=/tmp/agg-emu \
 *   node aggregator-merge.js
 *
 * PitWall abre el OTRO extremo del par de DEST (p.ej. /tmp/agg-app).
 *
 * Nota: no reescribe nada (ni el byte[4] ni el checksum). Cada emulador ya
 * estampa su caja. Solo concatena bytes; las tramas van delimitadas por el
 * silencio entre ellas y por su longitud fija (21 B), y el de-merge de PitWall
 * separa las ráfagas si dos cajas cruzan a la vez.
 */
const { SerialPort } = require('serialport');

const SOURCES = (process.env.SOURCES || '').split(',').map(s => s.trim()).filter(Boolean);
const DEST    = process.env.DEST || '';
const BAUD    = parseInt(process.env.BAUD || '57600', 10);

if (!SOURCES.length || !DEST) {
  console.error('Faltan SOURCES o DEST.\n' +
    '  SOURCES=/tmp/box1-app,/tmp/box2-app,... DEST=/tmp/agg-emu node aggregator-merge.js');
  process.exit(1);
}

function open(path, { readonly } = {}) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: BAUD, autoOpen: false, lock: false }, () => {});
    p.open(err => err ? reject(err) : resolve(p));
  });
}

(async () => {
  const dest = await open(DEST);
  console.log(`[merge] salida (agrupador) → ${DEST} @ ${BAUD}`);

  let total = 0;
  for (let i = 0; i < SOURCES.length; i++) {
    const src = await open(SOURCES[i]);
    const box = i + 1;
    src.on('data', chunk => {
      total += chunk.length;
      dest.write(chunk, err => { if (err) console.error(`[merge] write err:`, err.message); });
    });
    src.on('error', e => console.error(`[merge] SRC${box} (${SOURCES[i]}) error:`, e.message));
    console.log(`[merge] caja ${box} ← ${SOURCES[i]}`);
  }

  setInterval(() => { if (total) { console.log(`[merge] ${total} bytes reenviados`); total = 0; } }, 5000);
  console.log('[merge] mezclando… (Ctrl-C para salir)');
})().catch(e => { console.error('[merge] fallo al abrir puertos:', e.message); process.exit(1); });
