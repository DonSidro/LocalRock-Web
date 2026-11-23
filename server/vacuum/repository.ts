import { EventEmitter } from 'node:events';
import {
  ACTIVE_STATES, CLEANING_STATES, LAB_STATUS_MAP_SAVING, LAB_STATUS_MULTI_LEVEL, STATUS_FIELDS, State,
  SWITCH_MAP_MODE_MANUAL, SWITCH_MAP_MODE_SMART, UNSAVED_MAP_FLAG, describeDockError, describeError, loadedMapFlag,
  isDockedAndIdle, isSmartPlanSupported, isWaterSlideSupported, mapNameBlocker, mapSavingEnabled, multiLevelEnabled, unsavedMapPresent, type RoomCleanMode, type VacuumStatus,
} from '../../shared/codes.js';
import { FloorMaterial, isRoundCarpet, type MapZone, type ParsedMap, type VirtualWall } from '../../shared/map.js';
import { editBlockedReason, mapIndexBlocker, restrictionSaveBlocker, saveMapIndex } from '../../shared/mapEdit.js';
import { restrictionsMatch, sameZones } from '../../shared/verification.js';
import type {
  CleanRecord, CleanSummary, CleanTimer, ConsumableStatus, DndSettings, DockSettings, FloorMap, RobotAlert,
  RobotSettings, VacuumSnapshot,
} from '../../shared/api.js';
import { asInt, isObject, type V1Response } from '../protocol/envelope.js';
import { createSecurityData } from '../protocol/mapResponse.js';
import { parseAnyMap } from '../map/parse.js';
import type { MqttLink } from '../net/mqttLink.js';
import type { FirmwareUpdateInfo, LastKnownRaw, Room } from '../net/serverApi.js';
import { log } from '../log.js';
import { Aborted, Mutex, answerInt, firstInt, firstObject, intField, sleep } from '../util.js';
import * as C from './commands.js';
import { MapEditError, RobotCommandError, RobotTimeoutError, RobotUnsupportedCommandError, UserError, describeError as describeException } from './errors.js';
import type { VacuumSession } from './session.js';

/*
 * One robot: polling, the map, and every action, ported from LocalRock's VacuumRepository.kt (and
 * the parts of VacuumViewModel / VacuumDetailScreen that drive it). State changes are announced
 * with 'change' (the snapshot) and 'map' (a new map) events.
 */

const NOT_CONFIRMED = 'The robot accepted the change, but the map does not show it yet. Refresh the map in a moment to check.';
const ROOM_MODES_NOT_CONFIRMED = 'The robot accepted the room settings, but does not report them back. Open the cleaning mode again to check.';
const MAP_NOT_KEPT = 'Map saving is now on, but the robot did not keep the map it had built. Let it clean or map the home once more, then save the map.';
const BUSY = 'The robot is busy. Dock it or let it finish first.';
const EMPTY_DOCK_SETTINGS: DockSettings = {
  washMode: null, smartWash: null, autoEmptyMode: null, mopDrying: null, dryTimeSeconds: null, washWaterTemperature: null,
};

const STATUS_POLL_MS = 5_000;
const MONITOR_ACTIVE_POLL_MS = 10_000;
const MONITOR_IDLE_POLL_MS = 30_000;
const MAP_FAST_POLL_MS = 8_000;
const MAP_IDLE_POLL_MS = 60_000;
const MAP_RETRY_MS = 5_000;
const MAP_LIST_RETRY_MS = 4_000;
const MAX_HISTORY_RECORDS = 20;
const READBACK_ATTEMPTS = 4;
const READBACK_DELAY_MS = 2_000;
const SPLIT_RETRY_DELAY_MS = 12_000;
/** Tag the official app gave a segment that got its first table entry. */
const STATUS_READBACK_ATTEMPTS = 6;
const STATUS_READBACK_DELAY_MS = 1_000;
const STALE_LINK_FAILURE_THRESHOLD = 3;
const STALE_LINK_SILENCE_MS = 30_000;

export interface RobotInfo {
  duid: string;
  name: string;
  model: string | null;
  firmware: string | null;
  featureSet: string | null;
  newFeatureSet: string | null;
  supportsSmartPlan: boolean;
  supportsWaterSlide: boolean;
}

export interface RepositoryDeps {
  session: VacuumSession;
  link: MqttLink;
  rriotKey: () => string;
  cleanOrder: (mapFlag: number) => number[];
  /** What the server last heard from this robot, or null. */
  lastKnown?: (includeMap: boolean) => Promise<LastKnownRaw | null>;
  voicePackages?: () => Promise<unknown>;
  firmware?: {
    check: () => Promise<FirmwareUpdateInfo | null>;
    start: () => Promise<{ started: boolean; version: string | null; reason: string | null }>;
  };
}

const FIRMWARE_POLL_MS = 3_000;
const FIRMWARE_CONFIRM_TRIES = 6;
const FIRMWARE_START_LIMIT_MS = 2 * 60_000;
const FIRMWARE_WATCH_LIMIT_MS = 25 * 60_000;

/** How long a robot may stay silent after it is opened before the server's last-known state is fetched. */
const LAST_KNOWN_AFTER_MS = 10_000;

/** Turns status snapshots into alerts; edge-triggered, so whatever is wrong when watching starts is not announced. */
class EventDetector {
  private last: VacuumStatus = {};
  runInProgress = false;

  update(next: VacuumStatus): Array<{ kind: 'error' | 'dock' | 'finished'; code?: number; area?: number; time?: number }> {
    const prev = this.last;
    this.last = next;
    const events: Array<{ kind: 'error' | 'dock' | 'finished'; code?: number; area?: number; time?: number }> = [];
    const error = next.errorCode;
    if (error !== undefined && error !== 0 && prev.errorCode !== undefined && prev.errorCode !== error) events.push({ kind: 'error', code: error });
    const dock = next.dockErrorStatus;
    if (dock !== undefined && dock !== 0 && prev.dockErrorStatus !== undefined && prev.dockErrorStatus !== dock) events.push({ kind: 'dock', code: dock });
    const docked = next.state === State.CHARGING || next.state === State.CHARGING_COMPLETE;
    const resting = docked || next.state === State.IDLE || next.state === State.NOT_CHARGING;
    if (next.state !== undefined && CLEANING_STATES.has(next.state)) {
      this.runInProgress = true;
    } else if (this.runInProgress && (next.inCleaning ?? 0) === 0 && resting) {
      this.runInProgress = false;
      if (docked && (next.errorCode ?? 0) === 0) events.push({ kind: 'finished', area: next.cleanArea, time: next.cleanTime });
    }
    return events;
  }
}

function formatArea(mm2: number | undefined): string | null {
  if (mm2 === undefined || mm2 <= 0) return null;
  const tenths = Math.floor((mm2 + 50_000) / 100_000);
  return `${Math.floor(tenths / 10)}.${tenths % 10} m²`;
}

function formatMinutes(s: number | undefined): string | null {
  return s === undefined || s <= 0 ? null : `${Math.floor((s + 30) / 60)} min`;
}

export class VacuumRepository extends EventEmitter {
  private status: VacuumStatus = {};
  private parsedMap: ParsedMap | null = null;
  /** Names the map parser gave each room, before home names are applied. */
  private parserNames = new Map<number, string>();
  private mapVersion = 0;
  private mapStatusText = 'idle';
  private roomIds: number[] = [];
  private homeRoomNames = new Map<number, string>();
  private segmentToRoomId = new Map<number, number>();
  /** Null until read, or when the answer could not be parsed; empty when no room has been assigned yet. */
  private rawSegmentTable: C.SegmentEntry[] | null = null;
  private consumables: ConsumableStatus | null = null;
  private cleanHistory: CleanRecord[] = [];
  private cleanSummary: CleanSummary | null = null;
  private timers: CleanTimer[] = [];
  private robotSettings: RobotSettings = { volume: 50, childLock: false, ledEnabled: true, carpetMode: 1 };
  private dockSettings: DockSettings = EMPTY_DOCK_SETTINGS;
  /** The dryer answer as the robot gave it, so a write can send back every field it held. */
  private dryerAnswer: Record<string, JsonValue> | null = null;
  private valley: ValleySettings | null = null;
  /** The feature flags the robot reports itself (app_get_init_status); null until it has answered. */
  private robotNewFeatureSet: string | null = null;
  private robotNewFeatureInfo: string | null = null;
  private robotFlagsAsked = false;
  private features: FeatureState[] = [];
  private featuresLoading = false;
  /** Which candidate shape each option last accepted, so later writes send one. */
  private readonly featureShapes = new Map<string, number>();
  private dnd: DndSettings | null = null;
  private floorMaps: FloorMap[] = [];
  private floorMapsLoaded = false;
  private maxFloorMaps: number | null = null;
  private currentFloorFlagLocal = 0;
  private mopMode: number | null = null;
  private roomCleanModes: RoomCleanMode[] = [];
  private roomCleanModesLoaded = false;
  private cleanSequenceRefused = false;

  private readonly mapFetchMutex = new Mutex();
  private readonly editMutex = new Mutex();
  private readonly detector = new EventDetector();
  alertsWanted = false;

  private watchers = 0;
  /** Status polls in a row without an answer; any reply or push starts over. */
  private missedPolls = 0;
  private unresponsive = false;
  private lastKnown: LastKnown | null = null;
  /** The last map the server kept, drawn while the robot can't be asked for a live one. */
  private offlineMap: ParsedMap | null = null;
  private lastKnownTimer: NodeJS.Timeout | null = null;
  private firmwareCheck: FirmwareCheck | null = null;
  private firmwareProgress: FirmwareProgress = { kind: 'idle' };
  private firmwareWatching = false;
  private voice: VoiceSnapshot = { switchKey: null, enabled: null, languageCode: null, historyCount: null, currentSid: null, location: null };
  private voiceInstall: VoiceInstallState | null = null;
  private statusLoop: AbortController | null = null;
  private mapLoop: AbortController | null = null;
  private floorLoop: AbortController | null = null;
  private lastMapStatusKey = '';
  private changeQueued = false;
  private removePush: (() => void) | null = null;

  constructor(readonly info: RobotInfo, private readonly deps: RepositoryDeps) {
    super();
  }

  get session(): VacuumSession {
    return this.deps.session;
  }

  // ---- Lifecycle ----------------------------------------------------------------------------

