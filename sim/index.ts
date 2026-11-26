import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { gzipSync } from 'node:zlib';
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import aedes from 'aedes';
import selfsigned from 'selfsigned';
import { Protocol, decodeMessages, encodeMessage } from '../server/protocol/codec.js';
import { aesCbcEncrypt, randomHex } from '../server/protocol/crypto.js';
import { hawkMac } from '../server/protocol/hawk.js';
import { deriveMqttCreds, type Rriot } from '../server/protocol/mqttCreds.js';
import { SimRobot, type RobotConfig } from './robot.js';

/*
 * Development simulator: a stand-in local_roborock_server (HTTPS API with Hawk checks, admin API),
 * an MQTT broker, and two vacuums. Start it with "npm run sim", then in LocalRock Web use
 *   server address  https://127.0.0.1:8443   (allow self-signed certificates)
 *   email           anything                 login code 123456
 */

const HTTPS_PORT = Number(process.env['SIM_HTTPS_PORT'] ?? 8443);
const MQTT_PORT = Number(process.env['SIM_MQTT_PORT'] ?? 18830);
const LOGIN_CODE = '123456';
const ADMIN_PASSWORD = 'admin';
const HOME_ID = 4242;

/** newFeatureSet with SmartPlan (bit 55) and water slide (bit 106) set. */
function featureSet(bits: number[]): string {
  const nibbles = new Array(32).fill(0);
  for (const b of bits) nibbles[31 - Math.floor(b / 4)] |= 1 << (b % 4);
  return nibbles.map((n) => n.toString(16)).join('').toUpperCase();
}

/** The bits set in a hex newFeatureSet. */
function bitsOf(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i++) {
    const n = parseInt(hex[hex.length - 1 - i]!, 16);
    for (let b = 0; b < 4; b++) if ((n >> b) & 1) out.push(i * 4 + b);
  }
  return out;
}

const robots = [
  new SimRobot({
    duid: 'SimS8ProUltra01', name: 'S8 Pro Ultra (simulated)', localKey: 'abcdefghijklmnop', productId: 'p-s8',
    // SIM_S8_MODEL=roborock.vacuum.a27 makes it pose as an S7 MaxV, so the camera page shows (for screenshots).
    model: process.env['SIM_S8_MODEL'] ?? 'roborock.vacuum.a70', newFeatureSet: '00000048009EFFFE', robotNewFeatureSet: featureSet([...bitsOf('00000048009EFFFE'), 36, 54, 70, 74, 118]), featureSet: String(2 ** 25 + 2 ** 3), fv: '02.33.88', format: 'legacy',
  } satisfies RobotConfig),
  new SimRobot({
    duid: 'SimQrevoCurv02', name: 'Qrevo Curv (simulated)', localKey: 'qrstuvwxyz012345', productId: 'p-curv',
    model: 'roborock.vacuum.a245', newFeatureSet: featureSet([15, 34, 37, 48, 55, 67, 93, 102, 106, 109]), featureSet: String(2 ** 25), fv: '03.11.02', format: 'b01',
  } satisfies RobotConfig),
];

const unpaired = { duid: 'SimUnpaired03', name: 'Saros 10R (not paired)', productId: 'p-saros', online: false };

// ---- Sessions ----

interface Session { token: string; rriot: Rriot; uid: number; rruid: string }
const sessions: Session[] = [];

function newSession(): Session {
  const session: Session = {
    token: `rr${randomHex(16)}`,
    uid: 1234567,
    rruid: `rr${randomHex(7)}`,
    rriot: {
      u: randomHex(11), s: randomHex(3), h: randomHex(5), k: randomHex(4),
      r: { r: 'EU', a: `https://127.0.0.1:${HTTPS_PORT}`, m: `mqtt://127.0.0.1:${MQTT_PORT}`, l: `https://127.0.0.1:${HTTPS_PORT}` },
    },
  };
  sessions.push(session);
  if (sessions.length > 5) sessions.shift();
  return session;
}

// ---- HTTPS API ----

const pems = selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
  days: 365, keySize: 2048, algorithm: 'sha256',
  extensions: [{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }],
});

