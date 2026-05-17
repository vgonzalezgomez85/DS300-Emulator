const socket = require('socket.io-client')('http://localhost:3100');

let connected = false;
setTimeout(() => {
  if (!connected) {
    console.error('Timeout - no se pudo conectar');
    process.exit(1);
  }
}, 3000);

socket.on('connect', () => {
  connected = true;
  console.log('✓ Conectado al emulador');
  socket.emit('connect_port', { port: '/dev/ttys006', baud: 57600 });
});

socket.on('connected', (msg) => {
  console.log('✓ Emulador conectado:', msg);
  setTimeout(() => process.exit(0), 500);
});

socket.on('port_error', (err) => {
  console.error('✗ Error en puerto:', err);
  process.exit(1);
});

socket.on('error', (err) => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
