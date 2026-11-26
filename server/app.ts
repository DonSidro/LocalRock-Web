import { EventEmitter } from 'node:events';
import { productDisplayName } from '../shared/products.js';
import { ROOM_TYPES, isSmartPlanSupported, isWaterSlideSupported, roomNameProblem } from '../shared/codes.js';
import type { AppState, DeviceSummary, MapDto, Reachability, RobotAlert, Routine, ServerMessage, VacuumSnapshot } from '../shared/api.js';
import type { ParsedMap } from '../shared/map.js';
import { config } from './config.js';
import { log } from './log.js';
import { MqttLink } from './net/mqttLink.js';
import { LoginRejectedError, ServerApi, routineRunMessage, type LastKnownRaw, type Device, type Home, type Product, type UserData } from './net/serverApi.js';
import { Onboarding } from './onboarding/onboarding.js';
import { deriveMqttCreds, mqttTopicsFor } from './protocol/mqttCreds.js';
import type { HawkCreds } from './protocol/hawk.js';
import { Store } from './store.js';
import { MapEditError, UserError } from './vacuum/errors.js';
import { VacuumRepository } from './vacuum/repository.js';
import { VacuumSession } from './vacuum/session.js';

/*
 * Everything the server holds, ported from LocalRock's AppContainer.kt, AuthRepository.kt and
 * DeviceRepository.kt: the login session, the MQTT link, the device list with reachability, and
 * one VacuumRepository per robot. Changes are broadcast as ServerMessages.
 */

const PROBE_ATTEMPTS = 2;
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_LINK_WAIT_MS = 5_000;

/**
 * The robots in the order the list shows them: by name, ignoring case, with numbers in a name compared
 * as numbers so "Robot 2" comes before "Robot 10". The server returns them in pairing order, which puts
 * a newly paired robot last whatever it is called. Equal names keep a stable order by device id.
 */
export function sortedForList<T extends { name: string; duid: string }>(devices: T[]): T[] {
  return [...devices].sort((a, b) => naturalCompare(a.name, b.name) || (a.duid < b.duid ? -1 : a.duid > b.duid ? 1 : 0));
}

export function naturalCompare(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (digit(x[i]) && digit(y[j])) {
      const si = i;
      const sj = j;
      while (digit(x[i])) i++;
      while (digit(y[j])) j++;
      const nx = x.slice(si, i).replace(/^0+/, '');
      const ny = y.slice(sj, j).replace(/^0+/, '');
      if (nx.length !== ny.length) return nx.length - ny.length;
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      if (x[i] !== y[j]) return x.charCodeAt(i) - y.charCodeAt(j);
      i++;
      j++;
    }
  }
  return (x.length - i) - (y.length - j);
}

export class App extends EventEmitter {
  readonly store: Store;
  readonly api: ServerApi;
  readonly link = new MqttLink();
  readonly onboarding: Onboarding;

  private home: Home | null = null;
  private devices: Device[] = [];
  private products = new Map<string, Product>();
  private reachability = new Map<string, Reachability>();
  private devicesError: string | null = null;
  private refreshing = false;
  private sessionProblem: string | null = null;
  private readonly repos = new Map<string, VacuumRepository>();

  constructor() {
    super();
    this.setMaxListeners(100);
    this.store = new Store(config.dataDir);
    this.api = new ServerApi(
      () => ({ baseUrl: this.requireServerUrl(), allowSelfSigned: this.store.get().allowSelfSigned, ...(config.ca ? { ca: config.ca } : {}) }),
      () => this.hawkCreds(),
    );
    this.onboarding = new Onboarding(this.api, () => this.store.get().serverBaseUrl, () => this.emit('onboarding'));
    this.link.on('connected', (up: boolean) => {
      if (up) this.sessionProblem = null;
      this.broadcastApp();
    });
    this.link.credentialRefresher = (attempt, error) => this.refreshMqttCredentials(attempt, error);
    if (this.store.get().userData) {
      this.startMqtt();
      void this.refreshDevices();
    }
  }

  // ---- Broadcasting --------------------------------------------------------------------------