  /** A browser opened this robot: poll status and the map. */
  addWatcher(): void {
    this.watchers++;
    if (this.watchers === 1) {
      // A robot that never answers (dead battery, lost Wi-Fi) leaves the page empty; the server
      // still holds where it was last seen and what it last reported.
      this.lastKnownTimer = setTimeout(() => {
        if (this.status.state === undefined && this.status.battery === undefined) void this.loadLastKnown();
      }, LAST_KNOWN_AFTER_MS);
      this.ensureStatusLoop();
      this.startMapLoop();
      this.startFloorLoop();
      void this.oneShotReads();
    }
  }

  removeWatcher(): void {
    if (this.watchers === 0) return;
    this.watchers--;
    if (this.watchers === 0) {
      if (this.lastKnownTimer) clearTimeout(this.lastKnownTimer);
      this.lastKnownTimer = null;
      this.mapLoop?.abort();
      this.mapLoop = null;
      this.floorLoop?.abort();
      this.floorLoop = null;
      if (!this.alertsWanted) this.stopStatusLoop();
    }
  }

  /** Alerts need status even when nobody has the robot open. */
  setAlertsWanted(wanted: boolean): void {
    this.alertsWanted = wanted;
    if (wanted) this.ensureStatusLoop();
    else if (this.watchers === 0) this.stopStatusLoop();
  }

  dispose(): void {
    this.statusLoop?.abort();
    this.mapLoop?.abort();
    this.floorLoop?.abort();
    this.statusLoop = this.mapLoop = this.floorLoop = null;
    this.removePush?.();
    this.removePush = null;
    this.deps.session.close();
    this.removeAllListeners();
  }

  private startSession(): void {
    if (!this.deps.session.started) this.deps.session.start();
    if (!this.removePush) {
      this.removePush = this.deps.session.onPush((push) => { this.heardFromRobot(); this.applyStatus(applyDpsPush(this.status, push)); });
    }
  }

  private ensureStatusLoop(): void {
    if (this.statusLoop) return;
    this.startSession();
    const ctrl = new AbortController();
    this.statusLoop = ctrl;
    void this.runStatusLoop(ctrl.signal);
  }

  private stopStatusLoop(): void {
    this.statusLoop?.abort();
    this.statusLoop = null;
  }

  private waitForLink(signal: AbortSignal): Promise<void> {
    if (this.deps.link.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onConnected = (up: boolean) => {
        if (!up) return;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new Aborted());
      };
      const cleanup = () => {
        this.deps.link.off('connected', onConnected);
        signal.removeEventListener('abort', onAbort);
      };
      this.deps.link.on('connected', onConnected);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async runStatusLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    try {
      while (!signal.aborted) {
        await this.waitForLink(signal);
        try {
          this.deps.session.ensureSubscribed();
          const fresh = await this.getStatus();
          failures = 0;
          this.heardFromRobot();
          if (fresh) this.applyStatus(mergeStatus(this.status, fresh));
          if (!this.robotFlagsAsked) {
            this.robotFlagsAsked = true;
            void this.fetchRobotFeatureSet().catch(() => { this.robotFlagsAsked = false; });
          }
        } catch (e) {
          if (e instanceof Aborted) throw e;
          failures++;
          log.debug(`${this.info.name}: get_status failed (#${failures}): ${describeException(e)}`);
          if (++this.missedPolls >= STALE_LINK_FAILURE_THRESHOLD && !this.unresponsive) {
            this.unresponsive = true;
            void this.loadLastKnown();
          }
          if (failures >= STALE_LINK_FAILURE_THRESHOLD) {
            // A timed-out request is not proof of a dead socket; only reconnect when the link is
            // down or has gone completely silent.
            const silent = this.deps.link.millisSinceLastMessage();
            if (!this.deps.link.connected || silent >= STALE_LINK_SILENCE_MS) this.deps.link.forceReconnect();
            failures = 0;
          }
        }
        const interval = this.watchers > 0 ? STATUS_POLL_MS : this.detector.runInProgress ? MONITOR_ACTIVE_POLL_MS : MONITOR_IDLE_POLL_MS;
        await sleep(interval, signal);
      }
    } catch (e) {
      if (!(e instanceof Aborted)) log.error(`${this.info.name}: status loop stopped: ${describeException(e)}`);
    }
  }

  private startMapLoop(): void {
    if (this.mapLoop) return;
    const ctrl = new AbortController();
    this.mapLoop = ctrl;
    void (async () => {
      let loaded = this.parsedMap !== null;
      try {
        while (!ctrl.signal.aborted) {
          await this.waitForLink(ctrl.signal);
          try {
            await this.fetchMap();
            loaded = true;
          } catch (e) {
            log.debug(`${this.info.name}: map fetch failed: ${describeException(e)}`);
          }
          // Until a map has arrived, ask again soon.
          const state = this.status.state;
          await sleep(!loaded ? MAP_RETRY_MS : state !== undefined && ACTIVE_STATES.has(state) ? MAP_FAST_POLL_MS : MAP_IDLE_POLL_MS, ctrl.signal);
        }
      } catch (e) {
        if (!(e instanceof Aborted)) log.error(`${this.info.name}: map loop stopped: ${describeException(e)}`);
      }
    })();
  }

  /**
   * Keep the saved-map list current: read it until it arrives, and again whenever map_status or
   * lab_status changes (a map was saved, deleted or switched, also from another app).
   */
  private startFloorLoop(): void {
    if (this.floorLoop) return;
    const ctrl = new AbortController();
    this.floorLoop = ctrl;
    this.lastMapStatusKey = '';
    void (async () => {
      try {
        while (!ctrl.signal.aborted) {
          const key = `${this.status.mapStatus}/${this.status.labStatus}`;
          if (!this.floorMapsLoaded || key !== this.lastMapStatusKey) {
            await this.waitForLink(ctrl.signal);
            try {
              await this.fetchFloorMaps();
              this.lastMapStatusKey = key;
            } catch {
              // retried below
            }
          }
          await sleep(this.floorMapsLoaded ? 2_000 : MAP_LIST_RETRY_MS, ctrl.signal);
        }
      } catch (e) {
        if (!(e instanceof Aborted)) log.error(`${this.info.name}: map list loop stopped: ${describeException(e)}`);
      }
    })();
  }

  /** Reads that only need doing once when the robot is opened. */
  private async oneShotReads(): Promise<void> {
    const ctrl = this.mapLoop;
    if (!ctrl) return;
    try {
      await this.waitForLink(ctrl.signal);
    } catch {
      return;
    }
    await this.fetchConsumables().catch(() => undefined);
    await this.rooms().catch(() => undefined);
  }

  // ---- Snapshot -----------------------------------------------------------------------------