const cloudRooms: Array<{ id: number; name: string }> = robots.flatMap((r) => r.homeRooms());
let nextRoomId = 5000;
const adminCookies = new Set<string>();
const onboardingSessions = new Map<string, { started: number; duid: string }>();

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Check a Hawk header the way local_roborock_server does. */
function hawkOk(req: IncomingMessage, path: string, query: Record<string, string>, form: Record<string, string> | null): boolean {
  const header = req.headers.authorization ?? '';
  const fields = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const session = sessions.find((s) => s.rriot.u === fields['id'] && s.rriot.s === fields['s']);
  if (!session || !fields['ts'] || !fields['nonce'] || !fields['mac']) return false;
  if (Math.abs(Date.now() / 1000 - Number(fields['ts'])) > 300) return false;
  const expected = hawkMac({ id: session.rriot.u, session: session.rriot.s, key: session.rriot.h }, path, Number(fields['ts']), fields['nonce'], query, form);
  return expected === fields['mac'];
}

function home() {
  return {
    id: HOME_ID,
    name: 'Simulated home',
    rooms: cloudRooms,
    devices: [
      ...robots.map((r) => ({
        duid: r.config.duid, name: r.config.name, localKey: r.config.localKey, productId: r.config.productId,
        online: true, newFeatureSet: r.config.newFeatureSet, featureSet: r.config.featureSet ?? null, fv: r.config.fv, sn: `SN${r.config.duid}`,
      })),
      unpaired,
    ],
    receivedDevices: [],
    products: [
      ...robots.map((r) => ({ id: r.config.productId, name: r.config.name, model: r.config.model, category: 'robot.vacuum.cleaner' })),
      { id: 'p-saros', name: 'Saros 10R', model: 'roborock.vacuum.a144', category: 'robot.vacuum.cleaner' },
    ],
  };
}

