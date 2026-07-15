const fs = require('fs');
const { SerialPort } = require('serialport');

const PATH = '/dev/cu.PL2303G-USBtoUART1440';
const RATE = Number(process.argv[2]) || 56000;
const LOG = process.argv[3] || '/private/tmp/claude-501/-Users-victor-pitwall-lap/0dfa593d-a9c4-4351-b83c-c1e8e58c63e0/scratchpad/ds_serial.log';

const out = fs.createWriteStream(LOG, { flags: 'a' });
function stamp() { return new Date().toISOString(); }
function line(s) { const t = `${stamp()} ${s}`; console.log(t); out.write(t + '\n'); }

line(`=== abriendo ${PATH} @ ${RATE} baud ===`);
const port = new SerialPort({ path: PATH, baudRate: RATE, autoOpen: false });

let total = 0;
port.open(err => {
  if (err) { line(`OPEN ERROR: ${err.message}`); process.exit(1); }
  line(`abierto OK, escuchando...`);
});
port.on('data', d => {
  total += d.length;
  line(`+${d.length}B hex=${d.toString('hex')} ascii=${JSON.stringify(d.toString('latin1'))}`);
});
port.on('error', e => line(`PORT ERROR: ${e.message}`));

process.on('SIGINT', () => { line(`=== cerrando, total ${total}B ===`); port.close(() => process.exit(0)); });
process.on('SIGTERM', () => { line(`=== SIGTERM, total ${total}B ===`); port.close(() => process.exit(0)); });
