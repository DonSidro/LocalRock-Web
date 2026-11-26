# LocalRock Web

A web version of [LocalRock](https://github.com/DonSidro/LocalRock): control Roborock vacuums from a
browser through your self-hosted [local_roborock_server](https://github.com/Python-roborock/local_roborock_server),
without Roborock's cloud.

It is a small Node.js server plus a web page. The server signs in to your local_roborock_server,
keeps one MQTT connection to the robots, and does the encryption, map decoding and every robot
command (ported from the LocalRock app's shared Kotlin code). The page shows it all and works on a
desktop browser and on a phone.

## Requirements

- Node.js 20 or newer, or Docker (see [Run with Docker](#run-with-docker))
- A running local_roborock_server with your vacuums imported (the same setup the app uses)
- The email and login code from your server setup

## Quick start

```bash
npm install
npm run build
npm start
```

Open http://127.0.0.1:8080, enter your server address (for example `https://192.168.1.10:555`),
then sign in with the email and login code from your server setup.

Settings, the server session and the login code are kept in the `data/` folder of this project.

## Features

Everything the app does, laid out for a desktop browser:

- A sidebar with every robot and its live state; a home page with a card per robot (map preview,
  battery, Clean and Dock buttons) and a real reachability check (each robot is asked directly)
- Each robot has a workspace: name, state and the main controls on top, then tabs for Overview,
  Edit map, Schedule, History, Maintenance, Settings, Camera (on supported robots) and Remote. Every
  tab has its own address, so it can be bookmarked or opened in a new browser tab
- Overview: the map beside an inspector column (status, rooms, cleaning mode, dock). The map has
  three tools: pick rooms, draw zones, set a Pin & Go target. Scroll to zoom, drag to pan,
  right-drag to pan while drawing, double-click to fit; floor picker for multi-level homes
- The map drawn the way the Roborock app does: the official four room colours, wood, tile and carpet
  textures, smooth edges, the floor-plan outline with doors where the robot sends one, removed areas
  left out, the route with the ground it covered, room names on pills with a room-type badge. Turn it
  in quarter turns, or show it as a 3D model (right-drag or Ctrl+drag, two fingers on touch, to turn
  and tilt); both are remembered per robot in the browser. Robots show the name their model is sold
  under. Where a robot's room outlines are plain boxes that spill past its walls (seen on a Qrevo
  Curv 2 Flow), the map is drawn from its cells instead
- Keyboard shortcuts: C clean / pause / resume, D dock, R refresh the map, 1-3 map tools, Esc to
  clear, Delete to remove a shape in the editor, ? for the list
- Clean, clean picked rooms in the order picked, pause, resume, stop, return to dock
- Cleaning mode: SmartPlan, manual (suction, water, route, cleaning count) and per-room settings
- Default cleaning order for a full clean
- Zone clean (up to 10 zones, 1-3 passes), Pin & Go, remote control (buttons or arrow keys)
- Schedules, Do Not Disturb, robot settings (volume, child lock, LED, carpet mode), find robot
- Dock and care: empty, wash, dry, wash frequency, washing mode, auto-empty mode, tank status
- Maintenance (consumables with reset) and cleaning history
- Saved maps: rename, delete, map the home, save a new map, multi-level maps, floor recognition,
  map saving switch
- Map editor: no-go zones, virtual walls, carpets (rectangular and round), thresholds; move,
  resize, rotate, delete; rooms: rename, floor type, split, merge. Every edit is only reported
  done once the robot's own map shows it, exactly like the app.
- Furniture on the map (all 21 S7 MaxV kinds), and a furniture editor on robots that report support
  for it: add from a catalog, move, rotate, resize and delete, saved only once the robot's map
  confirms every change and leaves every other record untouched
- Camera live view (WebRTC in the browser, behind the Experimental video setting) on models with
  official remote viewing: the S7 MaxV is tested; other known models need an opt-in each visit.
  The existing PIN or pattern is checked first and kept in memory only. Two-way audio calls with
  this browser's microphone, full screen with fill or fit, reconnect in SD and connection tests.
  On the S7 MaxV the viewer also drives (hold a direction), does Pin-and-Go on an inset map, pauses
  and resumes a clean, stops movement and sends the robot home
- Robot alerts (errors, finished cleans, dock problems) as in-page messages and, if you allow it,
  browser notifications
- Add vacuum (Wi-Fi pairing through the server's admin API)
- Light, dark and system theme
- Dock settings offered per model: wash mode, mop wash frequency (by time, by room, smart), auto-empty
  mode, mop drying and drying time, washing water temperature, the off-peak electricity window and
  emptying the robot's built-in water tank through the dock
- Robot options the robot advertises (FlexiArm, collision avoidance, carpet boost and carpet options,
  cleaning pattern, smart charging and more), read from the robot's own feature flags; vacuum then mop
- Room types, routines kept by the server, map backup and restore, obstacles on the map with their
  photos, Find my pet, Matter setup code, Voice Assistant (switch, language packs, chat history)
- History the way the official app shows it: each run's map, result, tags and timeline, plus a Cruise
  tab with each cruise point's photos
- Firmware updates through the server; offline robots show when and where they were last seen, and a
  robot the server never heard from shows as Not paired yet
- Silent re-login when the server expires the session, MQTT reconnect with backoff

### Features that need a newer server

Some features rely on local_roborock_server changes that are not in a released version yet. Without
them LocalRock Web still works; it leaves that part out.

| Feature | Needs in local_roborock_server | Without it |
| --- | --- | --- |
| Last seen, Not paired yet | #251 | An unanswering robot shows as plain Offline |
| Voice language packs | #261 | The Language window says voice packs are unavailable |
| Matter on a locally paired robot | #252 | The robot can't get a Matter setup code |
| Firmware check and install | #255, with the install option turned on | The check says it is not available |

## Differences from the app

- **Add vacuum** has three steps, because a computer can't switch to the robot's Wi-Fi hotspot by
  itself the way the phone does: start the session on your home network, connect this computer
  to the robot's `roborock-vacuum-...` Wi-Fi and send, then reconnect to your home network while
  the page waits for the robot. A computer with a wired connection can stay on both.
- **Alerts** come from the server, so they keep being detected while LocalRock Web runs, but
  they are only shown in an open tab (there is no push service).
- **Zone clean and Pin & Go** send robot millimetres. In the app (1.3.0) these two screens send
  map pixel numbers instead, which do not match the robot's coordinates.
- **Camera** has its own tab instead of the map page's video icon. Voice calls work in any browser
  that allows the microphone (a secure page: HTTPS, or localhost); in the app they are iPhone only.
- **Layout**: a sidebar, tabs, drop-downs, tables and windows instead of the app's bottom
  sheets and drill-down screens. Narrow windows and phones get a drawer for the sidebar and the
  panels under the map.
- There is no demo mode; use the simulator below instead.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port of the web page |
| `HOST` | `127.0.0.1` | Address to listen on. Only this computer can open the page by default. |
| `LOCALROCK_PASSWORD` | none | Password for the page. Required when `HOST` is not a loopback address. |
| `LOCALROCK_INSECURE_LAN` | none | Set to `1` to serve on the network without a password (not recommended). |
| `LOCALROCK_CA_FILE` | none | PEM file with a CA certificate to trust for your server's HTTPS and MQTT. |
| `LOCALROCK_DATA_DIR` | `data` | Where settings and the session are stored |
| `LOCALROCK_ALLOWED_HOSTS` | none | Extra host names for the page while bound to loopback (for a reverse proxy) |
| `LOCALROCK_DEBUG` | none | `1` logs every robot command |

### Using it from your phone or another computer

```bash
HOST=0.0.0.0 LOCALROCK_PASSWORD=choose-a-long-password npm start
```

On Windows PowerShell:

```powershell
$env:HOST="0.0.0.0"; $env:LOCALROCK_PASSWORD="choose-a-long-password"; npm start
```

Then open `http://<this computer's address>:8080`. The page asks for the password once per browser.
Anyone who can open the page can control your robots, so keep it on your own network. For access
from outside, put it behind a VPN or a reverse proxy with HTTPS.

### Certificates

If your server uses a certificate this computer does not trust (self-signed or from your own CA),
either point `LOCALROCK_CA_FILE` at the CA certificate (preferred), or turn on "Allow self-signed
certificates" on the server address screen. The latter turns off certificate checking for the
server's HTTPS and MQTT.

## Run with Docker

Run it on a computer on the same network as your local_roborock_server (a home server, NAS or
Raspberry Pi works). A ready-made image is published for amd64, arm64 and arm/v7, so nothing needs
building. Either run it directly:

```bash
docker run -d --name localrock-web --restart unless-stopped \
  -p 8080:8080 \
  -e LOCALROCK_PASSWORD=choose-a-long-password \
  -v localrock-data:/app/data \
  ghcr.io/donsidro/localrock-web:latest
```

or with Compose, which needs only two files from this repository:

```bash
mkdir localrock-web && cd localrock-web
curl -fsSLO https://raw.githubusercontent.com/DonSidro/LocalRock-Web/master/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/DonSidro/LocalRock-Web/master/.env.example -o .env
# edit .env and choose a long LOCALROCK_PASSWORD, then:
docker compose up -d
```

Images are tagged `latest` (the newest master), the short commit (`sha-...`), and a version such as
`1.0.0` once a matching `v1.0.0` tag is pushed. To build from a checkout instead, swap `image:` for
`build: .` in the compose file and run `docker compose up -d --build`.

Open `http://<that computer's address>:8080` and enter the password. In a container the page
listens on all interfaces, so the password is required; compose refuses to start without it.

- Settings and the server session are kept in the `localrock-data` volume, so they survive
  rebuilds and updates.
- Set `LOCALROCK_PORT` in `.env` to publish another port.
- To trust your own CA, put `ca.pem` next to `docker-compose.yml` and uncomment the two
  `LOCALROCK_CA_FILE` lines in it (with `docker run`: add `-v ./ca.pem:/certs/ca.pem:ro` and
  `-e LOCALROCK_CA_FILE=/certs/ca.pem`).
- Update with `docker compose pull && docker compose up -d` (with `docker run`: pull the image,
  then remove and start the container again; the volume keeps your settings).
- **Add vacuum** sends its Wi-Fi packets from the container. It needs the Docker host itself to
  join the robot's `roborock-vacuum-...` Wi-Fi, so it is easiest on a machine with Wi-Fi; a
  headless server can do the rest and you can pair from a `npm start` copy on a laptop.

## Try it without a robot

The simulator is a stand-in local_roborock_server with an MQTT broker and two simulated vacuums
(one with the classic map format, one with the newer B01 format), plus a third that was never
paired. It answers every command, runs a pretend clean, and applies map edits to a real map so the
read-back checks work. The classic-format robot also has furniture on its map. Set
`SIM_S8_MODEL=roborock.vacuum.a27` to make it pose as an S7 MaxV, so the Camera tab shows (turn on
Experimental video in Settings); the camera itself answers with a disabled-PIN error.

```bash
npm run sim
```

In another terminal run `npm start` (or `npm run dev`), open the page and use:

- Server address `https://127.0.0.1:8443`, with "Allow self-signed certificates" on
- Any email, login code `123456`
- Admin password `admin` (Add vacuum)

## Development

```bash
npm run dev        # server with reload on :8080 and the page with hot reload on http://localhost:5173
npm test           # unit tests (protocol, crypto, maps, commands, pairing packets)
npm run typecheck  # server, page and tests
```

End-to-end checks against the simulator (they start and stop it themselves):

```bash
npx tsx scripts/with-sim.ts scripts/e2e-api.ts                 # every robot action through the API
npm run build
USE_BUILD=1 npx tsx scripts/with-sim.ts scripts/screens.ts     # clicks through every page in Chrome, saves screenshots
```

`scripts/screens.ts` needs Google Chrome; set `CHROME` to its path if it is not in the default place.

### Layout

```
server/            Node server
  protocol/        frames, AES, CRC, JSON envelope, Hawk, MQTT credentials, map download
  map/             legacy "rr" and B01 map parsers
  vacuum/          robot session (RPC over MQTT), commands, repository (polling, map, every action)
  net/             HTTPS client for local_roborock_server, MQTT link
  onboarding/      Wi-Fi pairing packets and flow
  app.ts           sign-in, devices, robots, alerts
  http.ts          HTTP API, WebSocket, page password, cross-site protections
shared/            types and rules used by both the server and the page
web/src/           the page (React)
sim/               simulator
test/              unit tests (with the app's own test vectors and map fixtures)
scripts/           end-to-end checks
```

## Security notes

- The server stores the session, the login code (for silent re-login) and the admin password in
  `data/settings.json`, like the app keeps them in its preferences. Protect that folder. Camera PINs
  are no longer stored (older versions kept them there; they are removed on start).
- By default the page is only reachable from this computer. State-changing requests must be JSON
  from the same origin, the WebSocket checks its origin, and unknown host names are refused, so
  other web sites open in your browser can't drive the robot.
- Nothing is sent anywhere except your local_roborock_server and its MQTT broker.

## Status

Verified against the simulator and the app's own test vectors (golden protocol vectors, Hawk
vectors, captured map-edit payloads, real map fixtures). Not yet run against a real robot.

Not affiliated with or endorsed by Roborock.