  private send(msg: ServerMessage): void {
    this.emit('message', msg);
  }

  appState(): AppState {
    const s = this.store.get();
    return {
      serverBaseUrl: s.serverBaseUrl,
      allowSelfSigned: s.allowSelfSigned,
      signedIn: s.userData !== null,
      email: s.loginEmail,
      canReLogin: s.loginEmail !== null && s.loginCode !== null,
      mqttConnected: this.link.connected,
      mqttStarted: this.link.isRunning,
      sessionProblem: this.sessionProblem,
      notify: { ...s.notify },
      hasAdminPassword: s.adminPassword !== null,
      homeName: this.home?.name ?? null,
    };
  }

  broadcastApp(): void {
    this.send({ t: 'app', state: this.appState() });
  }

  deviceSummaries(): DeviceSummary[] {
    return sortedForList(this.devices).map((d) => {
      const reach = this.reachability.get(d.duid) ?? null;
      return {
        duid: d.duid,
        name: d.name,
        model: this.products.get(d.duid)?.model ?? null,
        modelName: productDisplayName(this.products.get(d.duid)),
        paired: !!d.localKey,
        unpaired: this.isUnpaired(d.duid, !!d.localKey, reach),
        online: reach === 'ONLINE' ? true : reach === 'OFFLINE' || reach === 'CHECKING' ? false : d.online === true,
        reachability: reach,
      };
    });
  }

  private broadcastDevices(): void {
    this.send({ t: 'devices', devices: this.deviceSummaries(), error: this.devicesError, refreshing: this.refreshing });
  }

  devicesMessage(): ServerMessage {
    return { t: 'devices', devices: this.deviceSummaries(), error: this.devicesError, refreshing: this.refreshing };
  }

  // ---- Server and session --------------------------------------------------------------------

  private requireServerUrl(): string {
    const url = this.store.get().serverBaseUrl;
    if (!url) throw new UserError('Set the server address first');
    return url;
  }

  private hawkCreds(): HawkCreds | null {
    const r = this.store.get().userData?.rriot;
    return r ? { id: r.u, session: r.s, key: r.h } : null;
  }

