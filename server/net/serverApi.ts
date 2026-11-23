import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Rriot } from '../protocol/mqttCreds.js';
import { hawkAuthorizationHeader, isHawkPublicPath, newHawkNonce, type HawkCreds } from '../protocol/hawk.js';
import { UserError } from '../vacuum/errors.js';
import type { Routine } from '../../shared/api.js';
import { firmwareStartRefusal } from '../../shared/firmware.js';

/*
 * HTTPS calls to local_roborock_server, ported from LocalRock's LoginApi.kt, DeviceApi.kt,
 * OnboardingAdminApi.kt and HttpClientFactory.kt. Only the scheme, host and port of the configured
 * server address are used (every call has an absolute path), and http:// is upgraded to https://,
 * as the app does.
 */

export interface UserData {
  uid: number;
  token: string;
  rruid: string;
  rriot: Rriot;
  [key: string]: unknown;
}

export interface Room { id: number; name: string }

export interface Device {
  duid: string;
  name: string;
  localKey?: string | null;
  productId?: string | null;
  online?: boolean;
  featureSet?: string | null;
  newFeatureSet?: string | null;
  fv?: string | null;
  sn?: string | null;
  [key: string]: unknown;
}

export interface Product { id: string; name?: string | null; model?: string | null; [key: string]: unknown }

export interface Home {
  id: number;
  name: string;
  rooms?: Room[];
  devices?: Device[];
  receivedDevices?: Device[];
  products?: Product[];
}

/** The server answered with an error, or could not be reached. Shown to the user as it is. */
export class ApiError extends UserError {
  constructor(readonly responseCode: number, message: string) {
    super(message);
  }
}

/** The server refused the login code (as opposed to being unreachable). */
export class LoginRejectedError extends ApiError {}

export interface ServerTarget {
  baseUrl: string;
  allowSelfSigned: boolean;
  ca?: Buffer;
}

interface RawResponse {
  status: number;
  body: string;
  setCookie: string[];
}

/** Scheme/host/port of the configured address, upgraded to https. */
export function serverOrigin(baseUrl: string): URL {
  let u: URL;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    throw new UserError(`Not a valid server address: ${baseUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('The server address must start with http:// or https://');
  return new URL(`https://${u.host}`);
}

const REQUEST_TIMEOUT_MS = 20_000;

function send(
  target: ServerTarget,
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  body: string | null,
): Promise<RawResponse> {
  const origin = serverOrigin(target.baseUrl);
  const qs = new URLSearchParams(query).toString();
  const hostname = origin.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      method,
      hostname,
      port: origin.port ? Number(origin.port) : 443,
      path: qs ? `${path}?${qs}` : path,
      headers: {
        Accept: 'application/json',
        ...headers,
        ...(body !== null ? { 'Content-Length': Buffer.byteLength(body).toString() } : {}),
      },
      rejectUnauthorized: !target.allowSelfSigned,
      ...(target.ca ? { ca: target.ca } : {}),
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [] });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`The server did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`), { code: 'LR_TIMEOUT' })));
    req.on('error', (e) => reject(new ApiError(0, describeNetworkError(e))));
    if (body !== null) req.write(body);
    req.end();
  });
}

function describeNetworkError(e: Error & { code?: string }): string {
  switch (e.code) {
    case 'ECONNREFUSED': return 'The server refused the connection. Check the address and port.';
    case 'ENOTFOUND': return 'The server name could not be found. Check the address.';
    case 'ETIMEDOUT': return 'The server did not answer. Check the address and that this computer can reach it.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return "The server's certificate is not trusted. Use a trusted certificate, set LOCALROCK_CA_FILE, or allow self-signed certificates in Settings.";
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return "The server's certificate does not match its address.";
    default: return e.message;
  }
}

function parseJson(raw: RawResponse, what: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw.body) as unknown;
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(raw.status, `${what}: the server did not return JSON (HTTP ${raw.status})`);
}