  private changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    setImmediate(() => {
      this.changeQueued = false;
      this.emit('change', this.snapshot());
    });
  }

  currentFloorFlag(): number {
    const loaded = loadedMapFlag(this.status);
    return loaded !== undefined && loaded !== UNSAVED_MAP_FLAG ? loaded : this.currentFloorFlagLocal;
  }

  /** The robot's own flags win; the server's record is the fallback until the robot has answered. */
  effectiveNewFeatureSet(): string | null {
    return this.robotNewFeatureSet ?? this.info.newFeatureSet;
  }

  snapshot(): VacuumSnapshot {
    const flags = this.effectiveNewFeatureSet();
    return {
      ...this.info,
      status: { ...this.status },
      mopMode: this.mopMode,
      mapStatus: this.mapStatusText,
      mapVersion: this.mapVersion,
      floorMaps: this.floorMaps,
      floorMapsLoaded: this.floorMapsLoaded,
      maxFloorMaps: this.maxFloorMaps,
      currentFloorFlag: this.currentFloorFlag(),
      unsavedMap: unsavedMapPresent(this.status),
      roomCleanModes: this.roomCleanModes,
      roomCleanModesLoaded: this.roomCleanModesLoaded,
      consumables: this.consumables,
      cleanSummary: this.cleanSummary,
      cleanHistory: this.cleanHistory,
      timers: this.timers,
      robotSettings: this.robotSettings,
      dockSettings: this.dockSettings,
      valley: this.valley,
      roomTags: this.roomTags(),
      dnd: this.dnd,
      defaultCleanOrder: this.deps.cleanOrder(this.currentFloorFlag()),
    };
  }

  /** The live map, or the server's last one while the robot doesn't answer. */
  map(): ParsedMap | null {
    return this.parsedMap ?? this.offlineMap;
  }

  private applyStatus(next: VacuumStatus): void {
    this.status = next;
    if (this.alertsWanted) {
      for (const ev of this.detector.update(next)) this.emitAlert(ev);
    } else {
      this.detector.update(next);
    }
    this.changed();
  }

  private emitAlert(ev: { kind: 'error' | 'dock' | 'finished'; code?: number; area?: number; time?: number }): void {
    const base = { duid: this.info.duid, kind: ev.kind, title: this.info.name };
    let alert: RobotAlert;
    if (ev.kind === 'error') alert = { ...base, body: describeError(ev.code!), alert: true };
    else if (ev.kind === 'dock') alert = { ...base, body: describeDockError(ev.code!), alert: true };
    else {
      const parts = [formatArea(ev.area), formatMinutes(ev.time)].filter(Boolean);
      alert = { ...base, body: parts.length ? `Cleaning finished: ${parts.join(' in ')}` : 'Cleaning finished', alert: false };
    }
    this.emit('alert', alert);
  }

  // ---- Last known (local_roborock_server #251) ------------------------------------------------

  private heardFromRobot(): void {
    this.missedPolls = 0;
    if (!this.unresponsive && !this.lastKnown && !this.offlineMap) return;
    this.unresponsive = false;
    this.lastKnown = null;
    if (this.offlineMap) {
      this.offlineMap = null;
      this.emit('map', this.parsedMap, this.mapVersion);
    }
    this.changed();
  }

  private answering(): boolean {
    return (this.status.state !== undefined || this.status.battery !== undefined) && !this.unresponsive;
  }

  async loadLastKnown(): Promise<void> {
    const k = await this.deps.lastKnown?.(true);
    if (!k || this.answering()) return;
    const s = k.status ?? {};
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const robot = k.position?.robot;
    this.lastKnown = {
      lastSeenAt: k.last_seen_at ?? null,
      offlineAt: k.offline_at ?? null,
      state: num(s.state),
      battery: num(s.battery),
      errorCode: num(s.error_code),
      robotMm: robot && num(robot.x) !== null && num(robot.y) !== null ? { x: robot.x!, y: robot.y! } : null,
    };
    if (!this.parsedMap && k.map) {
      try {
        const parsed = parseAnyMap(Buffer.from(k.map, 'base64')).map;
        if (parsed) {
          // Room names from the server's copy of the robot's room table.
          const names = new Map((k.rooms ?? []).filter((r) => typeof r.segment === 'number' && r.name).map((r) => [r.segment!, r.name!]));
          this.offlineMap = names.size ? { ...parsed, rooms: parsed.rooms.map((r) => ({ ...r, name: names.get(r.id) ?? r.name })) } : parsed;
          this.emit('map', this.offlineMap, this.mapVersion);
        }
      } catch {
        // No map to show; the text still says when it was seen.
      }
    }
    this.changed();
  }

  // ---- Status -------------------------------------------------------------------------------

  private async getStatus(timeoutMs?: number): Promise<VacuumStatus | null> {
    const resp = await C.getStatusRaw(this.deps.session, timeoutMs);
    return parseStatus(resp.result);
  }

  async refreshStatus(): Promise<void> {
    try {
      const fresh = await this.getStatus();
      if (fresh) this.applyStatus(mergeStatus(this.status, fresh));
    } catch {
      // best effort, like the app
    }
  }

  /** Is the robot there? true on any answer, false on silence. */
  async probe(timeoutMs: number): Promise<boolean> {
    this.startSession();
    try {
      await this.deps.session.sendCommand('get_status', [], { timeoutMs });
      return true;
    } catch (e) {
      if (e instanceof RobotTimeoutError) return false;
      throw e;
    }
  }

  private isBusy(): boolean {
    return this.status.state !== undefined && ACTIVE_STATES.has(this.status.state);
  }

  // ---- Rooms --------------------------------------------------------------------------------

  async rooms(): Promise<V1Response> {
    const resp = await C.getRoomMapping(this.deps.session);
    const result = resp.result;
    this.rawSegmentTable = parseSegmentTableOrNull(result);
    this.changed();
    if (Array.isArray(result)) {
      const mapping = new Map<number, number>();
      for (const entry of result) {
        if (!Array.isArray(entry)) continue;
        const segment = asInt(entry[0]);
        if (segment === null) continue;
        if (entry.length >= 2) {
          const roomId = asInt(entry[1]);
          if (roomId !== null) mapping.set(segment, roomId);
        }
      }
      if (mapping.size > 0) {
        this.segmentToRoomId = mapping;
        this.applyRoomNames();
      }
    }
    return resp;
  }

  setHomeRooms(rooms: Room[]): void {
    this.homeRoomNames = new Map(rooms.map((r) => [Number(r.id), r.name]));
    this.applyRoomNames();
  }

  /** Real room names: map segment -> get_room_mapping room id -> home room name, else the parser's name. */
  private withRoomNames(map: ParsedMap): ParsedMap {
    let changed = false;
    const rooms = map.rooms.map((r) => {
      const roomId = this.segmentToRoomId.get(r.id);
      const name = (roomId !== undefined ? this.homeRoomNames.get(roomId) : undefined) ?? this.parserNames.get(r.id) ?? r.name;
      if (name !== r.name) changed = true;
      return name === r.name ? r : { ...r, name };
    });
    return changed ? { ...map, rooms } : map;
  }

  private applyRoomNames(): void {
    const map = this.parsedMap;
    if (!map) return;
    const named = this.withRoomNames(map);
    if (named !== map) {
      this.parsedMap = named;
      this.mapVersion++;
      this.emit('map', this.parsedMap, this.mapVersion);
      this.changed();
    }
  }

  // ---- Map ----------------------------------------------------------------------------------

  /** Serialised: the session tracks a single outstanding map request. */
  fetchMap(): Promise<void> {
    return this.mapFetchMutex.run(() => this.fetchMapLocked());
  }

  private async fetchMapLocked(): Promise<void> {
    this.mapStatusText = 'requesting';
    this.changed();
    try {
      const sd = createSecurityData(this.deps.rriotKey());
      const resp = await this.deps.session.fetchMap(sd, 60_000);
      const outcome = parseAnyMap(resp.data);
      const sizeKb = Math.floor(resp.data.length / 1024);
      if (!outcome.map) {
        const head = resp.data.subarray(0, 8).toString('hex');
        this.mapStatusText = `ok: ${sizeKb} KB, no parser matched (head=${head})`;
        log.warn(`${this.info.name}: map not understood: ${outcome.error}`);
        this.changed();
        return;
      }
      const map = outcome.map;
      this.parserNames = new Map(map.rooms.map((r) => [r.id, r.name]));
      if (map.rooms.length > 0) this.roomIds = map.rooms.map((r) => r.id);
      this.parsedMap = this.withRoomNames(map);
      this.mapVersion++;
      this.mapStatusText = `ok: ${sizeKb} KB, ${map.width}x${map.height} ${outcome.format}`;
      this.emit('map', this.parsedMap, this.mapVersion);
      this.changed();
    } catch (e) {
      this.mapStatusText = `failed: ${describeException(e)}`;
      this.changed();
      throw e;
    }
  }

  private clearMap(): void {
    this.parsedMap = null;
    this.mapVersion++;
    this.emit('map', null, this.mapVersion);
    this.changed();
  }

  /** Fetch the map until `check` passes or the attempts run out; the robot rewrites its map after an edit. */
  private async awaitMap(check: (m: ParsedMap) => boolean): Promise<ParsedMap | null> {
    for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(READBACK_DELAY_MS);
      try { await this.fetchMap(); } catch { /* next attempt */ }
      const m = this.parsedMap;
      if (m && check(m)) return m;
    }
    return null;
  }

  private editableMap(): ParsedMap {
    const reason = editBlockedReason(this.parsedMap, this.isBusy());
    if (reason) throw new MapEditError(reason);
    return this.parsedMap!;
  }

  // ---- Cleaning -----------------------------------------------------------------------------

  /**
   * Clean `roomIds` in the order given. The robot follows its stored sequence, so that is written
   * first when it would clean them in another order (best effort).
   */
  async cleanRooms(roomIds: number[], repeat: number): Promise<void> {
    if (new Set(roomIds).size >= 2) await this.writeCleanSequence((stored) => C.cleanSequenceFor(roomIds, stored));
    await C.appSegmentClean(this.deps.session, roomIds, repeat);
  }

  /** Full clean; with a default order the robot's sequence is put back to it first. */
  async clean(): Promise<void> {
    const defaultOrder = this.deps.cleanOrder(this.currentFloorFlag());
    const onMap = this.roomIds;
    const order = onMap.length === 0 ? defaultOrder : defaultOrder.filter((r) => onMap.includes(r));
    if (order.length > 0) {
      await this.writeCleanSequence((stored) => (order.length === stored.length && order.every((v, i) => v === stored[i]) ? null : order));
    }
    await C.appStart(this.deps.session);
  }

  private async writeCleanSequence(wanted: (stored: number[]) => number[] | null): Promise<void> {
    if (this.cleanSequenceRefused) return;
    try {
      const stored = C.parseCleanSequence((await C.getCleanSequence(this.deps.session)).result);
      const next = wanted(stored);
      if (next) await C.setCleanSequence(this.deps.session, next);
    } catch (e) {
      log.info(`${this.info.name}: room order not stored: ${describeException(e)}`);
      this.cleanSequenceRefused = true;
    }
  }

  /** Store `order` as the robot's sequence; confirmed by reading it back. */
  async saveCleanSequence(order: number[]): Promise<void> {
    if (this.isBusy()) throw new MapEditError(BUSY);
    await C.setCleanSequence(this.deps.session, order);
    const back = C.parseCleanSequence((await C.getCleanSequence(this.deps.session)).result);
    if (back.length !== order.length || back.some((v, i) => v !== order[i])) {
      throw new MapEditError('The robot accepted the cleaning order, but does not report it back.');
    }
    this.cleanSequenceRefused = false;
  }

  pause = () => C.appPause(this.deps.session).then((r) => { C.requireOk(r, 'app_pause'); });
  stop = () => C.appStop(this.deps.session).then((r) => { C.requireOk(r, 'app_stop'); });
  dock = () => C.appCharge(this.deps.session).then((r) => { C.requireOk(r, 'app_charge'); });

  /** Resume the robot's own paused task: a full clean, a zone clean or a room clean (app 1.4.0). */
  async resume(): Promise<void> {
    const fresh = await this.getStatus();
    if (!fresh) throw new MapEditError("The robot's current task is unavailable");
    this.applyStatus(mergeStatus(this.status, fresh));
    const method = fresh.inCleaning === 2 ? 'resume_zoned_clean' : fresh.inCleaning === 3 ? 'resume_segment_clean' : 'app_start';
    C.requireOk(await this.deps.session.sendCommand(method), method);
  }
  async setFanPower(level: number): Promise<void> {
    await this.setOneMotorMode('set_custom_mode', await C.setCustomMode(this.deps.session, level), (m) => ({ ...m, fan: level }));
  }

  async setWaterBoxMode(level: number): Promise<void> {
    await this.setOneMotorMode('set_water_box_custom_mode', await C.setWaterBoxCustomMode(this.deps.session, level), (m) => ({ ...m, water: level }));
  }

  /**
   * Checks the robot's answer to a single suction, water or route change. On -10005 the change is
   * sent again as one set_clean_motor_mode with the other two as the robot reports them now (see
   * motorModesForFallback); a refusal that can't be retried, or a refused retry, is raised.
   */
  private async setOneMotorMode(method: string, answer: V1Response, change: (m: C.MotorModes) => C.MotorModes): Promise<void> {
    if (!answer.error) return;
    const code = errorCode(answer.error);
    if (code === C.PARAM_FORMAT_REFUSED_CODE) {
      await this.refreshStatus();
      await this.fetchMopMode();
    }
    const modes = C.motorModesForFallback(code, this.status.fanPower, this.status.waterBoxCustomMode, this.mopMode);
    if (!modes) throw new RobotCommandError(method, answer.error);
    const wanted = change(modes);
    await this.setCleanMotorMode(wanted.fan, wanted.water, wanted.mop);
  }
  collectDust = () => C.appStartCollectDust(this.deps.session).then((r) => { C.requireOk(r, 'app_start_collect_dust'); });
  washMop = () => C.appStartWash(this.deps.session).then((r) => { C.requireOk(r, 'app_start_wash'); });
  stopWash = () => C.appStopWash(this.deps.session).then((r) => { C.requireOk(r, 'app_stop_wash'); });
  startDryer = () => C.appSetDryerStatus(this.deps.session, true).then((r) => { C.requireOk(r, 'app_set_dryer_status'); });
  stopDryer = () => C.appSetDryerStatus(this.deps.session, false).then((r) => { C.requireOk(r, 'app_set_dryer_status'); });
  findMe = () => C.findMe(this.deps.session).then(() => undefined);
  rcStart = () => C.appRcStart(this.deps.session).then(() => undefined);
  rcEnd = () => C.appRcEnd(this.deps.session).then(() => undefined);
  rcMove = (velocity: number, omega: number, durationMs: number) => C.appRcMove(this.deps.session, velocity, omega, durationMs).then(() => undefined);
  gotoTarget = (x: number, y: number) => C.appGotoTarget(this.deps.session, x, y).then((r) => { C.requireOk(r, 'app_goto_target'); });
  cleanZones = (zones: C.ZoneRect[]) => C.appZonedClean(this.deps.session, zones).then((r) => { C.requireOk(r, 'app_zoned_clean'); });
  resetConsumable = (field: string) => C.resetConsumable(this.deps.session, field).then(() => undefined);

  async fetchMopMode(): Promise<void> {
    try {
      const mode = firstInt((await C.getMopMode(this.deps.session)).result);
      if (mode !== null) { this.mopMode = mode; this.changed(); }
    } catch {
      // as in the app
    }
  }

  async setMopMode(mode: number): Promise<void> {
    await this.setOneMotorMode('set_mop_mode', await C.setMopMode(this.deps.session, mode), (m) => ({ ...m, mop: mode }));
    this.mopMode = mode;
    this.changed();
  }

  /** Switches suction, water and route in one command; the only way in or out of SmartPlan. */
  async setCleanMotorMode(fan: number, water: number, mop: number): Promise<void> {
    C.requireOk(await C.setCleanMotorMode(this.deps.session, fan, water, mop), 'set_clean_motor_mode');
    // All three go out together, so the next change must start from these, not wait for a status poll.
    this.status = { ...this.status, fanPower: fan, waterBoxCustomMode: water };
    this.mopMode = mop;
    this.changed();
  }

  /** Vacuum-then-mop on (1) or off (0); set_clean_motor_mode then keeps seq_type as it is. */
  async setCleanSequenceType(type: number, fan: number, water: number, mop: number, repeat: number | null): Promise<void> {
    C.requireOk(await C.setCleanSequenceType(this.deps.session, type, fan, water, mop, repeat), 'app_set_clean_sequence_type');
    this.status = { ...this.status, cleanSequenceType: type, fanPower: fan, waterBoxCustomMode: water };
    this.mopMode = mop;
    this.changed();
  }

  async fetchRoomCleanModes(): Promise<void> {
    this.roomCleanModesLoaded = false;
    this.changed();
    this.roomCleanModes = C.parseCustomizeCleanMode((await C.getCustomizeCleanMode(this.deps.session)).result);
    this.roomCleanModesLoaded = true;
    this.changed();
  }

  /** Per-room settings inside an edit session, as the official app does; confirmed by reading back. */
  saveRoomCleanModes(modes: RoomCleanMode[]): Promise<void> {
    return this.editMutex.run(async () => {
      if (this.isBusy()) throw new MapEditError(BUSY);
      await C.inEditSession(this.deps.session, () => C.setCustomizeCleanMode(this.deps.session, modes));
      await this.fetchRoomCleanModes();
      if (!C.roomCleanModesStored(modes, this.roomCleanModes)) throw new MapEditError(ROOM_MODES_NOT_CONFIRMED);
    });
  }

  // ---- Reads for the settings screens -------------------------------------------------------

  async fetchConsumables(): Promise<void> {
    const o = firstObject((await C.getConsumable(this.deps.session)).result);
    if (!o) return;
    const opt = (k: string) => intField(o, k) ?? undefined;
    this.consumables = {
      mainBrushWorkTime: opt('main_brush_work_time'),
      sideBrushWorkTime: opt('side_brush_work_time'),
      filterWorkTime: opt('filter_work_time'),
      sensorDirtyTime: opt('sensor_dirty_time'),
      cleaningBrushWorkTime: opt('cleaning_brush_work_times'),
      strainerWorkTime: opt('strainer_work_times'),
    };
    this.changed();
  }

  /** Summary, then up to 20 records one by one. Returns the record ids. */
  async fetchCleanSummary(): Promise<number[]> {
    const result = (await C.getCleanSummary(this.deps.session)).result;
    let ids: number[] = [];
    if (Array.isArray(result)) {
      if (result.length < 3) return [];
      this.cleanSummary = { totalTimeSec: num(result[0]), totalAreaMm2: num(result[1]), totalCount: num(result[2]) };
      if (Array.isArray(result[3])) ids = result[3].map((v: unknown) => asInt(v)).filter((v): v is number => v !== null);
    } else if (isObject(result)) {
      this.cleanSummary = { totalTimeSec: num(result['clean_time']), totalAreaMm2: num(result['clean_area']), totalCount: num(result['clean_count']) };
      if (Array.isArray(result['records'])) ids = result['records'].map((v: unknown) => asInt(v)).filter((v): v is number => v !== null);
    }
    this.changed();
    return ids;
  }

  async fetchCleanHistory(): Promise<void> {
    const ids = await this.fetchCleanSummary();
    const records: CleanRecord[] = [];
    for (const id of ids.slice(0, MAX_HISTORY_RECORDS)) {
      try {
        const rec = parseCleanRecord((await C.getCleanRecord(this.deps.session, id)).result, id);
        if (rec) records.push(rec);
      } catch {
        // skip this record
      }
    }
    this.cleanHistory = records;
    this.changed();
  }

  async fetchTimers(): Promise<void> {
    const result = (await C.getTimer(this.deps.session)).result;
    if (!Array.isArray(result)) return;
    const parsed: CleanTimer[] = [];
    for (const entry of result) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const id = entry[0] == null ? null : String(entry[0]);
      if (id === null) continue;
      const enabled = entry[1] === 'on';
      const details = entry[2];
      if (!Array.isArray(details) || typeof details[0] !== 'string') continue;
      const t = parseCronTimer(id, enabled, details[0]);
      if (t) parsed.push(t);
    }
    this.timers = parsed;
    this.changed();
  }

  async createTimer(hour: number, minute: number, weekdays: number[]): Promise<void> {
    const id = String(Math.floor(Date.now() / 1000));
    const days = [...new Set(weekdays)].sort((a, b) => a - b);
    const cron = `${minute} ${hour} * * ${days.length === 0 ? '*' : days.join(',')}`;
    C.requireOk(await C.setTimer(this.deps.session, id, true, cron), 'set_timer');
    this.timers = [...this.timers, { id, enabled: true, hour, minute, weekdays: days }];
    this.changed();
  }

  async toggleTimer(id: string): Promise<void> {
    const timer = this.timers.find((t) => t.id === id);
    if (!timer) throw new UserError('That schedule is no longer there');
    C.requireOk(await C.updTimer(this.deps.session, id, !timer.enabled), 'upd_timer');
    this.timers = this.timers.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t));
    this.changed();
  }

  async deleteTimer(id: string): Promise<void> {
    C.requireOk(await C.delTimer(this.deps.session, id), 'del_timer');
    this.timers = this.timers.filter((t) => t.id !== id);
    this.changed();
  }

  async fetchRobotSettings(): Promise<void> {
    const s = this.deps.session;
    // Each read stands alone: a Qrevo answers the volume as [45], the LED as [1] and the carpet mode
    // as [{...}], and one read that failed must not skip the others.
    const read = async (key: string | null, ask: () => Promise<V1Response>): Promise<number | null> => {
      try { return answerInt((await ask()).result, key); } catch { return null; }
    };
    const volume = await read(null, () => C.getSoundVolume(s));
    if (volume !== null) this.robotSettings = { ...this.robotSettings, volume };
    const lock = await read('lock_status', () => C.getChildLock(s));
    if (lock !== null) this.robotSettings = { ...this.robotSettings, childLock: lock === 1 };
    const led = await read('led_status', () => C.getLedStatus(s));
    if (led !== null) this.robotSettings = { ...this.robotSettings, ledEnabled: led === 1 };
    const carpet = await read('carpet_clean_mode', () => C.getCarpetCleanMode(s));
    if (carpet !== null) this.robotSettings = { ...this.robotSettings, carpetMode: carpet };
    this.changed();
  }

  async setVolume(volume: number): Promise<void> {
    C.requireOk(await C.setSoundVolume(this.deps.session, volume), 'change_sound_volume');
    this.robotSettings = { ...this.robotSettings, volume };
    this.changed();
  }

  async setChildLock(locked: boolean): Promise<void> {
    C.requireOk(await C.setChildLock(this.deps.session, locked), 'set_child_lock_status');
    // Read back after the ok, so the switch shows what the robot holds; the tapped value stands in if the read fails.
    let held: number | null = null;
    try { held = answerInt((await C.getChildLock(this.deps.session)).result, 'lock_status'); } catch { /* keep the tapped value */ }
    this.robotSettings = { ...this.robotSettings, childLock: held === null ? locked : held === 1 };
    this.changed();
  }

  async setLed(on: boolean): Promise<void> {
    C.requireOk(await C.setLedStatus(this.deps.session, on), 'set_led_status');
    this.robotSettings = { ...this.robotSettings, ledEnabled: on };
    this.changed();
  }

  async setCarpetMode(mode: number): Promise<void> {
    C.requireOk(await C.setCarpetCleanMode(this.deps.session, mode), 'set_carpet_clean_mode');
    this.robotSettings = { ...this.robotSettings, carpetMode: mode };
    this.changed();
  }

  async fetchDockSettings(): Promise<void> {
    const s = this.deps.session;
    const answer = async (method: string, f: () => Promise<V1Response>): Promise<Record<string, unknown> | null> => {
      try { return firstObject(C.requireOk(await f(), method).result); } catch { return null; }
    };
    const wash = await answer('get_wash_towel_mode', () => C.getWashTowelMode(s));
    let smartWash = null;
    try { smartWash = C.parseSmartWashSettings(C.requireOk(await C.getSmartWashParams(s), 'get_smart_wash_params').result); } catch { /* not offered */ }
    const empty = await answer('get_dust_collection_mode', () => C.getDustCollectionMode(s));
    const dryer = await answer('app_get_dryer_setting', () => C.getDryerSetting(s));
    const temperature = await answer('get_wash_water_temperature', () => C.getWashWaterTemperature(s));
    const dryStatus = dryer ? asInt(dryer['status']) : null;
    const on = dryer && isObject(dryer['on']) ? dryer['on'] as Record<string, unknown> : null;
    this.dryerAnswer = dryStatus !== null ? dryer as Record<string, JsonValue> : null;
    this.dockSettings = {
      washMode: wash ? asInt(wash['wash_mode']) : null,
      smartWash,
      autoEmptyMode: empty ? asInt(empty['mode']) : null,
      mopDrying: dryStatus === null ? null : dryStatus === 1,
      dryTimeSeconds: dryStatus === null || !on ? null : asInt(on['dry_time']),
      washWaterTemperature: temperature ? asInt(temperature['wash_water_temperature']) : null,
    };
    this.changed();
  }

  async setWashMode(mode: number): Promise<void> {
    C.requireOk(await C.setWashTowelMode(this.deps.session, mode), 'set_wash_towel_mode');
    this.dockSettings = { ...this.dockSettings, washMode: mode };
    this.changed();
  }

  async setWashFrequency(mode: number, intervalMinutes: number | null): Promise<void> {
    // Room and smart modes still carry an interval, so the robot's current one is kept.
    const current = C.parseSmartWashSettings(C.requireOk(await C.getSmartWashParams(this.deps.session), 'get_smart_wash_params').result);
    if (!current) throw new UserError("The robot's mop washing frequency is unavailable");
    let updated;
    try { updated = withWashFrequency(current, mode, intervalMinutes); } catch (e) { throw new UserError((e as Error).message); }
    C.requireOk(await C.setSmartWashParams(this.deps.session, updated), 'set_smart_wash_params');
    this.dockSettings = { ...this.dockSettings, smartWash: updated };
    this.changed();
  }

  async setAutoEmptyMode(mode: number): Promise<void> {
    C.requireOk(await C.setDustCollectionMode(this.deps.session, mode), 'set_dust_collection_mode');
    this.dockSettings = { ...this.dockSettings, autoEmptyMode: mode };
    this.changed();
  }

  async setMopDrying(enabled: boolean): Promise<void> {
    // Sends back everything the robot reported, so the switch alone cannot change how long a run lasts.
    const reported = this.dryerAnswer;
    const body = C.dryerSettingBody(reported, enabled, reported === null ? this.dockSettings.dryTimeSeconds : null);
    C.requireOk(await C.setDryerSetting(this.deps.session, body), 'app_set_dryer_setting');
    this.dryerAnswer = body;
    this.dockSettings = { ...this.dockSettings, mopDrying: enabled };
    this.changed();
  }

  async setDryTime(seconds: number): Promise<void> {
    const body = C.dryerSettingBody(this.dryerAnswer, this.dockSettings.mopDrying ?? true, seconds);
    C.requireOk(await C.setDryerSetting(this.deps.session, body), 'app_set_dryer_setting');
    this.dryerAnswer = body;
    this.dockSettings = { ...this.dockSettings, dryTimeSeconds: seconds };
    this.changed();
  }

  async setWashWaterTemperature(value: number): Promise<void> {
    C.requireOk(await C.setWashWaterTemperature(this.deps.session, value), 'set_wash_water_temperature');
    this.dockSettings = { ...this.dockSettings, washWaterTemperature: value };
    this.changed();
  }

  /** Pumps the robot's built-in water tank out through the dock. A refusal is raised, not ignored. */
  async emptyInbuiltWaterTank(): Promise<void> {
    const fresh = await this.getStatus();
    if (!fresh) throw new UserError("The robot's current status is unavailable");
    this.applyStatus(mergeStatus(this.status, fresh));
    if (!isDockedAndIdle(fresh)) throw new UserError('Dock the robot and finish its current task before emptying its water tank');
    C.requireOk(await C.emptyInbuiltWaterTank(this.deps.session), C.APP_EMPTY_INBUILT_WATER_TANK);
  }

  /** Sends the robot looking for the pet; refused unless it is docked and idle. */
  async startPetSearch(): Promise<void> {
    const fresh = await this.getStatus();
    if (!fresh) throw new UserError("The robot's current status is unavailable");
    this.applyStatus(mergeStatus(this.status, fresh));
    if (!isDockedAndIdle(fresh)) throw new UserError('Dock the robot and finish its current task before looking for your pet');
    C.requireOk(await C.startPetSearch(this.deps.session), 'app_start_pet_patrol');
  }

  async matterStatus(): Promise<MatterInfo | null> {
    return parseMatterStatus(C.requireOk(await C.getMatterStatus(this.deps.session), 'matter.get_status').result);
  }

  async requestMatterKey(): Promise<void> {
    if (!matterKeyRequestAllowed((await this.matterStatus())?.state ?? null)) {
      throw new UserError('The robot has joined a Matter platform; a new key could end that pairing');
    }
    C.requireOk(await C.downloadMatterKey(this.deps.session), 'matter.dnld_key');
  }

  async resetMatter(): Promise<void> {
    C.requireOk(await C.resetMatter(this.deps.session), 'matter.reset');
  }

  // ---- Voice Assistant ----------------------------------------------------------------------

  /** The switch, language and chat count; a read that fails keeps what an earlier read found. */
  async fetchVoice(): Promise<void> {
    const s = this.deps.session;
    try {
      const sw = parseVoiceSwitch(C.requireOk(await C.getVoiceServiceSwitch(s), 'get_voice_service_switch').result);
      if (sw) this.voice = { ...this.voice, switchKey: sw.key, enabled: sw.enabled };
    } catch { /* keep */ }
    try {
      const sound = C.requireOk(await C.getCurrentSound(s), 'get_current_sound').result;
      const cur = parseCurrentSound(sound);
      this.voice = { ...this.voice, languageCode: parseCurrentSoundLanguage(sound) ?? this.voice.languageCode, currentSid: cur?.sidInUse ?? this.voice.currentSid, location: cur?.location ?? this.voice.location };
    } catch { /* keep */ }
    try {
      const summary = parseVoiceHistorySummary(C.requireOk(await C.getVoiceHistorySummary(s), 'get_voice_history_summary').result);
      if (summary) this.voice = { ...this.voice, historyCount: summary.count };
    } catch { /* keep */ }
    this.changed();
  }

  async setVoiceSwitch(on: boolean): Promise<void> {
    const key = this.voice.switchKey ?? 'data';
    C.requireOk(await C.setVoiceServiceSwitch(this.deps.session, voiceSwitchParams(key, on)), 'set_voice_service_switch');
    this.voice = { ...this.voice, switchKey: key, enabled: on };
    this.changed();
    try {
      const sw = parseVoiceSwitch(C.requireOk(await C.getVoiceServiceSwitch(this.deps.session), 'get_voice_service_switch').result);
      if (sw) { this.voice = { ...this.voice, enabled: sw.enabled }; this.changed(); }
    } catch { /* the sent value stands */ }
  }

  /** Newest 1000 at most, read newest first; a window that fails twice ends the read with what was already read. */
  async voiceHistory(): Promise<VoiceMessage[]> {
    const summary = parseVoiceHistorySummary(C.requireOk(await C.getVoiceHistorySummary(this.deps.session), 'get_voice_history_summary').result);
    if (!summary || summary.count <= 0) return [];
    const out: VoiceMessage[] = [];
    const fetchPage = async (min: number, max: number) => {
      try { return parseVoiceHistory(C.requireOk(await C.getVoiceHistory(this.deps.session, min, max), 'get_voice_history').result); } catch { return null; }
    };
    for (const [min, max] of voiceHistoryWindows(summary).slice(-10).reverse()) {
      let page = await fetchPage(min, max);
      if (page === null) { await sleep(500); page = await fetchPage(min, max); }
      if (page === null) break;
      out.push(...page);
    }
    const seen = new Set<number>();
    return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true))).sort((a, b) => a.id - b.id);
  }

  /** The packs the server offers for this robot's model and location. */
  async voicePacks(): Promise<VoicePack[]> {
    if (!this.deps.voicePackages) throw new UserError('Voice packs unavailable');
    const info = await this.deps.voicePackages();
    if (this.voice.location === null) { try { await this.fetchVoice(); } catch { /* default location */ } }
    const packs = parseVoicePackList(info, this.voice.location);
    if (!packs) throw new UserError('The server could not get the voice pack list for this robot.');
    return packs;
  }

  /** Sends dnld_install_sound, then follows get_sound_progress in the background until the pack is in use or fails. */
  async installVoicePack(sid: number): Promise<void> {
    if (this.voiceInstall && this.voiceInstall.failure === null && !this.voiceInstall.done) throw new UserError('Download in process. Try again later');
    const pack = (await this.voicePacks()).find((p) => p.id === sid);
    if (!pack) throw new UserError('That voice pack is no longer offered');
    const set = (v: VoiceInstallState) => { this.voiceInstall = v; this.changed(); };
    set({ sid, percent: null, failure: null, done: false });
    try {
      C.requireOk(await C.installSound(this.deps.session, installSoundParams(pack)), 'dnld_install_sound');
    } catch {
      set({ sid, percent: null, failure: 'SEND', done: false });
      return;
    }
    void (async () => {
      let waited = 0;
      let idle = 0;
      while (waited < 5 * 60_000) {
        await sleep(2_000);
        waited += 2_000;
        let progress = null;
        try { progress = parseSoundProgress(C.requireOk(await C.getSoundProgress(this.deps.session), 'get_sound_progress').result); } catch { /* none */ }
        const busy = progress?.state === 1 || progress?.state === 2;
        let current = null;
        if (!busy) {
          try { current = parseCurrentSound(C.requireOk(await C.getCurrentSound(this.deps.session), 'get_current_sound').result); } catch { /* none */ }
        }
        const step = voiceInstallStep(progress, current, sid, idle + 1);
        idle = nextVoiceIdlePolls(step, current, idle);
        if (step.kind === 'working') set({ sid, percent: step.percent, failure: null, done: false });
        else if (step.kind === 'done') { set({ sid, percent: 100, failure: null, done: true }); await this.fetchVoice(); return; }
        else { set({ sid, percent: null, failure: step.installFailed ? 'INSTALL' : 'DOWNLOAD', done: false }); return; }
      }
      set({ sid, percent: null, failure: 'TIMEOUT', done: false });
    })();
  }

  // ---- Firmware (local_roborock_server #255) -------------------------------------------------

  async checkFirmware(): Promise<void> {
    const api = this.deps.firmware;
    if (!api) return;
    this.firmwareCheck = { kind: 'checking' };
    this.changed();
    try {
      const info = await api.check();
      this.firmwareCheck = !info ? { kind: 'unavailable', reason: 'No firmware info returned' }
        : info.updatable ? { kind: 'available', current: info.currentVersion ?? this.info.firmware, latest: info.version, notes: info.desc, force: info.forceUpdate }
          : { kind: 'upToDate', current: info.currentVersion ?? this.info.firmware };
    } catch (e) {
      this.firmwareCheck = { kind: 'unavailable', reason: describeException(e) };
    }
    this.changed();
  }

  private setFirmwareProgress(p: FirmwareProgress): void {
    this.firmwareProgress = p;
    this.changed();
  }

  /** Asks the server to install, then follows the robot's OTA state until it is done (runs on in the background). */
  async startFirmwareUpdate(): Promise<void> {
    const api = this.deps.firmware;
    if (!api) throw new UserError('Firmware updates are not available');
    if (this.firmwareWatching) throw new UserError('An update is already running');
    const s = this.status;
    const blocker = firmwareInstallBlocker(s.state, s.battery, s.chargeStatus, s.inCleaning, s.errorCode);
    if (blocker) throw new UserError(blocker);
    const before = this.firmwareCheck?.kind === 'available' ? this.firmwareCheck.current : this.info.firmware;
    this.setFirmwareProgress({ kind: 'starting' });
    let started;
    try {
      started = await api.start();
    } catch (e) {
      this.setFirmwareProgress({ kind: 'failed', reason: describeException(e) });
      return;
    }
    if (!started.started) {
      this.setFirmwareProgress({ kind: 'failed', reason: started.reason ?? 'The server did not start the update' });
      return;
    }
    void this.followFirmware(started.version, before, false);
  }

  /** Picks the watch back up when the page opens while the robot is already downloading or installing. */
  async resumeFirmwareWatch(): Promise<void> {
    if (this.firmwareWatching) return;
    let state: string | null = null;
    let percent: number | null = null;
    try {
      state = C.parseOtaState(C.requireOk(await C.getOtaState(this.deps.session), 'get_ota_state').result);
      if (state === 'downloading') percent = C.parseOtaProgress(C.requireOk(await C.getOtaProgress(this.deps.session), 'get_ota_progress').result);
    } catch { /* not answering: nothing to resume */ }
    const step = nextFirmwareStep({ kind: 'idle' }, false, state !== null, state, percent);
    if (!step.seenWorking) return;
    this.setFirmwareProgress(step.progress);
    let before = this.info.firmware;
    try { before = (await this.deps.firmware?.check())?.currentVersion ?? before; } catch { /* keep the server's record */ }
    void this.followFirmware(null, before, true);
  }

  private async followFirmware(target: string | null, before: string | null, startedWorking: boolean): Promise<void> {
    this.firmwareWatching = true;
    try {
      const t0 = Date.now();
      let seenWorking = startedWorking;
      let idleStreak = 0;
      while (Date.now() - t0 < FIRMWARE_WATCH_LIMIT_MS) {
        await sleep(FIRMWARE_POLL_MS);
        let ota: string | null = null;
        let answered = true;
        try { ota = C.parseOtaState(C.requireOk(await C.getOtaState(this.deps.session, 5_000), 'get_ota_state').result); } catch { answered = false; }
        let percent: number | null = null;
        if (answered) { try { percent = C.parseOtaProgress(C.requireOk(await C.getOtaProgress(this.deps.session), 'get_ota_progress').result); } catch { /* none */ } }
        const step = nextFirmwareStep(this.firmwareProgress, seenWorking, answered, ota, percent, idleStreak);
        seenWorking = step.seenWorking;
        idleStreak = step.idleStreak;
        this.setFirmwareProgress(step.progress);
        if (step.finished) {
          if (step.progress.kind === 'failed') return;
          this.setFirmwareProgress(await this.confirmFirmwareVersion(before, target));
          await this.checkFirmware();
          return;
        }
        if (!seenWorking && Date.now() - t0 > FIRMWARE_START_LIMIT_MS) {
          this.setFirmwareProgress({ kind: 'failed', reason: 'The robot did not start the update.' });
          return;
        }
      }
      this.setFirmwareProgress({ kind: 'failed', reason: 'The update is taking longer than expected. Check the robot and try again.' });
    } finally {
      this.firmwareWatching = false;
    }
  }

  // The server's version can lag the robot's reboot by a few polls, so ask again before calling it a failure.
  private async confirmFirmwareVersion(before: string | null, target: string | null): Promise<FirmwareProgress> {
    let outcome = firmwareOutcome(before, target, null);
    for (let attempt = 0; attempt < FIRMWARE_CONFIRM_TRIES; attempt++) {
      if (attempt > 0) await sleep(FIRMWARE_POLL_MS);
      let after: string | null = null;
      try { after = (await this.deps.firmware?.check())?.currentVersion ?? null; } catch { /* try again */ }
      outcome = firmwareOutcome(before, target, after);
      if (outcome.kind === 'done') return outcome;
    }
    return outcome;
  }

  async fetchValley(): Promise<void> {
    let o: Record<string, unknown> | null = null;
    try { o = firstObject(C.requireOk(await C.getValleyElectricityTimer(this.deps.session), 'get_valley_electricity_timer').result); } catch { /* not offered */ }
    if (!o) return;
    this.valley = {
      enabled: intField(o, 'enabled') === 1,
      startHour: intField(o, 'start_hour') ?? 22,
      startMinute: intField(o, 'start_minute') ?? 0,
      endHour: intField(o, 'end_hour') ?? 6,
      endMinute: intField(o, 'end_minute') ?? 0,
    };
    this.changed();
  }

  async setValley(sh: number, sm: number, eh: number, em: number): Promise<void> {
    C.requireOk(await C.setValleyElectricityTimer(this.deps.session, sh, sm, eh, em), 'set_valley_electricity_timer');
    this.valley = { enabled: true, startHour: sh, startMinute: sm, endHour: eh, endMinute: em };
    this.changed();
  }

  async disableValley(): Promise<void> {
    C.requireOk(await C.closeValleyElectricityTimer(this.deps.session), 'close_valley_electricity_timer');
    if (this.valley) this.valley = { ...this.valley, enabled: false };
    this.changed();
  }

  // ---- Robot options (BetaFeatures.kt) --------------------------------------------------------

  async fetchRobotFeatureSet(): Promise<void> {
    if (this.robotNewFeatureSet !== null && this.robotNewFeatureInfo !== null) return;
    const result = C.requireOk(await C.getInitStatus(this.deps.session), 'app_get_init_status').result;
    this.robotNewFeatureSet = featureSetFromInitStatus(result);
    this.robotNewFeatureInfo = newFeatureInfoFromInitStatus(result);
    this.changed();
  }

  /** Null when the robot did not reply at all, so a read that timed out is not mistaken for an answer. */
  private async readFeature(d: FeatureDef): Promise<{ state: FeatureState; answered: boolean } | null> {
    let resp: V1Response;
    try {
      resp = d.settingName ? await C.getRobotSetting(this.deps.session, d.settingName) : await this.deps.session.sendCommand(d.getMethod);
    } catch {
      return null;
    }
    const parsed = parseFeatureReply(d, resp.result);
    return {
      state: { id: d.id, value: parsed?.value ?? null, key: parsed?.key ?? null, reply: parsed?.reply ?? null },
      answered: !resp.error,
    };
  }

  /** Reads every option the robot's flags offer; stops at the first one the robot does not reply to, so an offline robot costs one timeout. */
  async fetchFeatures(): Promise<void> {
    try { await this.fetchRobotFeatureSet(); } catch { /* the server's flags stand in */ }
    const defs = supportedFeatures(this.effectiveNewFeatureSet());
    this.featuresLoading = true;
    this.changed();
    try {
      const states: FeatureState[] = [];
      for (const d of featureReadOrder(defs)) {
        const read = await this.readFeature(d);
        if (!read) break;
        if (read.answered && featureToggleable(d, read.state.value)) states.push(read.state);
      }
      this.features = withoutReplaced(states.sort((a, b) => defs.findIndex((d) => d.id === a.id) - defs.findIndex((d) => d.id === b.id)));
    } finally {
      this.featuresLoading = false;
      this.changed();
    }
  }

  /**
   * Writes one option: tries each parameter shape until the robot stops refusing the shape, starting
   * with the one it took last time, then reads the option back so the page shows what the robot
   * holds. Throws the robot's refusal, if any, after that.
   */
  async setFeature(id: string, value: number): Promise<void> {
    const current = this.features.find((f) => f.id === id);
    const d = featureDef(id);
    if (!current || !d) throw new UserError('That option is not offered on this robot');
    if (d.choices ? !d.choices.some((c) => c.value === value) : value !== 0 && value !== 1) throw new UserError('Invalid value for this option');
    let method: string;
    let sent: V1Response | null = null;
    if (d.settingName) {
      method = 'app_set_robot_setting';
      sent = await C.setRobotSetting(this.deps.session, d.settingName, value);
    } else {
      method = d.setMethod;
      // A switch on a bit mask (carpet first) still sends 0 or 1; the read keeps the whole value.
      const candidates = featureSetParamCandidates(d, current, value);
      if (candidates.length === 0) throw new UserError('Read the option again before changing it');
      for (const i of betaSetTryOrder(candidates.length, this.featureShapes.get(id))) {
        sent = await this.deps.session.sendCommandRaw(method, candidates[i] as JsonValue);
        if (!sent.error) this.featureShapes.set(id, i);
        if (!BETA_SHAPE_REFUSAL_CODES.has(errorCode(sent.error) ?? 0)) break;
      }
    }
    // Read back before requireOk on purpose: a refused write still refreshes the row with the robot's real value.
    const read = await this.readFeature(d);
    if (read && read.answered && featureToggleable(d, read.state.value)) {
      this.features = this.features.map((f) => (f.id === id ? read.state : f));
      this.changed();
    }
    if (sent) C.requireOk(sent, method);
  }

  async fetchDnd(): Promise<void> {
    const o = firstObject((await C.getDndTimer(this.deps.session)).result);
    if (!o) return;
    this.dnd = {
      enabled: intField(o, 'enabled') === 1,
      startHour: intField(o, 'start_hour') ?? 22,
      startMinute: intField(o, 'start_minute') ?? 0,
      endHour: intField(o, 'end_hour') ?? 8,
      endMinute: intField(o, 'end_minute') ?? 0,
    };
    this.changed();
  }

  async setDnd(sh: number, sm: number, eh: number, em: number): Promise<void> {
    await C.setDndTimer(this.deps.session, sh, sm, eh, em);
    this.dnd = { enabled: true, startHour: sh, startMinute: sm, endHour: eh, endMinute: em };
    this.changed();
  }

  async disableDnd(): Promise<void> {
    await C.closeDndTimer(this.deps.session);
    this.dnd = this.dnd ? { ...this.dnd, enabled: false } : null;
    this.changed();
  }

  // ---- Saved maps ---------------------------------------------------------------------------

  async fetchFloorMaps(): Promise<void> {
    const o = firstObject((await C.getMultiMapsList(this.deps.session)).result);
    if (!o) return;
    const info = o['map_info'];
    if (!Array.isArray(info)) return;
    this.maxFloorMaps = intField(o, 'max_multi_map');
    const maps: FloorMap[] = [];
    for (const e of info) {
      if (!isObject(e)) continue;
      const flag = intField(e, 'mapFlag');
      if (flag === null) continue;
      // An unnamed map must still be listed: saving zones relies on the count being right.
      const name = typeof e['name'] === 'string' && e['name'].trim() ? e['name'] : `Map ${flag + 1}`;
      maps.push({ name, mapFlag: flag });
    }
    this.floorMaps = maps;
    this.floorMapsLoaded = true;
    this.changed();
  }

  manageBlockedReason(): string | null {
    return this.isBusy() ? BUSY : null;
  }

  private async requireFloorMap(mapFlag: number): Promise<FloorMap> {
    const blocked = this.manageBlockedReason();
    if (blocked) throw new MapEditError(blocked);
    try { await this.fetchFloorMaps(); } catch { /* checked below */ }
    if (!this.floorMapsLoaded) throw new MapEditError("Couldn't read the robot's saved maps. Nothing was changed.");
    const map = this.floorMaps.find((m) => m.mapFlag === mapFlag);
    if (!map) throw new MapEditError('That map is no longer on the robot');
    return map;
  }

  async switchFloor(mapFlag: number): Promise<void> {
    const blocked = this.manageBlockedReason();
    if (blocked) throw new MapEditError(blocked);
    await C.loadMultiMap(this.deps.session, mapFlag);
    this.currentFloorFlagLocal = mapFlag;
    await this.refreshStatus();
    this.rawSegmentTable = null;
    this.clearMap();
    try { await this.fetchMap(); } catch { /* the map loop retries */ }
  }

  renameFloorMap(mapFlag: number, name: string): Promise<void> {
    return this.editMutex.run(async () => {
      const clean = name.trim();
      const problem = mapNameBlocker(clean);
      if (problem) throw new MapEditError(problem);
      await this.requireFloorMap(mapFlag);
      await C.nameMultiMap(this.deps.session, mapFlag, clean);
      await this.fetchFloorMaps();
      if (this.floorMaps.find((m) => m.mapFlag === mapFlag)?.name !== clean) throw new MapEditError(NOT_CONFIRMED);
    });
  }

  deleteFloorMap(mapFlag: number): Promise<void> {
    return this.editMutex.run(async () => {
      await this.requireFloorMap(mapFlag);
      await C.deleteMap(this.deps.session, mapFlag);
      await this.fetchFloorMaps();
      if (this.floorMaps.some((m) => m.mapFlag === mapFlag)) throw new MapEditError(NOT_CONFIRMED);
      this.roomIds = [];
      this.rawSegmentTable = null;
      this.clearMap();
    });
  }

  /**
   * Put mapFlag back to its on-robot backup; everything changed since the backup is lost. Only for the
   * loaded map, the case that was captured. Confirmed by the map's saved time changing.
   */
  restoreFloorMapBackup(mapFlag: number): Promise<void> {
    return this.editMutex.run(async () => {
      const floor = await this.requireFloorMap(mapFlag);
      if (floor.backupAt === null) throw new MapEditError('This map has no backup on the robot yet');
      if (mapFlag !== this.currentFloorFlag()) throw new MapEditError('Load this map first, then restore its backup');
      C.requireOk(await C.restoreMapBackup(this.deps.session, mapFlag), 'recover_multi_map');
      let restored = false;
      for (let attempt = 0; attempt < STATUS_READBACK_ATTEMPTS && !restored; attempt++) {
        if (attempt > 0) await sleep(STATUS_READBACK_DELAY_MS);
        try { await this.fetchFloorMaps(); } catch { /* try again */ }
        const savedAt = this.floorMaps.find((m) => m.mapFlag === mapFlag)?.savedAt ?? null;
        restored = savedAt !== null && savedAt !== floor.savedAt;
      }
      if (!restored) throw new MapEditError(NOT_CONFIRMED);
      await this.refreshStatus();
      this.rawSegmentTable = null;
      try { await this.fetchMap(); } catch { /* the next poll fetches it */ }
      try { await this.rooms(); } catch { /* names come with the next read */ }
    });
  }

  startMapping(): Promise<void> {
    return this.editMutex.run(async () => {
      const blocked = this.manageBlockedReason();
      if (blocked) throw new MapEditError(blocked);
      try { await this.fetchFloorMaps(); } catch { /* checked below */ }
      if (!this.floorMapsLoaded) throw new MapEditError("Couldn't read the robot's saved maps. Nothing was started.");
      const max = this.maxFloorMaps ?? 1;
      if (this.floorMaps.length >= max) {
        throw new MapEditError(max <= 1
          ? 'The robot still has a saved map. Delete it first to map the home again.'
          : `The robot already holds ${max} maps, its limit. Delete one first.`);
      }
      await C.startBuildMap(this.deps.session);
    });
  }

  /** Off keeps only `keepMapFlag`; the robot deletes every other saved map. Confirmed by status. */
  setMultiLevel(enabled: boolean, keepMapFlag: number | null): Promise<void> {
    return this.editMutex.run(async () => {
      const blocked = this.manageBlockedReason();
      if (blocked) throw new MapEditError(blocked);
      await this.refreshStatus();
      const lab = this.status.labStatus;
      if (lab === undefined) throw new MapEditError("The robot didn't report its map settings. Nothing was changed.");
      if (enabled) {
        // 3, what the official app sent. From 0 the multi-level bit alone was refused (issue #17).
        await C.setLabStatus(this.deps.session, lab | LAB_STATUS_MAP_SAVING | LAB_STATUS_MULTI_LEVEL, null);
        await C.setSwitchMapMode(this.deps.session, SWITCH_MAP_MODE_MANUAL);
      } else {
        try { await this.fetchFloorMaps(); } catch { /* checked below */ }
        if (!this.floorMapsLoaded) throw new MapEditError("Couldn't read the robot's saved maps. Nothing was changed.");
        const keep = keepMapFlag ?? (this.floorMaps.length === 1 ? this.floorMaps[0]!.mapFlag : null);
        if (keep === null) throw new MapEditError('Pick the map to keep');
        if (!this.floorMaps.some((m) => m.mapFlag === keep)) throw new MapEditError('That map is no longer on the robot');
        await C.setLabStatus(this.deps.session, lab & ~LAB_STATUS_MULTI_LEVEL, keep);
      }
      if (!(await this.awaitStatus((s) => multiLevelEnabled(s) === enabled))) throw new MapEditError(NOT_CONFIRMED);
      try { await this.fetchFloorMaps(); } catch { /* best effort */ }
      if (!enabled) {
        this.rawSegmentTable = null;
        try { await this.fetchMap(); } catch { /* best effort */ }
        try { await this.rooms(); } catch { /* best effort */ }
      }
    });
  }

  /** Turn on map saving for a robot that reports it off (one that never met the official app). */
  enableMapSaving(): Promise<void> {
    return this.editMutex.run(async () => {
      const blocked = this.manageBlockedReason();
      if (blocked) throw new MapEditError(blocked);
      await this.enableMapSavingLocked();
    });
  }

  private async enableMapSavingLocked(): Promise<void> {
    await this.refreshStatus();
    const lab = this.status.labStatus;
    if (lab === undefined) throw new MapEditError("The robot didn't report its map settings. Nothing was changed.");
    if ((lab & LAB_STATUS_MAP_SAVING) !== 0) return;
    await C.setLabStatus(this.deps.session, lab | LAB_STATUS_MAP_SAVING, null);
    if (!(await this.awaitStatus((s) => mapSavingEnabled(s) === true))) throw new MapEditError(NOT_CONFIRMED);
  }

  setSmartMapSwitching(smart: boolean): Promise<void> {
    return this.editMutex.run(async () => {
      const blocked = this.manageBlockedReason();
      if (blocked) throw new MapEditError(blocked);
      const mode = smart ? SWITCH_MAP_MODE_SMART : SWITCH_MAP_MODE_MANUAL;
      await C.setSwitchMapMode(this.deps.session, mode);
      if (!(await this.awaitStatus((s) => s.switchMapMode === mode))) throw new MapEditError(NOT_CONFIRMED);
    });
  }

  /** Status caught up 1-2 s after the robot's "ok" in the capture, so poll briefly. */
  private async awaitStatus(check: (s: VacuumStatus) => boolean): Promise<boolean> {
    for (let attempt = 0; attempt < STATUS_READBACK_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(STATUS_READBACK_DELAY_MS);
      await this.refreshStatus();
      if (check(this.status)) return true;
    }
    return false;
  }

  /** Save the map the robot just built, as the official app does after a mapping run. */
  saveNewMap(): Promise<void> {
    return this.editMutex.run(async () => {
      const blocked = this.manageBlockedReason();
      if (blocked) throw new MapEditError(blocked);
      if (!unsavedMapPresent(this.status)) throw new MapEditError('There is no new map to save');
      try { await this.fetchFloorMaps(); } catch { /* compared below */ }
      const before = new Set(this.floorMaps.map((m) => m.mapFlag));
      // With map saving off the robot refuses manual_segment_map ("The Lab Status is disable").
      if (mapSavingEnabled(this.status) === false) await this.enableMapSavingLocked();
      const stillUnsaved = unsavedMapPresent(this.status);
      if (stillUnsaved) await C.saveNewMap(this.deps.session);
      await this.fetchFloorMaps();
      const added = this.floorMaps.filter((m) => !before.has(m.mapFlag));
      if (added.length === 0) throw new MapEditError(stillUnsaved ? NOT_CONFIRMED : MAP_NOT_KEPT);
      await this.refreshStatus();
      this.rawSegmentTable = null;
      try { await this.fetchMap(); } catch { /* best effort */ }
      try { await this.rooms(); } catch { /* best effort */ }
    });
  }

  // ---- Map editing --------------------------------------------------------------------------

  /**
   * Write the edited no-go zones, walls, carpets and thresholds. Each category is a full-set
   * command sent only when it changed; the edit counts once a fresh map shows every category.
   */
  saveMapEdits(noGoZones: MapZone[], walls: VirtualWall[], carpets: MapZone[], thresholds: MapZone[]): Promise<void> {
    return this.editMutex.run(async () => {
      const map = this.editableMap();
      try { await this.fetchFloorMaps(); } catch { /* checked below */ }
      if (!this.floorMapsLoaded) throw new MapEditError("Couldn't read the robot's saved maps, so nothing was saved. Try again.");
      const mapIndex = saveMapIndex(this.floorMaps);
      const indexProblem = mapIndexBlocker(mapIndex);
      if (indexProblem) throw new MapEditError(indexProblem);
      const index = mapIndex!;
      const restrictionsChanged = !restrictionsMatch(map, noGoZones, map.noMopZones, walls);
      const carpetsChanged = !sameZones(carpets, map.carpetAreas);
      const thresholdsChanged = !sameZones(thresholds, map.thresholds);
      if (!restrictionsChanged && !carpetsChanged && !thresholdsChanged) return;
      if (restrictionsChanged) {
        const blocker = restrictionSaveBlocker(map, mapIndex);
        if (blocker) throw new MapEditError(blocker);
      }
      await C.inEditSession(this.deps.session, async () => {
        if (restrictionsChanged) await C.saveMap(this.deps.session, noGoZones, walls, index);
        if (carpetsChanged) await C.setCarpetAreas(this.deps.session, carpets, index, map.carpetFlagsPresent);
        if (thresholdsChanged) await C.setThresholds(this.deps.session, thresholds, index);
      });
      const roundCount = carpets.filter(isRoundCarpet).length;
      const confirmed = await this.awaitMap((m) =>
        restrictionsMatch(m, noGoZones, map.noMopZones, walls) &&
        sameZones(carpets, m.carpetAreas) &&
        m.carpetAreas.filter(isRoundCarpet).length === roundCount &&
        sameZones(thresholds, m.thresholds));
      if (!confirmed) throw new MapEditError(NOT_CONFIRMED);
    });
  }

  /** Split a room along A-B (robot mm); a refused line is tried once more reversed. The map must gain a room. */
  splitRoom(segment: number, a: [number, number], b: [number, number]): Promise<void> {
    return this.editMutex.run(async () => {
      const map = this.editableMap();
      const before = new Set(map.rooms.map((r) => r.id));
      if (!before.has(segment)) throw new MapEditError('That room is not on the current map');
      const attempts = C.splitLineAttempts(a, b);
      for (let i = 0; i < attempts.length; i++) {
        const [p, q] = attempts[i]!;
        try {
          await C.splitSegment(this.deps.session, segment, p[0], p[1], q[0], q[1]);
          break;
        } catch (e) {
          if (!(e instanceof RobotCommandError) || e.code !== C.SPLIT_FAILED_CODE || i === attempts.length - 1) throw e;
          // The robot sends a second, late error for a refused split; try again once it has passed.
          await sleep(SPLIT_RETRY_DELAY_MS);
        }
      }
      const done = await this.awaitMap((m) => m.rooms.some((r) => !before.has(r.id)));
      if (!done) throw new MapEditError(NOT_CONFIRMED);
      try { await this.rooms(); } catch { /* best effort */ }
    });
  }

  /** Merge two neighbouring rooms. The map must lose one of the two ids. */
  mergeRooms(segA: number, segB: number): Promise<void> {
    return this.editMutex.run(async () => {
      const map = this.editableMap();
      const ids = new Set(map.rooms.map((r) => r.id));
      if (segA === segB || !ids.has(segA) || !ids.has(segB)) throw new MapEditError('Pick two different rooms on the current map');
      await C.mergeSegment(this.deps.session, segA, segB);
      const done = await this.awaitMap((m) => {
        const now = new Set(m.rooms.map((r) => r.id));
        return !now.has(segA) || !now.has(segB);
      });
      if (!done) throw new MapEditError(NOT_CONFIRMED);
      try { await this.rooms(); } catch { /* best effort */ }
    });
  }

  /** Set a room's floor type. Returns false when this robot's map does not report floor types. */
  setFloorMaterial(segment: number, material: number, direction: number | null): Promise<boolean> {
    return this.editMutex.run(async () => {
      const map = this.editableMap();
      if (!map.rooms.some((r) => r.id === segment)) throw new MapEditError('That room is not on the current map');
      if (direction !== null && material !== FloorMaterial.WOOD) throw new MapEditError('Only wood floors have a direction');
      await C.inEditSession(this.deps.session, () => C.setSegmentGroundMaterial(this.deps.session, segment, material, direction));
      if (Object.keys(map.segmentMaterials).length === 0) {
        try { await this.fetchMap(); } catch { /* best effort */ }
        return false;
      }
      const done = await this.awaitMap((m) =>
        m.segmentMaterials[segment] === material && (direction === null || m.segmentMaterialDirections[segment] === direction));
      if (!done) throw new MapEditError(NOT_CONFIRMED);
      return true;
    });
  }

  /** Fails when `segment` can't be given a room, so the caller can stop before it creates a cloud room that would be left unused. */
  checkRoomTable(segment: number): Promise<void> {
    return this.editMutex.run(async () => { await this.readSegmentTable(segment); });
  }

  private async readSegmentTable(segment: number): Promise<C.SegmentEntry[]> {
    const map = this.editableMap();
    if (!map.rooms.some((r) => r.id === segment)) throw new MapEditError('That room is not on the current map');
    await this.rooms();
    const table = this.rawSegmentTable;
    if (!table) throw new MapEditError('The robot did not return its room table. Nothing was changed.');
    return table;
  }

  /**
   * Point `segment` at cloud room `roomId` with name_segment, sending the whole table with only this
   * entry changed (and `tagId`, a room type's tag, when given). The robot may renumber segments in
   * its answer; the check follows that. Confirmed by reading the table back.
   */
  assignRoom(segment: number, roomId: number, tagId: number | null = null): Promise<void> {
    return this.editMutex.run(async () => {
      const table = await this.readSegmentTable(segment);
      const existing = table.find((e) => e.segment === segment);
      const entry: C.SegmentEntry = { segment, roomId: String(roomId), tagId: tagId ?? existing?.tagId ?? C.NEW_SEGMENT_TAG };
      const resp = await C.nameSegment(this.deps.session, [...table.filter((e) => e.segment !== segment), entry]);
      const finalSegment = C.parseSegmentRenumbering(resp.result).get(segment) ?? segment;
      // The table can lag the robot's answer by a moment, so look a few times before giving up.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(STATUS_READBACK_DELAY_MS);
        await this.rooms();
        if (this.rawSegmentTable?.find((e) => e.segment === finalSegment)?.roomId === String(roomId)) return;
      }
      throw new MapEditError(NOT_CONFIRMED);
    });
  }

  /** Each room's type tag, as the robot's room table lists it. */
  roomTags(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const e of this.rawSegmentTable ?? []) if (e.tagId !== null) out[e.segment] = e.tagId;
    return out;
  }
}

