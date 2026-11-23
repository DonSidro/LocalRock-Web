import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import WebSocket from 'ws';
import type { MapDto, ServerMessage, VacuumSnapshot } from '../shared/api.js';

/*
 * End-to-end check of the server against the simulator ("npm run sim"): every robot action goes
 * through HTTP -> MQTT -> simulated robot and back. Run with BASE=http://127.0.0.1:<port>.
 */

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:8080';
const S8 = 'SimS8ProUltra01';
const CURV = 'SimQrevoCurv02';

let failures = 0;
function check(cond: boolean, what: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
  if (!cond) failures++;
}

async function api(path: string, body?: unknown): Promise<{ ok: boolean; result?: any; error?: string }> {
  const res = await fetch(`${BASE}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify(body),
  });
  return res.json() as Promise<{ ok: boolean; result?: any; error?: string }>;
}

const call = (duid: string, name: string, args: Record<string, unknown> = {}) => api(`/api/vacuums/${duid}/call`, { name, args });

const snapshots = new Map<string, VacuumSnapshot>();
const maps = new Map<string, MapDto | null>();

async function until<T>(what: string, f: () => T | undefined | null | false, timeoutMs = 20_000): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  (timed out waiting for ${what})`);
  return null;
}

async function main() {
  // Cross-site protections.
  const xs = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  check(xs.status === 403, 'cross-site POST is refused');
  const plain = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  check(plain.status === 415, 'non-JSON POST is refused');
  // fetch() can't set Host, so ask with node:http.
  const rebindStatus = await new Promise<number>((resolve, reject) => {
    const u = new URL(`${BASE}/api/state`);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'evil.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  check(rebindStatus === 421, 'unknown Host header is refused (DNS rebinding)');

  check((await api('/api/server', { url: 'ftp://x' })).ok === false, 'bad server address rejected');
  check((await api('/api/server', { url: 'https://127.0.0.1:8443', allowSelfSigned: true })).ok, 'server address saved');
  const bad = await api('/api/login', { email: 'me@example.com', code: '000000' });
  check(!bad.ok && /invalid code/.test(bad.error ?? ''), `wrong code refused (${bad.error})`);
  const login = await api('/api/login', { email: 'me@example.com', code: '123456' });
  check(login.ok, `sign in (${login.error ?? 'ok'})`);

  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`, { headers: { Origin: BASE } });
  const alerts: string[] = [];
  let devicesMsg: Extract<ServerMessage, { t: 'devices' }> | null = null;
  let appMsg: Extract<ServerMessage, { t: 'app' }> | null = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    if (msg.t === 'vac') snapshots.set(msg.snapshot.duid, msg.snapshot);
    if (msg.t === 'map') maps.set(msg.duid, msg.map);
    if (msg.t === 'devices') devicesMsg = msg;
    if (msg.t === 'app') appMsg = msg;
    if (msg.t === 'alert') alerts.push(msg.alert.body);
  });
  await new Promise((r) => ws.once('open', r));

  await until('mqtt', () => appMsg?.state.mqttConnected);
  check(appMsg!.state.mqttConnected, 'MQTT connected');
  await api('/api/devices/refresh', {});
  const online = await until('reachability', () => devicesMsg?.devices.filter((d) => d.reachability === 'ONLINE').length === 2 && devicesMsg);
  check(!!online, 'both robots probed ONLINE');
  check(devicesMsg!.devices.some((d) => d.duid === 'SimUnpaired03' && !d.paired), 'unpaired robot listed as not paired');
  check((await until('never heard', () => devicesMsg?.devices.find((d) => d.duid === 'SimUnpaired03')?.unpaired)) === true
    && devicesMsg!.devices.filter((d) => d.unpaired).length === 1, 'a robot the server never heard from shows as not paired yet');

  ws.send(JSON.stringify({ t: 'watch', duid: S8 }));
  const map = await until('map', () => maps.get(S8));
  check(!!map && map.width === 439 && map.height === 516, 'legacy map arrives (439x516)');
  const named = await until('room names', () => maps.get(S8)?.rooms.find((r) => r.id === 17 && r.name === 'Kitchen'));
  check(!!named, 'room 17 is named Kitchen through get_room_mapping + home rooms');
  await until('status', () => snapshots.get(S8)?.status.battery !== undefined);
  check(snapshots.get(S8)!.status.state === 8 || snapshots.get(S8)!.status.state === 100, 'status polled (charging)');
  await until('floor maps', () => snapshots.get(S8)?.floorMapsLoaded);
  check(snapshots.get(S8)!.floorMaps.length === 1 && snapshots.get(S8)!.floorMaps[0]!.name === 'Home', 'saved maps listed');

  // Cleaning modes
  check((await call(S8, 'setFanPower', { level: 104 })).ok, 'set suction MAX');
  await until('fan', () => snapshots.get(S8)?.status.fanPower === 104);
  check(snapshots.get(S8)!.status.fanPower === 104, 'status shows MAX suction');
  check((await call(S8, 'setFanPower', { level: 999 })).ok === false, 'invalid suction rejected');
  const turbo = await call(S8, 'setFanPower', { level: 103 });
  check(turbo.ok && (await until('turbo', () => snapshots.get(S8)?.status.fanPower === 103)) !== null, `refused suction change retried as one motor-mode call (${turbo.error ?? 'ok'})`);
  check((await call(S8, 'setMopMode', { mode: 303 })).ok && snapshots.get(S8) !== undefined, 'set route Deep+');
  check((await call(S8, 'fetchMopMode')).ok, 'read route');
  await until('mop', () => snapshots.get(S8)?.mopMode === 303);
  check(snapshots.get(S8)!.mopMode === 303, 'route reads back 303');

  // Per-room
  check((await call(S8, 'setCleanMotorMode', { fan: 106, water: 204, mop: 302 })).ok, 'switch to per-room mode');
  check((await call(S8, 'fetchRoomCleanModes')).ok, 'read per-room settings');
  const modes = [16, 17, 18].map((segment) => ({ segment, fanPower: 105, waterBoxMode: 202, mopMode: 300 }));
  const saveModes = await call(S8, 'saveRoomCleanModes', { modes });
  check(saveModes.ok, `save per-room settings with read-back (${saveModes.error ?? 'ok'})`);
  check((await call(S8, 'saveRoomCleanModes', { modes: [{ segment: 16, fanPower: 105, waterBoxMode: 200, mopMode: 300 }] })).ok === false, 'room without suction or water refused');
  check((await call(S8, 'setCleanMotorMode', { fan: 102, water: 201, mop: 300 })).ok, 'back to manual');

  // Order
  const order = await call(S8, 'saveCleanOrder', { order: [22, 17, 16] });
  check(order.ok, `default order saved with read-back (${order.error ?? 'ok'})`);
  await until('order', () => snapshots.get(S8)?.defaultCleanOrder.length === 3);
  check(JSON.stringify(snapshots.get(S8)!.defaultCleanOrder) === '[22,17,16]', 'default order kept for the loaded map');

  // Settings reads
  for (const name of ['fetchConsumables', 'fetchHistory', 'fetchTimers', 'fetchRobotSettings', 'fetchDockSettings', 'fetchDnd']) {
    const r = await call(S8, name);
    check(r.ok, `${name} (${r.error ?? 'ok'})`);
  }
  await until('reads', () => snapshots.get(S8)?.cleanHistory.length === 3 && snapshots.get(S8)?.dnd);
  const s = snapshots.get(S8)!;
  check(s.consumables?.mainBrushWorkTime === 412_000, 'consumables parsed');
  check(s.cleanHistory.length === 3 && s.cleanSummary?.totalCount === 57, 'history and summary parsed');
  check(s.timers.length === 1 && s.timers[0]!.weekdays.join() === '1,2,3,4,5', 'schedule parsed');
  check(s.robotSettings.volume === 80 && s.robotSettings.ledEnabled, 'robot settings parsed (array and object forms)');
  check(s.dnd?.enabled === true && s.dnd.startHour === 22, 'DND parsed');
  check((await call(S8, 'createTimer', { hour: 7, minute: 30, weekdays: [0, 6] })).ok, 'schedule created');
  check((await call(S8, 'fetchTimers')).ok && (await until('timers', () => snapshots.get(S8)?.timers.length === 2)) !== null, 'schedule reads back');
  check((await call(S8, 'setVolume', { volume: 30 })).ok, 'volume set');
  check((await call(S8, 'setCarpetMode', { mode: 2 })).ok && (await until('carpet', () => snapshots.get(S8)?.robotSettings.carpetMode === 2)) !== null, 'carpet mode sent as a bare object');
  check((await call(S8, 'setLed', { on: false })).ok && (await until('led', () => snapshots.get(S8)?.robotSettings.ledEnabled === false)) !== null, 'status light sent as a bare value');
  check((await call(S8, 'setChildLock', { locked: true })).ok && (await until('lock', () => snapshots.get(S8)?.robotSettings.childLock === true)) !== null, 'child lock read back');
  check((await call(S8, 'setDnd', { startHour: 23, startMinute: 15, endHour: 7, endMinute: 0 })).ok, 'DND set');
  check((await call(S8, 'resetConsumable', { field: 'filter_work_time' })).ok, 'filter reset');
  check((await call(S8, 'resetConsumable', { field: 'rm -rf' })).ok === false, 'unknown consumable refused');

  // Robot options and the robot's own feature flags
  check((await call(S8, 'fetchFeatures')).ok, 'robot options read');
  const featureIds = () => (snapshots.get(S8)?.features ?? []).map((f) => f.id);
  const featureVal = (id: string) => snapshots.get(S8)?.features.find((f) => f.id === id)?.value;
  check((await until('features', () => featureIds().includes('cleaning_pattern'))) !== null, `options from the robot's own flags (${featureIds().join(',')})`);
  check(featureIds().includes('right_brush_stretch') && featureIds().includes('collision_mode') && !featureIds().includes('avoid_collision')
    && featureIds().includes('carpet_boost') && featureIds().includes('optimize_battery'), 'collision picker replaces the switch; ungated carpet boost answered');
  check(snapshots.get(S8)!.supportsSmartPlan === false, 'SmartPlan still follows the flags');
  check((await call(S8, 'setFeature', { id: 'right_brush_stretch', value: 0 })).ok && (await until('brush', () => featureVal('right_brush_stretch') === 0)) !== null, 'FlexiArm off (wrapped object shape)');
  check((await call(S8, 'setFeature', { id: 'collision_mode', value: 2 })).ok && (await until('collision', () => featureVal('collision_mode') === 2)) !== null, 'less collision picked ({"status": n})');
  check((await call(S8, 'setFeature', { id: 'collision_mode', value: 0 })).ok === false, 'a value the picker does not offer is refused');
  check((await call(S8, 'setFeature', { id: 'carpet_boost', value: 0 })).ok && (await until('boost', () => featureVal('carpet_boost') === 0)) !== null, 'carpet boost off (whole object echoed)');
  check((await call(S8, 'setFeature', { id: 'cleaning_pattern', value: 2 })).ok && (await until('pattern', () => featureVal('cleaning_pattern') === 2)) !== null, 'cleaning pattern through app_set_robot_setting');
  check((await call(S8, 'setFeature', { id: 'optimize_battery', value: 1 })).ok && (await until('battery', () => featureVal('optimize_battery') === 1)) !== null, 'smart charging on (bare value)');
  check((await call(S8, 'setFeature', { id: 'gap_deep_clean', value: 1 })).ok === false, 'an option the robot does not offer is refused');

  // Dock settings
  const dockOf = () => snapshots.get(S8)!.dockSettings;
  const dock = dockOf();
  check(dock.smartWash?.intervalSeconds === 900 && dock.mopDrying === true && dock.dryTimeSeconds === 10_800 && dock.washWaterTemperature === 2, `dock settings parsed (${JSON.stringify(dock)})`);
  check(snapshots.get(S8)!.featureSet !== null && snapshots.get(S8)!.status.dockType === 8, 'feature set and dock type reported');
  check((await call(S8, 'setWashFrequency', { mode: 0, intervalMinutes: 20 })).ok, 'wash every 20 min');
  check((await call(S8, 'setWashFrequency', { mode: 1, intervalMinutes: null })).ok
    && (await until('wash by room', () => dockOf().smartWash?.mode === 1 && dockOf().smartWash?.intervalSeconds === 1200)) !== null, 'wash by room keeps the interval');
  check((await call(S8, 'setWashFrequency', { mode: 0, intervalMinutes: null })).ok === false, 'time-based washing needs an interval');
  check((await call(S8, 'setDryTime', { seconds: 7200 })).ok, 'drying time set');
  check((await call(S8, 'setMopDrying', { enabled: false })).ok, 'mop drying off');
  check((await call(S8, 'fetchDockSettings')).ok
    && (await until('dryer', () => dockOf().dryTimeSeconds === 7200 && dockOf().mopDrying === false)) !== null, 'dryer setting kept its time when switched off');
  check((await call(S8, 'setWashWaterTemperature', { value: 1 })).ok, 'water temperature set');
  check((await call(S8, 'setAutoEmptyMode', { mode: 4 })).ok && (await call(S8, 'setAutoEmptyMode', { mode: 9 })).ok === false, 'auto-empty mode checked');
  const valleyOf = () => snapshots.get(S8)!.valley;
  check((await call(S8, 'fetchValley')).ok && (await until('valley', () => valleyOf() && valleyOf()!.enabled === false)) !== null, 'off-peak window read');
  check((await call(S8, 'setValley', { startHour: 23, startMinute: 0, endHour: 5, endMinute: 30 })).ok
    && (await until('valley set', () => valleyOf()?.enabled && valleyOf()?.endMinute === 30)) !== null, 'off-peak window set');
  check((await call(S8, 'disableValley')).ok && (await until('valley off', () => valleyOf()?.enabled === false)) !== null, 'off-peak window off');
  const drain = await call(S8, 'emptyInbuiltWaterTank');
  check(drain.ok, `water tank emptied while docked (${drain.error ?? 'ok'})`);

  // Map edits (legacy, single map 0)
  const noGo = { x0: 25000, y0: 26000, x1: 26000, y1: 26000, x2: 26000, y2: 25000, x3: 25000, y3: 25000, kind: 'NO_GO' };
  const carpet = { x0: 24000, y0: 23000, x1: 25500, y1: 23000, x2: 25500, y2: 22000, x3: 24000, y3: 22000, kind: 'CARPET' };
  const m0 = maps.get(S8)!;
  const edit = await call(S8, 'saveMapEdits', { noGoZones: [noGo], walls: m0.virtualWalls, carpets: [carpet], thresholds: [] });
  check(edit.ok, `no-go zone + carpet saved and confirmed on the map (${edit.error ?? 'ok'})`);
  const after = maps.get(S8)!;
  check(after.noGoZones.length === 1 && after.carpetAreas.length === 1 && after.carpetFlagsPresent, 'map shows zone and flagged carpet');
  const mat = await call(S8, 'setFloorMaterial', { segment: 18, material: 3, direction: 90 });
  check(mat.ok && mat.result?.confirmed === true, `floor material set and confirmed (${mat.error ?? 'ok'})`);
  const rename = await call(S8, 'renameRoom', { segment: 23, name: 'Guest room' });
  check(rename.ok, `room renamed through the server (${rename.error ?? 'ok'})`);
  const guest = await until('guest', () => maps.get(S8)?.rooms.find((r) => r.id === 23 && r.name === 'Guest room'));
  check(!!guest, 'map label shows the new room name');
  const typed = await call(S8, 'setRoomType', { segment: 23, tag: 14 });
  check(typed.ok, `room type set (${typed.error ?? 'ok'})`);
  check((await until('kitchen', () => maps.get(S8)?.rooms.find((r) => r.id === 23 && r.name === 'Kitchen'))) !== null
    && snapshots.get(S8)?.roomTags[23] === 14, 'room type names the room and sets its tag');
  check((await call(S8, 'setRoomType', { segment: 23, tag: 99 })).ok === false, 'unknown room type refused');
  const routines = await call(S8, 'fetchRoutines');
  check(routines.ok && Array.isArray(routines.result) && routines.result.length === 2 && routines.result[0].name === 'After dinner', `routines listed (${routines.error ?? 'ok'})`);
  const started = await call(S8, 'runRoutine', { id: 101, name: 'After dinner' });
  check(started.ok && started.result === '"After dinner" started', `routine started (${started.error ?? started.result})`);
  const blocked = await call(S8, 'runRoutine', { id: 102, name: 'Kitchen twice' });
  check(!blocked.ok && /"After dinner" is still running/.test(blocked.error ?? ''), `second routine blocked (${blocked.error ?? 'ok'})`);
  const stopped = await call(S8, 'runRoutine', { id: 101, name: 'After dinner' });
  check(stopped.ok && stopped.result === 'Stopping "After dinner"', 'running the same routine again stops it');
  const merge = await call(S8, 'mergeRooms', { a: 24, b: 25 });
  check(merge.ok, `rooms merged and confirmed (${merge.error ?? 'ok'})`);
  // A vertical line through the merged room's label, in robot mm.
  const mm = maps.get(S8)!;
  const r24 = mm.rooms.find((r) => r.id === 24)!;
  const cx = Math.round((r24.labelNormX! * mm.width + mm.pixelOffsetLeft) * 50);
  const cy = Math.round(((1 - r24.labelNormY!) * mm.height + mm.pixelOffsetTop) * 50);
  const roomsBefore = mm.rooms.length;
  const split = await call(S8, 'splitRoom', { segment: 24, a: [cx, cy - 2000], b: [cx, cy + 2000] });
  check(split.ok, `room split and confirmed (${split.error ?? 'ok'})`);
  check(maps.get(S8)!.rooms.length === roomsBefore + 1, 'map has one more room after the split');
  const rn = await call(S8, 'renameFloorMap', { mapFlag: 0, name: 'Ground floor' });
  check(rn.ok, `map renamed with read-back (${rn.error ?? 'ok'})`);
  check((await call(S8, 'renameFloorMap', { mapFlag: 0, name: 'Kælder' })).ok === false, 'non-ASCII map name refused');

  // Cleaning and alerts
  check((await api('/api/notify', { enabled: true })).ok, 'alerts on');
  check((await call(S8, 'cleanRooms', { rooms: [22, 17], repeat: 1 })).ok, 'room clean started');
  await until('cleaning', () => snapshots.get(S8)?.status.state === 18);
  check(snapshots.get(S8)!.status.state === 18, 'robot reports room cleaning');
  const busyEdit = await call(S8, 'saveMapEdits', { noGoZones: [], walls: [], carpets: [], thresholds: [] });
  check(!busyEdit.ok && /busy/.test(busyEdit.error ?? ''), 'map edit refused while cleaning');
  check((await call(S8, 'pause')).ok, 'paused');
  check((await call(S8, 'dock')).ok, 'sent to dock');
  const dockedAlert = await until('finished alert', () => alerts.find((a) => a.startsWith('Cleaning finished')), 15_000);
  check(!!dockedAlert, `finished alert (${dockedAlert ?? 'none'})`);

  // Zones / pin & go / remote with mm coordinates
  check((await call(S8, 'cleanZones', { zones: [{ x1: 24000, y1: 22000, x2: 25500, y2: 23500, times: 1 }] })).ok, 'zone clean');
  check((await call(S8, 'stop')).ok, 'stop');
  check((await call(S8, 'gotoTarget', { x: 25000, y: 24500 })).ok, 'pin & go');
  check((await call(S8, 'rcStart')).ok && (await call(S8, 'rcMove', { velocity: 0.3, omega: 0, durationMs: 1500 })).ok && (await call(S8, 'rcEnd')).ok, 'remote control');

  // Camera path
  const cam = await call(S8, 'cameraRpc', { method: 'check_homesec_password', params: { password: '81dc9bdb52d04dc20036dbd8313ed055' } });
  check(cam.ok && cam.result.error?.code === -1007, 'camera RPC reaches the robot (-1007 from the simulator)');
  check((await call(S8, 'cameraRpc', { method: 'app_start', params: {} })).ok === false, 'non-camera method refused on the camera route');

  // B01 robot
  ws.send(JSON.stringify({ t: 'watch', duid: CURV }));
  const b01 = await until('b01 map', () => maps.get(CURV));
  check(!!b01 && b01.format === 'B01' && b01.rooms.length === 10, 'B01 map arrives with 10 rooms');
  await until('curv', () => snapshots.get(CURV)?.status.fanPower === 110);
  check(snapshots.get(CURV)!.supportsSmartPlan && snapshots.get(CURV)!.status.fanPower === 110, 'SmartPlan supported and active');
  const b01edit = await call(CURV, 'saveMapEdits', { noGoZones: [], walls: [], carpets: [], thresholds: [] });
  check(!b01edit.ok && /format/.test(b01edit.error ?? ''), 'B01 map editing refused');

  // Add vacuum: server steps work; the hotspot step fails cleanly without a robot at 192.168.8.1.
  const obDevices = await api('/api/onboarding/devices', { adminPassword: 'admin' });
  check(obDevices.ok && obDevices.result.length === 1 && obDevices.result[0].duid === 'SimUnpaired03', 'onboarding lists the unpaired vacuum');
  check((await api('/api/onboarding/devices', { adminPassword: 'wrong' })).ok === false, 'wrong admin password refused');
  check((await api('/api/onboarding/devices', { adminPassword: 'admin' })).ok, 'admin login again');
  const prep = await api('/api/onboarding/prepare', { duid: 'SimUnpaired03' });
  check(prep.ok, `pairing session started (${prep.error ?? 'ok'})`);
  const sendWifi = await api('/api/onboarding/send', { ssid: 'home', password: 'secret123', timezone: 'Europe/Berlin' });
  check(!sendWifi.ok && /robot|hello|reach/i.test(sendWifi.error ?? ''), `hotspot step reports the missing robot (${sendWifi.error})`);

  // The server forgets every session (as after a restart): the backend must sign in again by itself.
  await new Promise<void>((resolve) => {
    const req = httpsRequest({ host: '127.0.0.1', port: 8443, path: '/sim/expire-sessions', method: 'POST', rejectUnauthorized: false }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.end();
  });
  const dropped = await until('link down', () => appMsg && !appMsg.state.mqttConnected, 10_000);
  check(!!dropped, 'MQTT link dropped when the server forgot the session');
  const back = await until('relogin', () => appMsg?.state.mqttConnected, 60_000);
  check(!!back, 'MQTT link back after a silent re-login');
  const fresh = await call(S8, 'fetchMopMode');
  check(fresh.ok, `robot answers again on the new session's topics (${fresh.error ?? 'ok'})`);
  const st = await call(S8, 'fetchConsumables');
  check(st.ok, `and again (${st.error ?? 'ok'})`);

  ws.close();
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