const scenes = [
  { id: 101, name: 'After dinner', enabled: true, type: 'WORKFLOW', deviceId: 'SimS8ProUltra01', param: '{}' },
  { id: 102, name: 'Kitchen twice', enabled: true, type: 'WORKFLOW', deviceId: 'SimS8ProUltra01', param: '{}' },
];
let runningScene: number | null = null;

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `https://127.0.0.1:${HTTPS_PORT}`);
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams);
  const body = req.method === 'POST' ? await readBody(req) : '';

  if (req.method === 'POST' && path === '/api/v5/auth/email/login/code') {
    const b = JSON.parse(body || '{}') as { email?: string; code?: string };
    if (b.code !== LOGIN_CODE) return json(res, 200, { code: 2018, msg: 'invalid code', data: null });
    const s = newSession();
    return json(res, 200, { code: 200, msg: 'success', data: { uid: s.uid, token: s.token, rruid: s.rruid, rriot: s.rriot, region: 'eu', nickname: b.email } });
  }
  if (req.method === 'GET' && path === '/api/v1/getHomeDetail') {
    if (!sessions.some((s) => s.token === req.headers.authorization)) return json(res, 200, { code: 2010, msg: 'invalid token', data: null });
    return json(res, 200, { code: 200, msg: 'success', data: { id: 1, name: 'Simulated home', rrHomeId: HOME_ID, tuyaHomeId: 0, deviceListOrder: [] } });
  }
  if (req.method === 'GET' && path === `/v3/user/homes/${HOME_ID}`) {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    return json(res, 200, { code: 200, msg: 'success', data: home() });
  }
  if (req.method === 'POST' && path === `/user/homes/${HOME_ID}/rooms`) {
    const form = Object.fromEntries(new URLSearchParams(body));
    if (!hawkOk(req, path, query, form)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const name = String(form['name'] ?? '').trim();
    let room = cloudRooms.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (!room) {
      room = { id: nextRoomId++, name };
      cloudRooms.push(room);
    }
    return json(res, 200, { code: 200, msg: 'success', data: room });
  }

  // What the server last heard from a robot (local_roborock_server #251); it has never heard from the unpaired one.
  const lastKnown = path.match(/^\/user\/devices\/([^/]+)\/last_known$/);
  if (req.method === 'GET' && lastKnown) {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const robot = robots.find((r) => r.config.duid === decodeURIComponent(lastKnown[1]!));
    if (!robot) return json(res, 200, { code: 200, msg: 'success', data: { duid: lastKnown[1], known: false } });
    const st = robot.status;
    return json(res, 200, { code: 200, msg: 'success', data: {
      duid: robot.config.duid, known: true, last_seen_at: new Date().toISOString(), offline_at: null,
      status: { state: st['state'], battery: st['battery'], error_code: st['error_code'], updated_at: new Date().toISOString() },
      position: null, has_map: false, map: null, rooms: [],
    } });
  }

  // Voice packs (local_roborock_server #261).
  if (req.method === 'GET' && path === '/voice-pkg/info') {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const base = `https://127.0.0.1:${HTTPS_PORT}/voice-pkg/files`;
    return json(res, 200, { voice_list: [
      { voice_id: 1, version: 1, lang: 'en', voice_title: 'English', voice_pkg_url: `${base}/en.pkg`, voice_pkg_md5: 'a'.repeat(32), voice_pri: 1, applicable: ['de', 'prc', 'us'] },
      { voice_id: 7, version: 3, lang: 'de', voice_title: 'Deutsch', voice_sub_title: 'Standard', voice_pkg_url: `${base}/de.pkg`, voice_pkg_md5: 'b'.repeat(32), voice_pri: 2, applicable: ['de'] },
      { voice_id: 9, version: 1, lang: 'ja', voice_title: '日本語', voice_pkg_url: `${base}/ja.pkg`, voice_pkg_md5: 'c'.repeat(32), voice_pri: 3, applicable: ['jp'] },
    ] });
  }

  // Firmware (local_roborock_server #255): one update for the S8.
  const otaCheck = path.match(/^\/ota\/firmware\/([^/]+)\/updatev2$/);
  if (req.method === 'GET' && otaCheck) {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const robot = robots.find((r) => r.config.duid === decodeURIComponent(otaCheck[1]!));
    if (!robot) return json(res, 404, { code: 404, msg: 'unknown device' });
    const latest = robot.config.duid === 'SimS8ProUltra01' ? '02.33.90' : robot.config.fv;
    return json(res, 200, { code: 200, msg: 'success', result: { version: latest, currentVersion: robot.config.fv, updatable: latest !== robot.config.fv, desc: 'Improves obstacle avoidance.', forceUpdate: false } });
  }
  const otaStart = path.match(/^\/ota\/device\/([^/]+)\/upgrade$/);
  if (req.method === 'POST' && otaStart) {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const robot = robots.find((r) => r.config.duid === decodeURIComponent(otaStart[1]!));
    if (!robot) return json(res, 200, { code: 404, msg: 'unknown device', data: { started: false } });
    robot.startOta('02.33.90');
    return json(res, 200, { code: 200, msg: 'success', data: { started: true, version: '02.33.90' } });
  }

  // Routines ("scenes"), as local_roborock_server keeps them; the run only tracks which one is going.
  const sceneList = path.match(/^\/user\/scene\/device\/([^/]+)$/);
  if (req.method === 'GET' && sceneList) {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const duid = decodeURIComponent(sceneList[1]!);
    return json(res, 200, { code: 200, msg: 'success', result: scenes.filter((s) => s.deviceId === duid) });
  }
  const sceneRun = path.match(/^\/user\/scene\/(\d+)\/execute$/);
  if (req.method === 'POST' && sceneRun) {
    if (!hawkOk(req, path, query, null)) return json(res, 401, { code: 401, msg: 'hawk check failed', data: null });
    const scene = scenes.find((s) => s.id === Number(sceneRun[1]));
    if (!scene) return json(res, 200, { code: 404, msg: 'scene not found', result: null });
    const active = scenes.find((s) => s.id === runningScene);
    if (active && active.id !== scene.id) {
      return json(res, 200, { code: 200, msg: 'success', result: { accepted: false, status: 'routine_in_progress', sceneName: scene.name, activeSceneName: active.name } });
    }
    const cancel = active?.id === scene.id;
    runningScene = cancel ? null : scene.id;
    return json(res, 200, { code: 200, msg: 'success', result: { accepted: true, status: cancel ? 'cancel_requested' : 'started', sceneName: scene.name } });
  }

  // Test hook: forget every session and drop MQTT clients, as a server restart does.
  if (req.method === 'POST' && path === '/sim/expire-sessions') {
    sessions.length = 0;
    const clients = (broker as unknown as { clients: Record<string, { close(): void }> }).clients;
    for (const client of Object.values(clients)) client.close();
    return json(res, 200, { ok: true });
  }

  // Admin API used by Add vacuum.
  if (req.method === 'POST' && path === '/admin/api/login') {
    const b = JSON.parse(body || '{}') as { password?: string };
    if (b.password !== ADMIN_PASSWORD) return json(res, 401, { ok: false });
    const c = randomHex(16);
    adminCookies.add(c);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `admin_session=${c}; HttpOnly; Path=/admin` });
  }
  if (req.method === 'GET' && path === '/admin/api/status') {
    return json(res, 200, { health: { services: [
      { name: 'https_server', enabled: true, running: true }, { name: 'mqtt_tls_proxy', enabled: true, running: true }, { name: 'mqtt_backend_broker', enabled: true, running: true },
    ] } });
  }
  if (path.startsWith('/admin/api/onboarding')) {
    const cookie = /admin_session=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!cookie || !adminCookies.has(cookie)) return json(res, 401, { ok: false });
    if (req.method === 'GET' && path === '/admin/api/onboarding/devices') {
      return json(res, 200, { devices: [{ duid: unpaired.duid, name: unpaired.name, connected: false, onboarding: { has_public_key: false } }] });
    }
    if (req.method === 'POST' && path === '/admin/api/onboarding/sessions') {
      const id = randomHex(8);
      onboardingSessions.set(id, { started: Date.now(), duid: (JSON.parse(body || '{}') as { duid: string }).duid });
      return json(res, 200, { session_id: id, status: 'waiting', connected: false, has_public_key: false, query_samples: 0 });
    }
    const m = /^\/admin\/api\/onboarding\/sessions\/(\w+)$/.exec(path);
    if (m) {
      const s = onboardingSessions.get(m[1]!);
      if (!s) return json(res, 404, { ok: false });
      if (req.method === 'DELETE') { onboardingSessions.delete(m[1]!); return json(res, 200, { ok: true }); }
      const age = (Date.now() - s.started) / 1000;
      return json(res, 200, {
        session_id: m[1], query_samples: Math.min(5, Math.floor(age / 5)), has_public_key: age > 20,
        public_key_state: age > 20 ? 'ready' : 'collecting', connected: age > 30, complete: age > 30,
        status: age > 30 ? 'complete' : 'in_progress', target: { duid: s.duid, name: unpaired.name },
      });
    }
  }
  json(res, 200, { ok: true });
}