  setServer(url: string, allowSelfSigned: boolean): void {
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) throw new UserError('Start the address with http:// or https://');
    try { new URL(trimmed); } catch { throw new UserError('That is not a valid address'); }
    const changed = trimmed !== this.store.get().serverBaseUrl;
    this.store.update((s) => { s.serverBaseUrl = trimmed; s.allowSelfSigned = allowSelfSigned; });
    if (changed && this.store.get().userData) this.logout();
    this.broadcastApp();
  }

  async login(email: string, code: string): Promise<void> {
    const data = await this.api.login(email.trim(), code.trim());
    this.store.update((s) => { s.userData = data; s.loginEmail = email.trim(); s.loginCode = code.trim(); });
    this.sessionProblem = null;
    this.restartMqtt();
    this.broadcastApp();
    await this.refreshDevices();
  }

  logout(): void {
    this.store.update((s) => { s.userData = null; s.loginEmail = null; s.loginCode = null; });
    this.link.stop();
    for (const repo of this.repos.values()) repo.dispose();
    this.repos.clear();
    this.home = null;
    this.devices = [];
    this.products.clear();
    this.reachability.clear();
    this.devicesError = null;
    this.broadcastApp();
    this.broadcastDevices();
  }

  /** Sign in again with the stored login code; the server expires sessions and MQTT logins with them. */
  private async reLogin(): Promise<UserData | null> {
    const s = this.store.get();
    if (!s.loginEmail || !s.loginCode) return null;
    try {
      const data = await this.api.login(s.loginEmail, s.loginCode);
      this.store.update((st) => { st.userData = data; });
      log.info('Signed in again with the stored login code');
      return data;
    } catch (e) {
      if (e instanceof LoginRejectedError) {
        log.warn(`Silent re-login rejected: ${e.message}`);
        this.store.update((st) => { st.loginEmail = null; st.loginCode = null; });
      } else {
        log.warn(`Silent re-login failed: ${(e as Error).message}`);
      }
      return null;
    }
  }

  private async refreshMqttCredentials(attempt: number, error: string | null) {
    const s = this.store.get();
    if (!s.loginEmail || !s.loginCode) {
      this.sessionProblem = 'Session expired: sign out and sign in again to reconnect.';
      this.broadcastApp();
      return null;
    }
    log.info(`MQTT failed ${attempt} times (${error ?? 'unknown'}), signing in again`);
    const fresh = await this.reLogin();
    return fresh ? deriveMqttCreds(fresh.rriot) : null;
  }

  private startMqtt(): void {
    const ud = this.store.get().userData;
    if (!ud || this.link.isRunning) return;
    try {
      this.link.start({
        creds: deriveMqttCreds(ud.rriot),
        clientId: `localrockweb-${ud.rruid}-${this.store.get().installId}`,
        rejectUnauthorized: !this.store.get().allowSelfSigned,
        ...(config.ca ? { ca: config.ca } : {}),
      });
    } catch (e) {
      this.sessionProblem = (e as Error).message;
      log.error(`MQTT not started: ${(e as Error).message}`);
    }
    this.broadcastApp();
  }

  private restartMqtt(): void {
    // Topics of live sessions follow the session; the link must use its credentials.
    for (const repo of this.repos.values()) repo.dispose();
    this.repos.clear();
    this.link.stop();
    this.startMqtt();
  }

  retryMqttNow(): void {
    this.link.retryNow();
  }

  // ---- Devices -------------------------------------------------------------------------------

  async refreshDevices(): Promise<void> {
    const ud = this.store.get().userData;
    if (!ud) return;
    this.refreshing = true;
    this.devicesError = null;
    this.broadcastDevices();
    try {
      const homeId = await this.api.homeId(ud.token);
      const home = await this.api.home(homeId);
      this.home = home;
      // Like the app: the home's own devices.
      this.devices = home.devices ?? [];
      const productsById = new Map((home.products ?? []).map((p) => [p.id, p]));
      this.products = new Map(this.devices.flatMap((d) => {
        const p = d.productId ? productsById.get(d.productId) : undefined;
        return p ? [[d.duid, p] as [string, Product]] : [];
      }));
      for (const repo of this.repos.values()) repo.setHomeRooms(home.rooms ?? []);
      this.syncAlertWatch();
      this.broadcastApp();
    } catch (e) {
      this.devicesError = (e as Error).message || 'Failed to load devices';
    } finally {
      this.refreshing = false;
      this.broadcastDevices();
    }
    void this.probeReachability();
    void this.refreshNeverHeard();
  }

  /** Ask every paired robot directly; the server's online flag can't be trusted with one robot. */
  /** Robots the server has never heard from (local_roborock_server #251); empty on a server without it. */
  private neverHeard = new Set<string>();
  private neverHeardRun = 0;

  private async refreshNeverHeard(): Promise<void> {
    const run = ++this.neverHeardRun;
    const never = new Set<string>();
    await Promise.all(this.devices.map(async (d) => {
      try {
        if (!(await this.api.lastKnown(d.duid, false)).known) never.add(d.duid);
      } catch {
        // An older server: nothing is marked.
      }
    }));
    if (run !== this.neverHeardRun) return;
    this.neverHeard = never;
    this.broadcastDevices();
  }

  /** A never-heard robot we probe (it has a local key) is unpaired only once the probe says offline; others unless reported online. */
  private isUnpaired(duid: string, probed: boolean, reach: Reachability | null): boolean {
    if (!this.neverHeard.has(duid)) return false;
    return probed ? reach === 'OFFLINE' : reach !== 'ONLINE';
  }

  /** What the server last heard from a robot, or null when it knows nothing or can't say. */
  async lastKnown(duid: string, includeMap: boolean): Promise<LastKnownRaw | null> {
    try {
      const k = await this.api.lastKnown(duid, includeMap);
      return k.known ? k : null;
    } catch {
      return null;
    }
  }

  private async probeReachability(): Promise<void> {
    const targets = this.devices.filter((d) => d.localKey);
    for (const d of targets) {
      const known = this.reachability.get(d.duid);
      this.reachability.set(d.duid, known && known !== 'CHECKING' ? known : 'CHECKING');
    }
    this.broadcastDevices();
    await Promise.all(targets.map(async (d) => {
      let verdict: Reachability | null;
      try {
        verdict = (await this.probe(d)) ? 'ONLINE' : 'OFFLINE';
      } catch (e) {
        log.debug(`Reachability probe for ${d.duid} could not run: ${(e as Error).message}`);
        verdict = null;
      }
      if (verdict) this.reachability.set(d.duid, verdict); else this.reachability.delete(d.duid);
      this.broadcastDevices();
    }));
  }

  private async probe(device: Device): Promise<boolean> {
    this.startMqtt();
    const repo = this.repository(device.duid);
    const deadline = Date.now() + PROBE_LINK_WAIT_MS;
    while (!this.link.connected) {
      if (Date.now() > deadline) throw new Error('MQTT link is down');
      await new Promise((r) => setTimeout(r, 250));
    }
    // Asked twice: the first request can go out before the broker has the subscription.
    for (let i = 0; i < PROBE_ATTEMPTS; i++) {
      if (await repo.probe(PROBE_TIMEOUT_MS)) return true;
    }
    return false;
  }

  /** Robot with this duid that can be controlled, or an error saying why not. */
  private device(duid: string): Device {
    const d = this.devices.find((x) => x.duid === duid);
    if (!d) throw new MapEditError('Unknown robot. Reload the device list.');
    if (!d.localKey) throw new MapEditError('This robot has no local key yet. Re-run pairing on your server to control it.');
    return d;
  }

  repository(duid: string): VacuumRepository {
    const existing = this.repos.get(duid);
    if (existing) return existing;
    const d = this.device(duid);
    const ud = this.store.get().userData;
    if (!ud) throw new MapEditError('Not signed in');
    const topics = () => {
      const current = this.store.get().userData ?? ud;
      return mqttTopicsFor(current.rriot.u, deriveMqttCreds(current.rriot).username, duid);
    };
    const session = new VacuumSession(d.localKey!, this.link, topics);
    const product = this.products.get(duid);
    const repo = new VacuumRepository({
      duid,
      name: d.name,
      model: product?.model ?? null,
      modelName: productDisplayName(product),
      firmware: d.fv ?? null,
      featureSet: d.featureSet ?? null,
      newFeatureSet: d.newFeatureSet ?? null,
      supportsSmartPlan: isSmartPlanSupported(d.newFeatureSet),
      supportsWaterSlide: isWaterSlideSupported(d.newFeatureSet),
    }, {
      session,
      link: this.link,
      rriotKey: () => (this.store.get().userData ?? ud).rriot.k,
      cleanOrder: (mapFlag) => this.store.cleanOrder(duid, mapFlag),
      lastKnown: (includeMap) => this.lastKnown(duid, includeMap),
      voicePackages: () => this.api.voicePackages(product?.model ?? ''),
      firmware: {
        check: () => this.api.checkFirmwareUpdate(duid),
        start: () => this.api.startFirmwareUpdate(duid),
      },
    });
    repo.setHomeRooms(this.home?.rooms ?? []);
    repo.on('change', (snapshot: VacuumSnapshot) => this.send({ t: 'vac', snapshot }));
    repo.on('map', (map: ParsedMap | null, version: number) => this.send({ t: 'map', duid, map: map ? toMapDto(map, version) : null }));
    repo.on('alert', (alert: RobotAlert) => this.onAlert(alert));
    this.repos.set(duid, repo);
    repo.setAlertsWanted(this.alertsWanted());
    return repo;
  }

  existingRepository(duid: string): VacuumRepository | undefined {
    return this.repos.get(duid);
  }

  // ---- Alerts --------------------------------------------------------------------------------

  private alertsWanted(): boolean {
    return this.store.get().notify.enabled && this.store.get().userData !== null;
  }

  private syncAlertWatch(): void {
    const wanted = this.alertsWanted();
    for (const d of this.devices) {
      if (!d.localKey) continue;
      if (wanted) this.repository(d.duid).setAlertsWanted(true);
      else this.repos.get(d.duid)?.setAlertsWanted(false);
    }
  }

  setNotify(change: Partial<AppState['notify']>): void {
    this.store.update((s) => { s.notify = { ...s.notify, ...change }; });
    this.syncAlertWatch();
    this.broadcastApp();
  }

  private onAlert(alert: RobotAlert): void {
    const n = this.store.get().notify;
    const wanted = alert.kind === 'finished' ? n.finished : alert.kind === 'dock' ? n.dock : n.errors;
    if (!n.enabled || !wanted) return;
    this.send({ t: 'alert', alert });
  }

  // ---- Room names ----------------------------------------------------------------------------

  /** Rename a room the way the Roborock app does: cloud room by name, then point the segment at it. */
  async renameRoom(duid: string, segment: number, name: string): Promise<void> {
    const problem = roomNameProblem(name);
    if (problem) throw new MapEditError(problem);
    const homeId = this.home?.id;
    if (homeId === undefined) throw new MapEditError('Home not loaded');
    const repo = this.repository(duid);
    await repo.checkRoomTable(segment);
    const room = await this.api.createRoom(homeId, name.trim());
    await repo.assignRoom(segment, Number(room.id));
    await this.refreshDevices();
    repo.setHomeRooms(this.home?.rooms ?? []);
  }

  /**
   * Set a room's type the way the Roborock app does: get a cloud room for the type's label, point the
   * robot's segment at it with name_segment along with the type's tag (which the robot uses to adjust
   * its cleaning), then reload the home so the name resolves.
   */
  async setRoomType(duid: string, segment: number, tag: number): Promise<void> {
    const type = ROOM_TYPES.find((t) => t.tag === tag);
    if (!type) throw new MapEditError('Unknown room type');
    const homeId = this.home?.id;
    if (homeId === undefined) throw new MapEditError('Home not loaded');
    const repo = this.repository(duid);
    await repo.checkRoomTable(segment);
    const room = await this.api.createRoom(homeId, type.label);
    await repo.assignRoom(segment, Number(room.id), type.tag);
    await this.refreshDevices();
    repo.setHomeRooms(this.home?.rooms ?? []);
  }

  /** The routines saved for one robot, in the order the server keeps them. */
  routines(duid: string): Promise<Routine[]> {
    return this.api.scenes(duid);
  }

  /** Asks the server to run a routine; the server sends the robot each step itself. Returns what to tell the user. */
  async runRoutine(id: number, name: string): Promise<string> {
    return routineRunMessage(name, await this.api.executeScene(id));
  }
}