/** GET /user/devices/{duid}/last_known, as the server answers it. */
export interface LastKnownRaw {
  known?: boolean;
  last_seen_at?: string | null;
  offline_at?: string | null;
  status?: { state?: number | null; battery?: number | null; error_code?: number | null } | null;
  position?: { robot?: { x?: number; y?: number } | null; charger?: { x?: number; y?: number } | null } | null;
  has_map?: boolean;
  /** Base64 of the last map the robot sent, in the same form a live map reply decodes to. */
  map?: string | null;
  rooms?: Array<{ segment?: number; iot_id?: string; tag?: number | null; name?: string | null }>;
}

export interface FirmwareUpdateInfo {
  /** Latest available version. */
  version: string | null;
  /** Version installed on the robot, per the cloud. */
  currentVersion: string | null;
  /** True when version is newer than currentVersion and can be applied. */
  updatable: boolean;
  /** Release notes. */
  desc: string | null;
  /** Mandatory update the robot applies regardless. */
  forceUpdate: boolean;
}

export interface SceneRunResult {
  accepted: boolean;
  status: string | null;
  activeSceneName: string | null;
}

/** What to tell the user once the server has answered a run request; a refusal is thrown. */
export function routineRunMessage(name: string, result: SceneRunResult): string {
  if (!result.accepted) {
    const active = result.activeSceneName;
    throw new ApiError(409, result.status === 'routine_in_progress' && active !== null
      ? `"${active}" is still running. Run it again to stop it first.`
      : `The server did not start "${name}"${result.status ? ` (${result.status})` : ''}`);
  }
  return result.status === 'cancel_requested' ? `Stopping "${name}"` : `"${name}" started`;
}

function checkCode(json: Record<string, unknown>, raw: RawResponse, what: string): void {
  const code = typeof json['code'] === 'number' ? json['code'] : 200;
  if (code !== 200) throw new ApiError(code, `${what} failed: ${typeof json['msg'] === 'string' && json['msg'] ? json['msg'] : `HTTP ${raw.status}`}`);
}

/** {code, msg, data}: code 200 is success. */
function apiData<T>(raw: RawResponse, what: string, errorType: typeof ApiError = ApiError): T {
  const json = parseJson(raw, what);
  const code = typeof json['code'] === 'number' ? json['code'] : raw.status;
  if (code !== 200) {
    const msg = typeof json['msg'] === 'string' && json['msg'] ? json['msg'] : `HTTP ${raw.status}`;
    throw new errorType(code, `${what} failed: ${msg}`);
  }
  return json['data'] as T;
}

export class ServerApi {
  constructor(private readonly target: () => ServerTarget, private readonly hawk: () => HawkCreds | null) {}