createHttpsServer({ key: pems.private, cert: pems.cert } satisfies ServerOptions, (req, res) => {
  handleHttp(req, res).catch((e: Error) => json(res, 500, { code: 500, msg: e.message }));
}).listen(HTTPS_PORT, '127.0.0.1');

// ---- MQTT broker and robots ----

const broker = aedes.createBroker({
  maxClientsIdLength: 256,
  authenticate: (_client, username, password, done) => {
    const ok = sessions.some((s) => {
      const c = deriveMqttCreds(s.rriot);
      return c.username === username && c.password === password?.toString();
    });
    if (ok) return done(null, true);
    const err = Object.assign(new Error('invalid_mqtt_credentials'), { returnCode: 5 });
    done(err as Parameters<typeof done>[0], false);
  },
});
createTcpServer(broker.handle).listen(MQTT_PORT, '127.0.0.1');

/** Reply topics apps have used recently, per robot, for status pushes. */
const replyTopics = new Map<string, Set<string>>();

function publish(topic: string, payload: Buffer): void {
  broker.publish({ cmd: 'publish', topic, payload, qos: 0, retain: false, dup: false }, () => undefined);
}

function frame(robot: SimRobot, protocol: number, payload: Buffer): Buffer {
  return encodeMessage(robot.config.localKey, {
    protocol, payload, seq: Math.floor(Math.random() * 1e6), random: Math.floor(Math.random() * 1e5), timestamp: Math.floor(Date.now() / 1000),
  });
}