export function toMapDto(map: ParsedMap, version: number): MapDto {
  const b64 = (a: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  return {
    version,
    width: map.width,
    height: map.height,
    // A legacy map's grid follows from its raw pixels, so only those are sent.
    grid: map.originalGrid ? '' : b64(map.grid),
    originalGrid: map.originalGrid ? b64(map.originalGrid) : null,
    rooms: map.rooms,
    resolution: map.resolution,
    pixelOffsetLeft: map.pixelOffsetLeft,
    pixelOffsetTop: map.pixelOffsetTop,
    chargerMm: map.chargerMm,
    robotMm: map.robotMm,
    pathMm: map.pathMm.map((p) => [p.x, p.y]),
    noGoZones: map.noGoZones,
    noMopZones: map.noMopZones,
    virtualWalls: map.virtualWalls,
    segmentMaterials: map.segmentMaterials,
    segmentMaterialDirections: map.segmentMaterialDirections,
    unmodeledRestrictionBlocks: map.unmodeledRestrictionBlocks,
    format: map.format,
    carpetAreas: map.carpetAreas,
    carpetFlagsPresent: map.carpetFlagsPresent,
    thresholds: map.thresholds,
    obstacles: map.obstacles,
    patrolPoints: map.patrolPoints,
    patrolTaskId: map.patrolTaskId,
    pathFlags: map.pathFlags,
    carpetMask: map.carpetMask ? b64(map.carpetMask) : null,
    zoneLines: map.zoneLines,
    eraserZones: map.eraserZones,
    furnitureBlocks: map.furnitureBlocks,
  };
}
