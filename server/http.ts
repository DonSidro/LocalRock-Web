import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, Server } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/api.js';
import { App, toMapDto } from './app.js';
import { config, isLoopbackHost } from './config.js';
import { log } from './log.js';
import { SUPPORTED_TIMEZONES } from './onboarding/packets.js';
import { RobotCommandError, RobotSilentError, RobotTimeoutError, UserError, describeError } from './vacuum/errors.js';
import { runCall } from './vacuumCalls.js';
import { bool, obj, str } from './validate.js';

/*
 * HTTP API + WebSocket for the browser. Guards against other web pages driving the robot through
 * the user's browser: the Host header must name this server (when bound to loopback), state
 * changing requests must be JSON and same-origin, and the WebSocket checks the Origin too.
 */

const COOKIE = 'lrw_session';
const sessions = new Set<string>();

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.substring(0, eq).trim()] = decodeURIComponent(part.substring(eq + 1).trim());
  }
  return out;
}

function authenticated(req: IncomingMessage): boolean {
  if (!config.password) return true;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  return token !== undefined && sessions.has(token);
}

function passwordMatches(given: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(config.password ?? '').digest();
  return timingSafeEqual(a, b);
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Blocks DNS rebinding while bound to loopback; on the network the password protects instead. */
function hostAllowed(req: IncomingMessage): boolean {
  if (!isLoopbackHost(config.host)) return true;
  const h = hostnameOf(req.headers.host);
  if (!h) return false;
  return isLoopbackHost(h) || h === config.host.toLowerCase() || config.allowedHosts.includes(h);
}

/** A browser request from another site carries that site's Origin. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

function errorStatus(e: unknown): number {
  if (e instanceof UserError || e instanceof RobotCommandError) return 400;
  if (e instanceof RobotTimeoutError || e instanceof RobotSilentError) return 504;
  return 500;
}

function wrap(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    handler(req, res).then(
      (result) => { if (!res.headersSent) res.json({ ok: true, result: result ?? null }); },
      (e: unknown) => {
        const status = errorStatus(e);
        if (status === 500) log.error(`${req.method} ${req.path}: ${(e as Error)?.stack ?? String(e)}`);
        if (!res.headersSent) res.status(status).json({ ok: false, error: describeError(e) });
      },
    );
  };
}

export function createHttp(app: App) {
  const web = express();
  web.disable('x-powered-by');
  web.set('trust proxy', false);

  web.use((req, res, next) => {
    if (!hostAllowed(req)) {
      res.status(421).send('Unknown host name. Set LOCALROCK_ALLOWED_HOSTS to use this name.');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  web.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!sameOrigin(req)) {
        res.status(403).json({ ok: false, error: 'Cross-site request refused' });
        return;
      }
      if (!req.is('application/json')) {
        res.status(415).json({ ok: false, error: 'Expected JSON' });
        return;
      }
    }
    next();
  });
  web.use('/api', express.json({ limit: '2mb' }));

  // ---- Page password ----
  web.get('/api/auth', (req, res) => { res.json({ ok: true, result: { required: config.password !== null, signedIn: authenticated(req) } }); });
  web.post('/api/auth/login', wrap(async (req, res) => {
    const given = str(obj(req.body)['password'], 'password', 256);
    if (!config.password || !passwordMatches(given)) {
      await new Promise((r) => setTimeout(r, 500));
      throw new UserError('Wrong password');
    }
    const token = randomBytes(32).toString('hex');
    sessions.add(token);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return null;
  }));
  web.post('/api/auth/logout', wrap(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return null;
  }));
  web.use('/api', (req, res, next) => {
    if (authenticated(req)) return next();
    res.status(401).json({ ok: false, error: 'Sign in to LocalRock Web first' });
  });

  // ---- App ----
  web.get('/api/state', wrap(async () => ({ app: app.appState(), devices: app.devicesMessage() })));
  web.post('/api/server', wrap(async (req) => {
    const b = obj(req.body);
    app.setServer(str(b['url'], 'server address', 512), b['allowSelfSigned'] === undefined ? false : bool(b['allowSelfSigned'], 'self-signed setting'));
  }));
  web.post('/api/login', wrap(async (req) => {
    const b = obj(req.body);
    await app.login(str(b['email'], 'email', 256), str(b['code'], 'login code', 256));
  }));
  web.post('/api/logout', wrap(async () => { app.logout(); }));
  web.post('/api/devices/refresh', wrap(async () => { await app.refreshDevices(); }));
  web.post('/api/mqtt/retry', wrap(async () => { app.retryMqttNow(); }));
  web.post('/api/notify', wrap(async (req) => {
    const b = obj(req.body);
    const change: Record<string, boolean> = {};
    for (const key of ['enabled', 'errors', 'finished', 'dock'] as const) {
      if (b[key] !== undefined) change[key] = bool(b[key], key);
    }
    app.setNotify(change);
  }));

  // ---- Robots ----
  web.get('/api/vacuums/:duid', wrap(async (req) => {
    const repo = app.repository(req.params['duid']!);
    const map = repo.map();
    return { snapshot: repo.snapshot(), map: map ? toMapDto(map, repo.snapshot().mapVersion) : null };
  }));
  web.post('/api/vacuums/:duid/call', wrap(async (req) => {
    const b = obj(req.body);
    const name = str(b['name'], 'action', 64);
    const args = b['args'] === undefined ? {} : obj(b['args'], 'arguments');
    return runCall(app, req.params['duid']!, name, args);
  }));

  // ---- Add vacuum ----
  web.get('/api/onboarding', wrap(async () => ({ state: app.onboarding.current(), timezones: SUPPORTED_TIMEZONES, hasAdminPassword: app.store.get().adminPassword !== null })));
  web.post('/api/onboarding/devices', wrap(async (req) => {
    const b = obj(req.body);
    const password = b['adminPassword'] === undefined || b['adminPassword'] === '' ? app.store.get().adminPassword : str(b['adminPassword'], 'admin password', 256);
    if (!password) throw new UserError('Enter the admin password of your server');
    const devices = await app.onboarding.listDevices(password);
    app.store.update((s) => { s.adminPassword = password; });
    app.broadcastApp();
    return devices;
  }));
  web.post('/api/onboarding/prepare', wrap(async (req) => {
    const b = obj(req.body);
    const password = app.store.get().adminPassword;
    if (!password) throw new UserError('Load the vacuums with the admin password first');
    await app.onboarding.prepare(password, str(b['duid'], 'vacuum', 128));
  }));
  web.post('/api/onboarding/send', wrap(async (req) => {
    const b = obj(req.body);
    const tz = str(b['timezone'], 'timezone', 64);
    if (!SUPPORTED_TIMEZONES.includes(tz)) throw new UserError('Pick a timezone from the list');
    await app.onboarding.send(str(b['ssid'], 'Wi-Fi name', 64), str(b['password'], 'Wi-Fi password', 128), tz);
  }));
  web.post('/api/onboarding/cancel', wrap(async () => { app.onboarding.cancel(); }));

  web.use('/api', (_req, res) => { res.status(404).json({ ok: false, error: 'Not found' }); });

  // ---- The built page ----
  if (existsSync(join(config.webDir, 'index.html'))) {
    web.use(express.static(config.webDir, { index: 'index.html', maxAge: '1h', setHeaders: (res, path) => {
      if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    } }));
    web.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(join(config.webDir, 'index.html')); });
  } else {
    web.get('/', (_req, res) => {
      res.type('text/plain').send('LocalRock Web server is running. Build the page with "npm run build", or open the Vite dev server ("npm run dev").');
    });
  }

  return web;
}

export function attachWebSocket(server: Server, app: App): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/ws' || !hostAllowed(req) || !sameOrigin(req) || !authenticated(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const watching = new Set<string>();
    const sendMsg = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const onMessage = (msg: ServerMessage) => {
      if ((msg.t === 'vac' && !watching.has(msg.snapshot.duid)) || (msg.t === 'map' && !watching.has(msg.duid))) return;
      sendMsg(msg);
    };
    app.on('message', onMessage);
    sendMsg({ t: 'app', state: app.appState() });
    sendMsg(app.devicesMessage());

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null || typeof (msg as { duid?: unknown }).duid !== 'string') return;
      try {
        if (msg.t === 'watch' && !watching.has(msg.duid)) {
          const repo = app.repository(msg.duid);
          watching.add(msg.duid);
          repo.addWatcher();
          sendMsg({ t: 'vac', snapshot: repo.snapshot() });
          const map = repo.map();
          sendMsg({ t: 'map', duid: msg.duid, map: map ? toMapDto(map, repo.snapshot().mapVersion) : null });
        } else if (msg.t === 'unwatch' && watching.has(msg.duid)) {
          watching.delete(msg.duid);
          app.existingRepository(msg.duid)?.removeWatcher();
        }
      } catch (e) {
        log.debug(`WebSocket ${msg.t} ${msg.duid}: ${(e as Error).message}`);
      }
    });

    ws.on('close', () => {
      app.off('message', onMessage);
      for (const duid of watching) app.existingRepository(duid)?.removeWatcher();
      watching.clear();
    });
  });
}