function rpcReply(robot: SimRobot, topic: string, id: number, reply: { result: unknown } | { error: unknown }): void {
  const inner = JSON.stringify({ id, ...reply });
  publish(topic, frame(robot, Protocol.RPC_RESPONSE, Buffer.from(JSON.stringify({ dps: { 102: inner }, t: Math.floor(Date.now() / 1000) }))));
}

const obstacleJpeg = readFileSync(fileURLToPath(new URL('../test/fixtures/sim_obstacle.jpg', import.meta.url)));
const patrolPng = readFileSync(fileURLToPath(new URL('../test/fixtures/sim_patrol.png', import.meta.url)));

/** A "ROBOROCK" blob header: request id at 8, header size at 16, body length at 20. */
function blobHeader(requestId: number, size: number, bodyLength: number): Buffer {
  const h = Buffer.alloc(size);
  h.write('ROBOROCK', 0, 'ascii');
  h.writeUInt32LE(requestId, 8);
  h.writeUInt16LE(size, 16);
  h.writeUInt32LE(bodyLength, 20);
  return h;
}

function photoBlock(type: number, data: Buffer): Buffer {
  const h = Buffer.alloc(8);
  h.writeUInt16LE(type, 0); h.writeUInt16LE(8, 2); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data]);
}

/** get_photo: a box and the JPEG, split like a full frame: the first part on protocol 300, the rest on 301. */
function photoReply(robot: SimRobot, topic: string, requestId: number): void {
  const box = Buffer.alloc(8);
  [50, 40, 110, 90].forEach((v, i) => box.writeUInt16LE(v, i * 2));
  const body = gzipSync(Buffer.concat([photoBlock(2, box), photoBlock(3, obstacleJpeg)]));
  const cut = Math.floor(body.length / 2);
  publish(topic, frame(robot, 300, Buffer.concat([blobHeader(requestId, 24, body.length), body.subarray(0, cut)])));
  setTimeout(() => publish(topic, frame(robot, Protocol.MAP_RESPONSE, body.subarray(cut))), 50);
}

/** get_patrol_photo with cipher_suite 1: two thumbnails, AES-CBC under a key wrapped to the request's RSA key. */
function patrolReply(robot: SimRobot, topic: string, requestId: number, pub: { n: string; e: string }): void {
  const rec = (x: number) => {
    const h = Buffer.alloc(16);
    h.writeUInt16LE(16, 0); h.writeUInt16LE(x, 2); h.writeUInt16LE(25_000, 4); h.writeUInt16LE(64, 6); h.writeUInt16LE(48, 8); h.writeUInt16LE(90, 10);
    h.writeUInt32LE(patrolPng.length, 12);
    return Buffer.concat([h, patrolPng]);
  };
  const plain = gzipSync(Buffer.concat([Buffer.alloc(12), rec(25_000), rec(25_100)]));
  const iv = randomBytes(16);
  const key = randomBytes(16);
  const c = createCipheriv('aes-128-cbc', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  const n = Buffer.from(pub.n.length % 2 ? `0${pub.n}` : pub.n, 'hex');
  const rsa = createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: Buffer.from(pub.e.length % 2 ? `0${pub.e}` : pub.e, 'hex').toString('base64url') }, format: 'jwk' });
  const wrapped = publicEncrypt({ key: rsa, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([iv, key]));
  const header = blobHeader(requestId, 184, body.length);
  wrapped.copy(header, 56);
  publish(topic, frame(robot, Protocol.MAP_RESPONSE, Buffer.concat([header, body])));
}

