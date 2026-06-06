# DS-300 Emulator

Emulador serie de la centralita **DS-300** para probar [SloTime](https://github.com/) (y cualquier otro receptor del protocolo) sin necesidad del hardware físico.

Implementa el protocolo de tramas DS-300 (21 bytes, `0xE0…0xEB`) verificado contra capturas del aparato real, e incluye una UI web para disparar GO, pausa, reanudación, stop y cruces de carril simulados.

---

## Requisitos

- Node.js ≥ 18
- macOS / Linux con `socat` para crear PTYs virtuales (en macOS: `brew install socat`)

## Instalación

```bash
git clone git@github.com:vgonzalezogmez/DS300-Emulator.git
cd DS300-Emulator
npm install
```

## Uso

### 1. Crear un par de puertos serie virtuales

```bash
socat -d -d \
  pty,raw,echo=0,link=/tmp/ds300-emu \
  pty,raw,echo=0,link=/tmp/ds300-app
```

Esto crea dos PTYs (típicamente `/dev/ttys000` y `/dev/ttys002`) enlazados:
- `/tmp/ds300-emu` → para el emulador (este proyecto)
- `/tmp/ds300-app` → para SloTime u otro receptor

### 2. Arrancar el emulador

```bash
npm start
```

Se sirve la UI web en **http://localhost:3100**.

### 3. Conectar

- En la UI selecciona el puerto del emulador (`/dev/ttysXXX`) y abre conexión.
- Apunta SloTime al otro PTY del par.

---

## Director de carrera (multi-DS)

En carreras grandes de **2 a 4 circuitos**, cada DS controla un circuito (hasta 8
carriles). Darle al GO en los 4 DS a la vez "necesita 4 manos". El **Director de
carrera** es un panel maestro que descubre los emuladores en marcha y reenvía
**GO / pausa / reanudar / stop** a los circuitos que marques, **en paralelo**
(casi simultáneo) — desde una sola pantalla.

Cada circuito sigue siendo un emulador independiente (proceso + puerto serie
propio), exactamente como 4 DS reales: SloTime ve N puertos serie independientes.

```bash
# 1. Arranca los emuladores (en SloTime: ./start-emulators.sh → 2-4 instancias en 3100, 3101, …)
# 2. Arranca el director:
npm run director
# → http://localhost:3099
```

El director **no emula nada**: solo orquesta por HTTP los emuladores ya vivos
(fan-out server-side, sin CORS). Por defecto escanea los puertos `3100-3103`.

| Variable           | Default       | Descripción |
|--------------------|---------------|-------------|
| `DS_DIRECTOR_PORT` | `3099`        | Puerto HTTP del panel director |
| `DS_DIRECTOR_SCAN` | `3100-3103`   | Puertos de emulador a escanear (rango `3100-3107` o lista `3100,3101,3105`) |

### API del director

| Endpoint        | Método | Acción |
|-----------------|--------|--------|
| `/api/units`    | GET    | Sondea los emuladores y devuelve su estado (online, puerto serie, estado de carrera, cronómetro) |
| `/api/control`  | POST   | Fan-out de una acción: `{ action: "go"\|"pause"\|"resume"\|"stop", ports: [3100,…], durationMin? }` |

---

## Protocolo implementado

### Estructura de trama (21 bytes)

| Byte  | Significado |
|------:|-------------|
| 0     | `0xE0` sync |
| 1     | contador (rolling 0x00-0xFF) |
| 2-6   | cabecera fija `15 03 00 04 4C` |
| 7     | tipo: `0x3E` GO · `0x1B` cruce · `0x00` control |
| 8     | subtipo (`0xA1`…`0xA7`, `0xA9` first crossing, `0x00` lap) |
| 9-13  | datos: máscara carril, lap counter, etc. |
| 14-17 | tiempo BCD (mins / secs / cents / dmils) |
| 18    | checksum = `(B1+…+B17) mod 256` |
| 19    | reservado |
| 20    | `0xEB` end |

### Secuencias de control

| Evento        | B7   | B8   | Notas |
|---------------|------|------|-------|
| **GO** T1     | 0x3E | 0xA1 | + duración BCD en B9/B10 |
| GO T2 (+2500ms) | 0x00 | 0xA2 | confirmación |
| GO T3 (+2953ms) | 0x00 | 0xA3 | *current ON* — arranca el cronómetro |
| Pause         | 0x00 | 0xA5 | |
| **Resume** T1 | 0x00 | 0xA6 | |
| Resume T2 (+2500ms) | 0x00 | 0xA2 | confirmación |
| Resume T3 (+2953ms) | 0x00 | 0xA3 | *running* — vuelve a correr |
| Finish        | 0x00 | 0xA4 | |
| Forced stop   | 0x00 | 0xA7 | |
| Lap crossing  | 0x1B | 0x00 | tiempo BCD en B14-B17 |
| First crossing| 0x1B | 0xA9 | B14=`0xAA` (tiempo inválido) |

Los delays GO/Resume son configurables vía las constantes `GO_T*_DELAY_MS` y `RESUME_T*_DELAY_MS` en [emulator.js](emulator.js).

---

## Variables de entorno

| Variable          | Default | Descripción |
|-------------------|---------|-------------|
| `DS_HTTP_PORT`    | `3100`  | Puerto HTTP de la UI |
| `DS_DURATION_MIN` | `5`     | Duración por defecto de manga (min) |
| `DS_LANES`        | `8`     | Número de carriles |

---

## API HTTP

| Endpoint         | Método | Acción |
|------------------|--------|--------|
| `/api/go`        | POST   | Lanzar GO (body opcional: `{ durationMin }`) |
| `/api/pause`     | POST   | Pausar |
| `/api/resume`    | POST   | Reanudar (envía secuencia A6→A2→A3) |
| `/api/stop`      | POST   | Forced stop |
| `/api/status`    | GET    | Estado del DS (conexión, puerto serie, estado de carrera, cronómetro) |
| `/api/connect`   | POST   | Abrir puerto serie (body: `{ port }`) |

Mismas acciones disponibles vía Socket.IO desde la UI.

---

## Estructura

```
emulator.js       — servidor + lógica de carrera + emisión de tramas
connect.js        — helper para gestión del SerialPort
public/index.html — UI web (controles + log en vivo)
```
