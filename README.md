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

## DS 4-port (agrupador de puertos)

El **DS 4-port** es el aparato físico que une de **1 a 4 DS-300** (cada uno en su
COM) y vuelca **todo por un único COM** hacia el PC con el software. `ds4port.js`
lo emula como **pasarela pura**: NO simula carreras, sino que abre hasta 4 puertos
serie de **entrada** (donde enchufas los DS-300 reales, o los pares socat de
instancias de `emulator.js`) y un puerto de **salida**, reetiquetando cada trama.

```
DS real/emu 1 ─COM─┐
DS real/emu 2 ─COM─┤
DS real/emu 3 ─COM─┼─[ DS4PORT ]─COM─→ PitWall
DS real/emu 4 ─COM─┘   reetiqueta
```

### Qué reescribe (verificado byte a byte contra captura real)

Un DS-300 suelto manda `E0 CC 15 03 00 04 4C …` (byte[4]=`00`, contador propio).
En el stream fusionado el agrupador reescribe:

| Byte | Antes | Después | Significado |
|-----:|-------|---------|-------------|
| 1  | contador propio del DS | **contador GLOBAL único** | rolling `00-FF`, +1 por trama sea del puerto que sea |
| 4  | `00` | **nº de circuito de origen** (`01`-`04`) | así el software identifica el circuito |
| 18 | checksum del DS | **checksum recalculado** | `(B1+…+B17) mod 256` tras estampar 1 y 4 |

El resto (tipo, subtipo, tiempos BCD, máscara de carril, byte 19, `0xEB`) se pasa intacto.

### Uso

```bash
# 1. Un par socat por cada entrada + uno para la salida:
socat -d -d pty,raw,echo=0,link=/tmp/ds300-emu1 pty,raw,echo=0,link=/tmp/ds300-app1   # …emu2/app2, emu3/app3, emu4/app4
socat -d -d pty,raw,echo=0,link=/tmp/ds4-out    pty,raw,echo=0,link=/tmp/ds4-app

# 2. Cada DS-300 (o emulator.js) escribe en su lado -emuN.
# 3. Arranca el agrupador (UI en http://localhost:3200):
npm run 4port
```

En la UI: conecta la **salida** a `/tmp/ds4-out`, y cada **entrada** a `/tmp/ds300-appN`
(ajustando el `byte[4]` de circuito por entrada). Apunta PitWall a `/tmp/ds4-app`.

### Variables de entorno (auto-conexión)

| Variable | Default | Descripción |
|----------|---------|-------------|
| `DS4_HTTP_PORT` | `3200` | Puerto HTTP de la UI |
| `DS4_OUT` | — | Puerto de salida a auto-conectar al arrancar |
| `DS4_IN1`…`DS4_IN4` | — | Puerto de entrada por slot (circuito 1-4) a auto-conectar |
| `DS4_BAUD_IN` / `DS4_BAUD_OUT` | `56000` | Baudios entrada / salida (fallback 57600) |

### API HTTP

| Endpoint | Método | Acción |
|----------|--------|--------|
| `/api/status` | GET | Estado: salida, contador global, total reenviadas, slots |
| `/api/ports` | GET | Lista de puertos serie disponibles |
| `/api/output` | POST | Conectar salida: `{ path, baud? }` |
| `/api/input` | POST | Conectar entrada: `{ slot, path, circuitId?, baud? }` |

Mismas acciones vía Socket.IO desde la UI.

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
emulator.js         — servidor + lógica de carrera + emisión de tramas (1 DS-300)
director.js         — panel maestro multi-DS (orquesta N emuladores por HTTP)
ds4port.js          — agrupador de puertos: 1-4 DS-300 → 1 COM (pasarela pura)
connect.js          — helper para gestión del SerialPort
public/index.html   — UI del emulador (controles + log en vivo)
public/director.html— UI del director de carrera
public/ds4port.html — UI del agrupador DS 4-port
```