// ---- Parsing helpers ------------------------------------------------------------------------

function parseSegmentTableOrNull(result: unknown): C.SegmentEntry[] | null {
  return C.parseSegmentTable(result);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : asInt(v) ?? 0;
}

export function parseStatus(result: unknown): VacuumStatus | null {
  const o = firstObject(result);
  if (!o) return null;
  const s: VacuumStatus = {};
  for (const [field, wire] of Object.entries(STATUS_FIELDS) as Array<[keyof VacuumStatus, string]>) {
    const v = o[wire];
    if (typeof v === 'number' && Number.isFinite(v)) s[field] = v;
  }
  return s;
}

/** Fresh values win; fields the robot left out keep their last value. */
export function mergeStatus(old: VacuumStatus, fresh: VacuumStatus): VacuumStatus {
  return { ...old, ...fresh };
}

/** Unsolicited status pushes: 120 error, 121 state, 122 battery, 123 fan, 124 water, 133 charge, 134 dry. */
export function applyDpsPush(s: VacuumStatus, push: Map<number, unknown>): VacuumStatus {
  const next = { ...s };
  const set = (code: number, field: keyof VacuumStatus) => {
    const v = asInt(push.get(code));
    if (v !== null) next[field] = v;
  };
  set(121, 'state');
  set(122, 'battery');
  set(123, 'fanPower');
  set(124, 'waterBoxCustomMode');
  set(120, 'errorCode');
  set(133, 'chargeStatus');
  set(134, 'dryStatus');
  return next;
}