  private async call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {},
  ): Promise<RawResponse> {
    const query = opts.query ?? {};
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: string | null = null;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    } else if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    if (!isHawkPublicPath(path)) {
      const creds = this.hawk();
      if (creds) {
        if (opts.json !== undefined) throw new Error('Hawk signing supports GETs and form POSTs only');
        headers['Authorization'] = hawkAuthorizationHeader(creds, path, Math.floor(Date.now() / 1000), newHawkNonce(), query, opts.form ?? null);
      }
    }
    return send(this.target(), method, path, query, headers, body);
  }

  async login(email: string, code: string): Promise<UserData> {
    const raw = await this.call('POST', '/api/v5/auth/email/login/code', { json: { email, code } });
    const data = apiData<UserData>(raw, 'Sign in', LoginRejectedError);
    if (!data || typeof data !== 'object' || !data.rriot || !data.token) throw new ApiError(raw.status, 'Sign in: the server returned no session');
    return data;
  }

  async homeId(token: string): Promise<number> {
    const raw = await this.call('GET', '/api/v1/getHomeDetail', { headers: { Authorization: token } });
    const d = apiData<Record<string, unknown>>(raw, 'Read home');
    const id = (d?.['rrHomeId'] ?? d?.['id'] ?? d?.['homeId']) as number | undefined;
    if (typeof id !== 'number') throw new ApiError(raw.status, 'Server did not return a home id');
    return id;
  }

  async home(homeId: number): Promise<Home> {
    const raw = await this.call('GET', `/v3/user/homes/${homeId}`);
    return apiData<Home>(raw, 'Read home data');
  }

  /** Create a cloud room, or get the existing one with the same name (matched case-insensitively). */
  /** The routines saved for one robot; local_roborock_server answers them in `result` (or `data`). */
  async scenes(duid: string): Promise<Routine[]> {
    const raw = await this.call('GET', `/user/scene/device/${encodeURIComponent(duid)}`);
    if (raw.status < 200 || raw.status >= 300) throw new ApiError(raw.status, `Routines unavailable (HTTP ${raw.status})`);
    const json = parseJson(raw, 'Routines');
    checkCode(json, raw, 'Routines');
    const list = (json['result'] ?? json['data']) as unknown;
    if (!Array.isArray(list)) return [];
    const out: Routine[] = [];
    for (const s of list) {
      if (typeof s !== 'object' || s === null) continue;
      const o = s as Record<string, unknown>;
      if (typeof o['id'] !== 'number' || typeof o['name'] !== 'string') continue;
      out.push({ id: o['id'], name: o['name'], enabled: o['enabled'] !== false });
    }
    return out;
  }

  /** Runs a routine. Running the one already going stops it ("cancel_requested"); another on the same robot blocks it ("routine_in_progress"). */
  async executeScene(id: number): Promise<SceneRunResult> {
    const raw = await this.call('POST', `/user/scene/${id}/execute`);
    if (raw.status < 200 || raw.status >= 300) throw new ApiError(raw.status, `The server could not run the routine (HTTP ${raw.status})`);
    const json = parseJson(raw, 'Run routine');
    checkCode(json, raw, 'Run routine');
    const r = (json['result'] ?? json['data']) as Record<string, unknown> | undefined;
    const text = (k: string) => (r && typeof r[k] === 'string' ? r[k] as string : null);
    return { accepted: r?.['accepted'] !== false, status: text('status'), activeSceneName: text('activeSceneName') };
  }

  /**
   * What the server last heard from a robot (local_roborock_server #251), with its last map when
   * includeMap. A server without it answers an error, which callers treat as "nothing known".
   */
  async lastKnown(duid: string, includeMap: boolean): Promise<LastKnownRaw> {
    const raw = await this.call('GET', `/user/devices/${encodeURIComponent(duid)}/last_known`, { query: includeMap ? { map: '1' } : {} });
    return apiData<LastKnownRaw>(raw, 'Last known state') ?? { known: false };
  }

  /** The update check (local_roborock_server #255): the server asks Roborock's cloud on the robot's behalf. */
  async checkFirmwareUpdate(duid: string): Promise<FirmwareUpdateInfo | null> {
    const raw = await this.call('GET', `/ota/firmware/${encodeURIComponent(duid)}/updatev2`, { query: { lang: 'en' }, headers: { Accept: 'application/json' } });
    if (raw.status < 200 || raw.status >= 300) throw new ApiError(raw.status, `Firmware check unavailable (HTTP ${raw.status})`);
    const r = parseJson(raw, 'Firmware check')['result'];
    if (typeof r !== 'object' || r === null) return null;
    const o = r as Record<string, unknown>;
    const text = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? o[k] as string : null);
    return { version: text('version'), currentVersion: text('currentVersion'), updatable: o['updatable'] === true, desc: text('desc'), forceUpdate: o['forceUpdate'] === true };
  }

  /** The Update button: asks the server to install the version the cloud offers. */
  async startFirmwareUpdate(duid: string): Promise<{ started: boolean; version: string | null; reason: string | null }> {
    const raw = await this.call('POST', `/ota/device/${encodeURIComponent(duid)}/upgrade`, { headers: { Accept: 'application/json' } });
    if (raw.status < 200 || raw.status >= 300) throw new ApiError(raw.status, firmwareStartRefusal(raw.status));
    const root = parseJson(raw, 'Firmware update');
    const data = (root['data'] ?? root['result']) as Record<string, unknown> | undefined;
    const text = (k: string) => (data && data[k] !== undefined && data[k] !== null && String(data[k]).trim() ? String(data[k]) : null);
    const started = data?.['started'] === true || data?.['started'] === 'true';
    // The server answers its own refusals with HTTP 200 and the status in `code`; a body 404 names an unknown robot.
    const code = typeof root['code'] === 'number' ? root['code'] : null;
    const message = !started && code === 501 ? firmwareStartRefusal(501) : text('reason') ?? text('error') ?? (typeof root['msg'] === 'string' ? root['msg'] : null);
    return { started, version: text('version'), reason: started ? null : message };
  }

  async createRoom(homeId: number, name: string): Promise<Room> {
    const raw = await this.call('POST', `/user/homes/${homeId}/rooms`, { form: { name } });
    return apiData<Room>(raw, 'Create room');
  }

  // ---- Admin API (cookie session), used to pair a new vacuum ----

  private adminCookies = new Map<string, string>();

  private cookieHeader(): Record<string, string> {
    if (this.adminCookies.size === 0) return {};
    return { Cookie: [...this.adminCookies].map(([k, v]) => `${k}=${v}`).join('; ') };
  }

  private keepCookies(raw: RawResponse): void {
    for (const c of raw.setCookie) {
      const first = c.split(';')[0]!;
      const eq = first.indexOf('=');
      if (eq > 0) this.adminCookies.set(first.substring(0, eq).trim(), first.substring(eq + 1).trim());
    }
  }

  private async admin(method: 'GET' | 'POST' | 'DELETE', path: string, what: string, json?: unknown): Promise<Record<string, unknown>> {
    const raw = await send(this.target(), method, path, {}, {
      ...this.cookieHeader(),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    }, json !== undefined ? JSON.stringify(json) : null);
    this.keepCookies(raw);
    if (raw.status === 401) throw new ApiError(401, `${what} failed: not signed in to the admin API (log in again)`);
    if (raw.status < 200 || raw.status >= 300) throw new ApiError(raw.status, `${what} failed (HTTP ${raw.status})`);
    if (method === 'DELETE') return {};
    return parseJson(raw, what);
  }

  async adminLogin(password: string): Promise<void> {
    this.adminCookies.clear();
    const raw = await send(this.target(), 'POST', '/admin/api/login', {}, { 'Content-Type': 'application/json' }, JSON.stringify({ password }));
    this.keepCookies(raw);
    if (raw.status === 401) throw new ApiError(401, 'Invalid admin password');
    if (raw.status < 200 || raw.status >= 300) throw new ApiError(raw.status, `Admin login failed (HTTP ${raw.status})`);
  }

  /**
   * Names of the stack services that are not running, or empty when the stack can take a vacuum. A server
   * without the status endpoint (older) is not checked.
   */
  async stackProblems(): Promise<string[]> {
    let r: Record<string, unknown>;
    try {
      r = await this.admin('GET', '/admin/api/status', 'Read server status');
    } catch (e) {
      if (e instanceof ApiError && e.responseCode === 404) return [];
      throw e;
    }
    const services = (r['health'] as Record<string, unknown> | undefined)?.['services'];
    if (!Array.isArray(services)) return ['the server did not report its service health'];
    return ['https_server', 'mqtt_tls_proxy', 'mqtt_backend_broker'].flatMap((name) => {
      const s = services.find((x) => typeof x === 'object' && x !== null && (x as Record<string, unknown>)['name'] === name) as Record<string, unknown> | undefined;
      if (!s) return [`${name} is missing`];
      if (s['enabled'] === false) return [`${name} is disabled`];
      if (s['running'] !== true) return [`${name} is not running${typeof s['detail'] === 'string' && s['detail'] ? ` (${s['detail']})` : ''}`];
      return [];
    });
  }

  async onboardingDevices(): Promise<unknown[]> {
    const r = await this.admin('GET', '/admin/api/onboarding/devices', 'List vacuums');
    return Array.isArray(r['devices']) ? r['devices'] : [];
  }

  startOnboardingSession(duid: string): Promise<Record<string, unknown>> {
    return this.admin('POST', '/admin/api/onboarding/sessions', 'Start onboarding session', { duid });
  }

  onboardingSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.admin('GET', `/admin/api/onboarding/sessions/${encodeURIComponent(sessionId)}`, 'Read onboarding session');
  }

  async deleteOnboardingSession(sessionId: string): Promise<void> {
    await this.admin('DELETE', `/admin/api/onboarding/sessions/${encodeURIComponent(sessionId)}`, 'Delete onboarding session');
  }
}