function mapReply(robot: SimRobot, topic: string, requestId: number, security: { endpoint: string; nonce: string }, cruise = false): void {
  const header = Buffer.alloc(24);
  header.write(security.endpoint.substring(0, 8), 0, 'latin1');
  header[16] = requestId & 0xff;
  header[17] = (requestId >>> 8) & 0xff;
  const body = aesCbcEncrypt(gzipSync(robot.mapBytes(cruise)), Buffer.from(security.nonce, 'hex'), Buffer.alloc(16));
  publish(topic, frame(robot, Protocol.MAP_RESPONSE, Buffer.concat([header, body])));
}

broker.on('publish', (packet, client) => {
  if (!client) return;
  const parts = packet.topic.split('/');
  if (parts.length !== 6 || parts[0] !== 'rr' || parts[1] !== 'm' || parts[2] !== 'i') return;
  const robot = robots.find((r) => r.config.duid === parts[5]);
  if (!robot) return;
  const replyTopic = `rr/m/o/${parts[3]}/${parts[4]}/${parts[5]}`;
  const topics = replyTopics.get(robot.config.duid) ?? new Set<string>();
  topics.add(replyTopic);
  replyTopics.set(robot.config.duid, topics);
  for (const m of decodeMessages(robot.config.localKey, packet.payload as Buffer)) {
    if (m.protocol !== Protocol.RPC_REQUEST) continue;
    const outer = JSON.parse(m.payload.toString()) as { dps: Record<string, string> };
    const req = JSON.parse(outer.dps['101']!) as { id: number; method: string; params: unknown; security?: { endpoint: string; nonce: string } };
    if (req.method === 'get_map_v1' && req.security) {
      setTimeout(() => mapReply(robot, replyTopic, req.id, req.security!), 300);
      continue;
    }
    // A past run's map: ["ok"], then the map as a frame for the request (the live map stands in).
    if (req.method === 'get_clean_record_map' && req.security) {
      const cruise = (req.params as Record<string, number>)['start_time'] === 1760300000;
      setTimeout(() => rpcReply(robot, replyTopic, req.id, { result: ['ok'] }), 60);
      setTimeout(() => mapReply(robot, replyTopic, req.id, req.security!, cruise), 400);
      continue;
    }
    if (req.method === 'get_random_pkey') {
      setTimeout(() => rpcReply(robot, replyTopic, req.id, { result: [{ pub_key: { e: '10001', n: 'c0ffee' } }] }), 40);
      continue;
    }
    if (req.method === 'get_photo' && req.security) {
      setTimeout(() => rpcReply(robot, replyTopic, req.id, { result: ['ok'] }), 40);
      setTimeout(() => photoReply(robot, replyTopic, req.id), 200);
      continue;
    }
    // Like a Curv 2 Flow: a plain get_patrol_photo gets no answer; cipher_suite 1 works.
    if (req.method === 'get_patrol_photo' && req.security) {
      const sec = (req.params as { security?: { cipher_suite?: number; pub_key?: { n: string; e: string } } }).security;
      if (sec?.cipher_suite !== 1 || !sec.pub_key) continue;
      const pub = sec.pub_key;
      setTimeout(() => rpcReply(robot, replyTopic, req.id, { result: ['ok'] }), 40);
      setTimeout(() => patrolReply(robot, replyTopic, req.id, pub), 200);
      continue;
    }
    robot.handle(req.method, req.params, (reply, delayMs = 60) => {
      setTimeout(() => rpcReply(robot, replyTopic, req.id, reply), delayMs);
    });
  }
});

for (const robot of robots) {
  robot.onStateChange = () => {
    const push = Buffer.from(JSON.stringify({ dps: { 121: robot.status['state'], 122: robot.status['battery'] }, t: Math.floor(Date.now() / 1000) }));
    for (const topic of replyTopics.get(robot.config.duid) ?? []) publish(topic, frame(robot, Protocol.RPC_RESPONSE, push));
  };
}
setInterval(() => robots.forEach((r) => r.tick()), 1_000);

console.log(`LocalRock simulator running.
  Server address  https://127.0.0.1:${HTTPS_PORT}  (turn on "Allow self-signed certificates")
  Login           any email, login code ${LOGIN_CODE}
  Admin password  ${ADMIN_PASSWORD}  (Add vacuum)
  MQTT broker     mqtt://127.0.0.1:${MQTT_PORT}`);