export function parseCleanRecord(result: unknown, recordId: number): CleanRecord | null {
  const element = Array.isArray(result) ? result[0] : result;
  if (element === undefined || element === null) return null;
  if (Array.isArray(element)) {
    if (element.length < 6) return null;
    return {
      beginEpoch: asInt(element[0]) ?? recordId,
      endEpoch: asInt(element[1]) ?? 0,
      durationSeconds: asInt(element[2]) ?? 0,
      areaMm2: asInt(element[3]) ?? 0,
      errorCode: asInt(element[4]) ?? 0,
      complete: asInt(element[5]) ?? 0,
    };
  }
  if (isObject(element)) {
    return {
      beginEpoch: asInt(element['begin']) ?? recordId,
      endEpoch: asInt(element['end']) ?? 0,
      durationSeconds: asInt(element['duration']) ?? 0,
      areaMm2: asInt(element['area']) ?? 0,
      errorCode: asInt(element['error']) ?? 0,
      complete: asInt(element['complete']) ?? 0,
    };
  }
  return null
}

export function parseCronTimer(id: string, enabled: boolean, cron: string): CleanTimer | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const minute = asInt(parts[0]);
  const hour = asInt(parts[1]);
  if (minute === null || hour === null) return null;
  const weekdays = parts[4] === '*' ? [] : [...new Set(parts[4]!.split(',').map((d) => asInt(d)).filter((d): d is number => d !== null))];
  return { id, enabled, hour, minute, weekdays };
}
