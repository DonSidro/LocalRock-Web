import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseLegacyMap } from '../server/map/legacy.js';
import type { MapZone, ParsedMap, VirtualWall } from '../shared/map.js';
import { writeLegacyMap } from './mapWriter.js';

/*
 * A simulated Roborock vacuum for development and screenshots. It answers the RPCs LocalRock uses
 * with plausible values, keeps state, runs a pretend clean, and applies map edits to a real map
 * (the fixture), so the app's read-back checks see them.
 */

type Reply = { result: unknown } | { error: { code: number; message: string } };
export type Respond = (reply: Reply, delayMs?: number) => void;

export interface RobotConfig {
  duid: string;
  name: string;
  localKey: string;
  productId: string;
  model: string;
  newFeatureSet: string;
  /** Decimal feature bits; bit 25 offers the auto-empty modes. */
  featureSet?: string;
  /** The flags the robot itself reports in app_get_init_status, when they differ from the server's. */
  robotNewFeatureSet?: string;
  fv: string;
  format: 'legacy' | 'b01';
}

export const ROOM_NAMES: Record<number, string> = {
  16: 'Living room', 17: 'Kitchen', 18: 'Bedroom', 19: 'Office', 20: 'Bathroom', 21: 'Hall',
  22: 'Laundry', 24: 'Kids room', 25: 'Entrance', 26: 'Dining room',
};

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)));

const ok = { result: ['ok'] };

export class SimRobot {
  status: Record<string, number>;
  private mopMode = 300;
  private readonly baseMap: Buffer | null;
  private readonly b01Map: Buffer | null;
  private pixels: Uint8Array | null = null;
  private image = { left: 0, top: 0, width: 0, height: 0 };
  private noGo: MapZone[] = [];
  private noMop: MapZone[] = [];
  private walls: VirtualWall[] = [];
  private carpets: MapZone[] = [];
  private thresholds: MapZone[] = [];
  /** Furniture records (block 25): a sofa and a bed, plus a hidden record that must never be touched. */
  private furniture: number[][] = [
    furnitureBytes(1, 46, 3, [[24_000, 26_000], [26_000, 26_000], [26_000, 25_164], [24_000, 25_164]]),
    furnitureBytes(2, 45, 1, [[27_000, 24_400], [28_200, 24_400], [28_200, 22_000], [27_000, 22_000]]),
    furnitureBytes(3, 50, 0, [[23_000, 23_000], [23_400, 23_000], [23_400, 22_600], [23_000, 22_600]], 0),
  ];
  private materials = new Map<number, number>();
  private directions = new Map<number, number>();
  private path: Array<{ x: number; y: number }> = [];
  private robotPos: { x: number; y: number; angle: number } | null = null;
  private dock: { x: number; y: number; angle: number } | null = null;
  private pathIndex = 0;
  private roomTable: Array<[number, string, number]> = [];
  private maps: Array<{ mapFlag: number; name: string }> = [{ mapFlag: 0, name: 'Home' }];
  private savedAt = new Map<number, number>();
  private backups = new Map<number, number>();
  private sequence: number[] = [];
  private roomModes: Array<Record<string, number>> = [];
  private timers: Array<{ id: string; on: boolean; cron: string }> = [{ id: '1700000000', on: true, cron: '0 9 * * 1,2,3,4,5' }];
  private settings = { volume: 80, lock: 0, led: 1, carpet: 1, wash: 1, smartWash: 0, washInterval: 900, dust: 0, waterTemp: 2 };
  private dryer: Record<string, unknown> = { status: 1, on: { cliff_on: 0, dry_time: 10_800 }, off: { cliff_off: 0 }, heating_film_time: 0 };
  private valley = { enabled: 0, start_hour: 22, start_minute: 0, end_hour: 6, end_minute: 0 };
  private opts = { brush: 1, collision: 1, carpetBoost: 1, pattern: 0, battery: 0 };
  private matter = { state: 'KeyNotExit', code: '', readyAt: 0 };
  private ota = { state: 'idle', progress: 0 };
  private voice = { on: 1, sid: 1, installing: 0, progress: 0 };

  /** Downloads for ~6 s, installs for ~4 s, then reports the new version. */
  startOta(version: string): void {
    this.ota = { state: 'downloading', progress: 0 };
    const tick = setInterval(() => {
      if (this.ota.state === 'downloading') {
        this.ota.progress = Math.min(100, this.ota.progress + 20);
        if (this.ota.progress >= 100) this.ota = { state: 'installing', progress: 0 };
      } else if (this.ota.state === 'installing') {
        this.ota = { state: 'idle', progress: 0 };
        this.config.fv = version;
        clearInterval(tick);
      }
    }, 1_200);
  }
  private dnd = { start_hour: 22, start_minute: 0, end_hour: 8, end_minute: 0, enabled: 1 };
  private consumables = { main_brush_work_time: 412_000, side_brush_work_time: 655_000, filter_work_time: 120_000, sensor_dirty_time: 98_000, cleaning_brush_work_times: 42, strainer_work_times: 120 };
  private cleanSeconds = 0;
  private returnAt = 0;
  onStateChange: (() => void) | null = null;

  constructor(readonly config: RobotConfig) {
    this.status = {
      battery: 100, state: 8, fan_power: 102, water_box_mode: 201, clean_area: 0, clean_time: 0, error_code: 0,
      water_box_status: 1, charge_status: 1, dock_error_status: 0, dock_type: 8, dss: 2, dry_status: 0, rdt: 0, seq_type: 0,
      map_status: 3, lab_status: 1, switch_map_mode: 1, in_cleaning: 0, clean_percent: 0,
    };
    if (config.format === 'legacy') {
      this.baseMap = fixture('real_map_sample.bin');
      this.b01Map = null;
      const parsed = parseLegacyMap(this.baseMap);
      this.loadFromParsed(parsed);
      for (const r of parsed.rooms) {
        if (ROOM_NAMES[r.id]) this.roomTable.push([r.id, String(1000 + r.id), r.id % 14]);
      }
      this.sequence = parsed.rooms.map((r) => r.id);
    } else {
      this.baseMap = null;
      this.b01Map = gunzipSync(fixture('b01_map_sample.bin.gz'));
      this.status['fan_power'] = 110;
      this.status['water_box_mode'] = 209;
      this.mopMode = 306;
      this.status['lab_status'] = 3;
      for (let id = 10; id <= 19; id++) this.roomTable.push([id, String(2000 + id), 1]);
    }
  }

  private loadFromParsed(p: ParsedMap): void {
    this.pixels = new Uint8Array(p.originalGrid!);
    this.image = { left: p.pixelOffsetLeft, top: p.pixelOffsetTop, width: p.width, height: p.height };
    this.noGo = p.noGoZones;
    this.noMop = p.noMopZones;
    this.walls = p.virtualWalls;
    this.carpets = p.carpetAreas;
    this.thresholds = p.thresholds;
    this.materials = new Map(Object.entries(p.segmentMaterials).map(([k, v]) => [Number(k), v]));
    this.directions = new Map(Object.entries(p.segmentMaterialDirections).map(([k, v]) => [Number(k), v]));
    this.path = p.pathMm.map((pt) => ({ x: pt.x, y: pt.y }));
    this.robotPos = p.robotMm;
    this.dock = p.chargerMm;
  }

  /** The live map, or with cruise a Cruise record's map with its points. */
  mapBytes(cruise = false): Buffer {
    if (this.b01Map) return this.b01Map;
    return writeLegacyMap(this.baseMap!, {
      pixels: this.pixels!, noGo: this.noGo, noMop: this.noMop, walls: this.walls, carpets: this.carpets,
      thresholds: this.thresholds, materials: this.materials, directions: this.directions, robot: this.robotPos, furniture: this.furniture,
      obstacles: [{ x: 25_200, y: 24_800, type: 2, photoId: 'OBS0001' }, { x: 26_600, y: 26_000, type: 0, photoId: 'OBS0002' }],
      // The map look's layers; SIM_FLOOR_PLAN=1 also sends block 55, for the floor-plan look.
      look: {
        carpetRoom: 18,
        washTrip: [40, 80],
        eraser: process.env['SIM_ERASER'] ? [{ x0: 20_000, y0: 30_000, x1: 23_000, y1: 30_000, x2: 23_000, y2: 27_000, x3: 20_000, y3: 27_000, kind: 'ERASER' }] : [],
        floorPlan: process.env['SIM_FLOOR_PLAN'] === '1',
      },
      ...(cruise ? { patrol: { taskId: 77, points: [{ x: 25_000, y: 25_000, photoIds: ['PH1', 'PH2'] }, { x: 27_000, y: 25_500, photoIds: ['PH3'] }] } } : {}),
    });
  }

  homeRooms(): Array<{ id: number; name: string }> {
    if (this.config.format === 'b01') return [];
    return Object.entries(ROOM_NAMES).map(([seg, name]) => ({ id: 1000 + Number(seg), name }));
  }

  private setState(state: number, extra: Record<string, number> = {}): void {
    Object.assign(this.status, { state, ...extra });
    this.onStateChange?.();
  }

  /** One second of pretend activity. */
  tick(): void {
    const s = this.status;
    const cleaning = [5, 11, 17, 18].includes(s['state']!);
    if (cleaning) {
      this.cleanSeconds++;
      s['clean_time'] = this.cleanSeconds;
      s['clean_area'] = this.cleanSeconds * 60_000;
      s['clean_percent'] = Math.min(100, Math.floor(this.cleanSeconds / 1.2));
      if (this.cleanSeconds % 20 === 0) s['battery'] = Math.max(5, s['battery']! - 1);
      if (this.path.length > 0) {
        this.pathIndex = (this.pathIndex + 25) % this.path.length;
        const p = this.path[this.pathIndex]!;
        this.robotPos = { x: p.x, y: p.y, angle: 90 };
      }
      if (this.cleanSeconds >= 120) {
        this.returnAt = Date.now() + 6_000;
        this.setState(6);
      }
    } else if (s['state'] === 6 && this.returnAt && Date.now() >= this.returnAt) {
      this.returnAt = 0;
      if (this.dock) this.robotPos = { ...this.dock };
      this.setState(8, { in_cleaning: 0, charge_status: 1 });
    } else if (s['state'] === 8 && s['battery']! < 100) {
      s['battery'] = Math.min(100, s['battery']! + 1);
      if (s['battery'] === 100) this.setState(100);
    } else if ((s['state'] === 22 || s['state'] === 23) && Date.now() >= this.returnAt) {
      this.setState(8);
    }
    if (s['dry_status'] === 1) {
      s['rdt'] = Math.max(0, s['rdt']! - 1);
      if (s['rdt'] === 0) s['dry_status'] = 0;
    }
  }

  private startCleaning(state: number): void {
    if (this.status['state'] !== 10) this.cleanSeconds = 0;
    this.setState(state, { in_cleaning: 1, charge_status: 0, clean_percent: this.status['state'] === 10 ? this.status['clean_percent']! : 0 });
  }

  /** Reply to one RPC. need_retry commands get ["retry"] first, then the result a moment later. */
  handle(method: string, params: unknown, respond: Respond): void {
    const wrapped = typeof params === 'object' && params !== null && !Array.isArray(params) && (params as Record<string, unknown>)['need_retry'] === 1;
    const data = wrapped ? (params as Record<string, unknown>)['data'] : params;
    const later = (reply: Reply) => {
      if (wrapped) {
        respond({ result: ['retry'] });
        respond(reply, 1_200);
      } else {
        respond(reply, 150);
      }
    };
    const p0 = Array.isArray(params) ? params[0] : params;
    const s = this.status;
    switch (method) {
      case 'get_status': return respond({ result: [{ ...s, msg_ver: 2, msg_seq: 1 }] });
      // Matter: the key "downloads" over two polls, then a code is on offer.
      case 'matter.get_status': {
        if (this.matter.state === 'KeyDownloading' && Date.now() >= this.matter.readyAt) {
          this.matter.state = 'Ready';
          this.matter.code = String(10_000_000_000 + Math.floor(Math.random() * 89_999_999_999));
        }
        const ready = this.matter.state === 'Ready' || this.matter.state === 'Joined';
        return respond({ result: { status: this.matter.state, ...(ready ? { ManualPairingCode: this.matter.code, QrCode: `MT:Y.K90${this.matter.code.slice(0, 8)}0648G00` } : {}) } });
      }
      case 'matter.dnld_key':
        if (this.matter.state === 'Joined') return respond({ error: { code: -10007, message: 'joined' } });
        this.matter.state = 'KeyDownloading';
        this.matter.readyAt = Date.now() + 2_500;
        return respond(ok);
      case 'matter.reset': this.matter.state = 'KeyNotExit'; return respond(ok);
      case 'app_start_pet_patrol':
        if (s['in_cleaning'] !== 0 || (s['state'] !== 8 && s['state'] !== 100)) return respond({ error: { code: -10007, message: 'busy' } });
        this.setState(32);
        setTimeout(() => this.setState(8), 6_000);
        return respond(ok);
      case 'get_voice_service_switch': return respond({ result: { data: this.voice.on } });
      case 'set_voice_service_switch': {
        const o = params as Record<string, number>;
        if (Array.isArray(params) || typeof o['data'] !== 'number') return; // other shapes time out on real robots
        this.voice.on = o['data'];
        return respond(ok);
      }
      case 'get_current_sound': return respond({ result: [{ sid_in_use: this.voice.sid, sid_version: 1, sid_in_progress: this.voice.installing, location: 'de', language: this.voice.sid === 7 ? 'de' : 'en' }] });
      case 'get_voice_history_summary': return respond({ result: { min_id: 1, max_id: 3, count: 3 } });
      case 'get_voice_history': return respond({ result: { history: [
        { id: 1, ts: 1763884800, text: 'Hello Rocky, clean the kitchen', speaker: 1 },
        { id: 2, ts: 1763884802, text: 'Starting to clean the kitchen', speaker: 2 },
        { id: 3, ts: 1763884900, text: 'go back to dock', speaker: 1 },
      ] } });
      case 'get_sound_progress': return respond({ result: [{ sid_in_progress: this.voice.installing, progress: this.voice.progress, state: this.voice.installing ? 1 : 3, error: 0 }] });
      case 'dnld_install_sound': {
        const o = params as Record<string, unknown>;
        if (typeof o['sid'] !== 'number' || typeof o['url'] !== 'string') return respond({ error: { code: -10007, message: 'invalid params' } });
        this.voice.installing = o['sid'];
        this.voice.progress = 0;
        const t = setInterval(() => {
          this.voice.progress += 50;
          if (this.voice.progress >= 100) { this.voice.sid = this.voice.installing; this.voice.installing = 0; clearInterval(t); }
        }, 1_500);
        return respond(ok);
      }
      case 'get_ota_state': return respond({ result: [{ ota_state: this.ota.state }] });
      case 'get_ota_progress': return respond({ result: [{ ota_progress: this.ota.progress }] });
      case 'app_get_init_status':
        return respond({ result: [{ local_info: {}, feature_info: [111, 112], new_feature_info: 2 ** 36 + 2 ** 30 + 2 ** 25 + 2 ** 3, new_feature_info_str: this.config.robotNewFeatureSet ?? this.config.newFeatureSet }] });
      // FlexiArm side brush (bit 54): answers [{"status": n}] and takes the wrapped object.
      case 'get_right_brush_stretch_status': return respond({ result: [{ status: this.opts.brush }] });
      case 'set_right_brush_stretch_status': {
        const v = Array.isArray(params) && typeof params[0] === 'object' ? (params[0] as Record<string, number>)['status'] : undefined;
        if (v === undefined) return respond({ error: { code: -10007, message: 'invalid params' } });
        this.opts.brush = v;
        return respond(ok);
      }
      // Collision (bits 36 and 118): a bare number, written as {"status": n}.
      case 'get_collision_avoid_status': return respond({ result: [this.opts.collision] });
      case 'set_collision_avoid_status': {
        const v = (p0 as Record<string, number> | undefined)?.['status'];
        if (typeof v !== 'number') return respond({ error: { code: -10005, message: 'Invalid parameters' } });
        this.opts.collision = v;
        return respond(ok);
      }
      // Carpet boost: an object written back whole.
      case 'get_carpet_mode': return respond({ result: [{ enable: this.opts.carpetBoost, current_high: 500, current_integral: 450, current_low: 400, stall_time: 10 }] });
      case 'set_carpet_mode': {
        const o = p0 as Record<string, number>;
        if (o?.['stall_time'] !== 10) return respond({ error: { code: -10007, message: 'invalid params' } });
        this.opts.carpetBoost = o['enable']!;
        return respond(ok);
      }
      // Cleaning pattern (bit 70) through app_get/set_robot_setting.
      case 'app_get_robot_setting': {
        const name = (params as Record<string, string>)['name'];
        if (name === 'clean_direction_status') return respond({ result: { clean_direction_status: this.opts.pattern } });
        return respond({ error: { code: -10007, message: 'unknown setting' } });
      }
      case 'app_set_robot_setting': {
        const o = params as Record<string, unknown>;
        if (o['name'] !== 'clean_direction_status') return respond({ error: { code: -10007, message: 'unknown setting' } });
        this.opts.pattern = Number(o['status']);
        return respond(ok);
      }
      case 'get_optimize_battery_status': return respond({ result: [this.opts.battery] });
      case 'set_optimize_battery_status': this.opts.battery = Number(p0); return respond(ok);
      case 'app_start': this.startCleaning(5); return respond(ok);
      case 'resume_zoned_clean': this.startCleaning(17); return respond(ok);
      case 'resume_segment_clean': this.startCleaning(18); return respond(ok);
      case 'app_segment_clean': this.startCleaning(18); return respond(ok);
      case 'app_zoned_clean': this.startCleaning(17); return respond(ok);
      case 'app_pause': this.setState(10); return respond(ok);
      case 'app_stop': this.setState(3, { in_cleaning: 0 }); return respond(ok);
      case 'app_charge': this.returnAt = Date.now() + 6_000; this.setState(6); return respond(ok);
      case 'app_goto_target': this.setState(16); setTimeout(() => this.setState(3), 4_000); return respond(ok);
      case 'app_start_build_map': this.setState(29); return respond(ok);
      // Like a Saros 20 Neo: Turbo is refused on its own and taken through set_clean_motor_mode.
      case 'set_custom_mode':
        if (Number(p0) === 103) return respond({ error: { code: -10005, message: 'Invalid type' } });
        s['fan_power'] = Number(p0);
        return respond(ok);
      case 'set_water_box_custom_mode': s['water_box_mode'] = Number(p0); return respond(ok);
      case 'set_mop_mode': this.mopMode = Number(p0); return respond(ok);
      case 'get_mop_mode': return respond({ result: [this.mopMode] });
      case 'app_set_clean_sequence_type': {
        const o = params as Record<string, number>;
        if (Array.isArray(params) || (o['type'] !== 0 && o['type'] !== 1)) return respond({ error: { code: -10007, message: 'invalid params' } });
        s['seq_type'] = o['type']!;
        s['fan_power'] = o['fan_power']!;
        s['water_box_mode'] = o['water_box_mode']!;
        this.mopMode = o['mop_mode']!;
        return respond(ok);
      }
      case 'set_clean_motor_mode': {
        const m = (p0 ?? {}) as Record<string, number>;
        s['fan_power'] = m['fan_power']!;
        s['water_box_mode'] = m['water_box_mode']!;
        this.mopMode = m['mop_mode']!;
        return respond(ok);
      }
      case 'get_consumable': return respond({ result: [this.consumables] });
      case 'reset_consumable': (this.consumables as Record<string, number>)[String(p0)] = 0; return respond(ok);
      case 'get_clean_summary': return respond({ result: { clean_time: 86_400 + 3_600 * 3, clean_area: 412_000_000, clean_count: 57, patrol_count: 1, records: [1760600000, 1760500000, 1760400000, 1760300000] } });
      case 'get_clean_detail': {
        const o = params as Record<string, number>;
        if (o['begin'] !== 1760600000) return respond({ result: {} });
        const ev = (t: number, i: number, e: Record<string, number>) => ({ t, i, e: JSON.stringify(e) });
        return respond({ result: { from: 0, num: 5, more: 0, events: [
          ev(1760600000, 25, { 252: 3, 3: 2, 4: 1, 5: 0, 6: 1 }),
          ev(1760600060, 42, { 2: 16, 421: 1, 422: 14 }),
          ev(1760600600, 52, { 521: 0 }),
          { t: 1760600900, i: 31, e: { 311: 8, 312: 0 } },
          { t: 1760600900, i: 11, e: { 111: 5, 112: 12 } },
        ] } });
      }
      case 'get_clean_record': {
        const begin = Number(p0);
        // Object records like newer firmware; the oldest is a Cruise run.
        if (begin === 1760300000) return respond({ result: { begin, end: begin + 600, duration: 580, area: 0, error: 0, complete: 1, start_type: 2, clean_type: 5, finish_reason: 52 } });
        return respond({ result: { begin, end: begin + 2_700, duration: 2_640, area: 48_500_000, cleaned_area: 52_100_000, error: 0, complete: begin === 1760400000 ? 0 : 1,
          start_type: begin === 1760500000 ? 3 : 2, clean_type: 1, finish_reason: begin === 1760400000 ? 21 : 56, dust_collection_status: 1, wash_count: 2 } });
      }
      case 'get_room_mapping': return respond({ result: this.roomTable });
      case 'find_me':
      case 'app_rc_move':
      case 'start_edit_map':
      case 'end_edit_map':
      case 'set_switch_map_mode':
        if (method === 'set_switch_map_mode') s['switch_map_mode'] = Number((params as Record<string, unknown>)['mode']);
        return respond(ok);
      case 'save_furnitures': {
        const ops = (p0 as { data?: unknown })?.data;
        if (!Array.isArray(ops)) return respond({ error: { code: -10000, message: 'invalid params' } });
        for (const op of ops as number[][]) {
          if (op[0] === 0) { this.furniture = this.furniture.filter((r) => r[21] !== op[1]); continue; }
          const corners = [0, 1, 2, 3].map((i) => [op[2 + i * 2]!, op[3 + i * 2]!] as [number, number]);
          const existing = this.furniture.find((r) => r[21] === op[1]);
          if (existing) {
            const next = furnitureBytes(op[1]!, existing[18]!, existing[19]!, corners, existing[20]!);
            next[16] = existing[16]!; next[17] = existing[17]!; next[22] = existing[22]!;
            this.furniture = this.furniture.map((r) => (r === existing ? next : r));
          } else {
            const id = Math.max(0, ...this.furniture.map((r) => r[21]!)) + 1;
            this.furniture.push(furnitureBytes(id, op[10]!, op[11]!, corners));
          }
        }
        return respond(ok);
      }
      case 'app_rc_start': this.setState(4); return respond(ok);
      case 'app_rc_end': this.setState(3); return respond(ok);
      case 'app_start_collect_dust': this.returnAt = Date.now() + 8_000; this.setState(22); return respond(ok);
      case 'app_start_wash': this.returnAt = Date.now() + 10_000; this.setState(23); return respond(ok);
      case 'app_stop_wash': this.setState(8); return respond(ok);
      case 'app_set_dryer_status': {
        const on = (params as Record<string, number>)['status'] === 1;
        s['dry_status'] = on ? 1 : 0;
        s['rdt'] = on ? 7_200 : 0;
        return respond(ok);
      }
      case 'get_timer': return respond({ result: this.timers.map((t) => [t.id, t.on ? 'on' : 'off', [t.cron, ['start_clean', {}]]]) });
      case 'set_timer': {
        const [id, [onOff, [cron]]] = p0 as [string, [string, [string]]];
        this.timers.push({ id, on: onOff === 'on', cron });
        return respond(ok);
      }
      case 'upd_timer': {
        const [id, onOff] = p0 as [string, string];
        const t = this.timers.find((x) => x.id === id);
        if (t) t.on = onOff === 'on';
        return respond(ok);
      }
      case 'del_timer': this.timers = this.timers.filter((t) => t.id !== p0); return respond(ok);
      case 'get_sound_volume': return respond({ result: [this.settings.volume] });
      case 'change_sound_volume': this.settings.volume = Number(p0); return respond(ok);
      case 'get_child_lock_status': return respond({ result: { lock_status: this.settings.lock } });
      case 'set_child_lock_status': this.settings.lock = (p0 as Record<string, number>)['lock_status']!; return respond(ok);
      case 'get_led_status': return respond({ result: [this.settings.led] });
      case 'set_led_status':
        if (typeof p0 !== 'number') return respond({ error: { code: -10005, message: 'Invalid type' } });
        this.settings.led = p0;
        return respond(ok);
      case 'get_carpet_clean_mode': return respond({ result: [{ carpet_clean_mode: this.settings.carpet }] });
      case 'set_carpet_clean_mode':
        if (Array.isArray(params)) return respond({ error: { code: -10005, message: 'param is not an object' } });
        this.settings.carpet = (params as Record<string, number>)['carpet_clean_mode']!;
        return respond(ok);
      case 'get_wash_towel_mode': return respond({ result: { wash_mode: this.settings.wash } });
      case 'set_wash_towel_mode': this.settings.wash = (p0 as Record<string, number>)['wash_mode']!; return respond(ok);
      case 'get_smart_wash_params': return respond({ result: { smart_wash: this.settings.smartWash, wash_interval: this.settings.washInterval } });
      case 'set_smart_wash_params': {
        const w = p0 as Record<string, number>;
        this.settings.smartWash = w['smart_wash']!;
        this.settings.washInterval = w['wash_interval']!;
        return respond(ok);
      }
      case 'app_get_dryer_setting': return respond({ result: this.dryer });
      case 'app_set_dryer_setting': this.dryer = p0 as Record<string, unknown>; return respond(ok);
      case 'get_wash_water_temperature': return respond({ result: { wash_water_temperature: this.settings.waterTemp } });
      case 'set_wash_water_temperature': this.settings.waterTemp = (p0 as Record<string, number>)['values']!; return respond(ok);
      case 'get_valley_electricity_timer': return respond({ result: [this.valley] });
      case 'set_valley_electricity_timer': {
        const [sh, sm, eh, em] = params as number[];
        this.valley = { enabled: 1, start_hour: sh!, start_minute: sm!, end_hour: eh!, end_minute: em! };
        return respond(ok);
      }
      case 'close_valley_electricity_timer': this.valley.enabled = 0; return respond(ok);
      case 'app_empty_inbuilt_water_tank': {
        if (s['in_cleaning'] !== 0 || (s['state'] !== 8 && s['state'] !== 100)) return respond({ error: { code: -10007, message: 'busy' } });
        this.returnAt = Date.now() + 6_000;
        this.setState(23);
        return respond(ok);
      }
      case 'get_dust_collection_mode': return respond({ result: { mode: this.settings.dust } });
      case 'set_dust_collection_mode': this.settings.dust = (p0 as Record<string, number>)['mode']!; return respond(ok);
      case 'get_dnd_timer': return respond({ result: [this.dnd] });
      case 'set_dnd_timer': Object.assign(this.dnd, p0, { enabled: 1 }); return respond(ok);
      case 'close_dnd_timer': this.dnd.enabled = 0; return respond(ok);
      case 'get_multi_maps_list':
        return respond({ result: [{ max_multi_map: 4, max_bak_map: 1, multi_map_count: this.maps.length, map_info: this.maps.map((m) => ({
          mapFlag: m.mapFlag, name: m.name, add_time: this.savedAt.get(m.mapFlag) ?? 1760000000, length: m.name.length,
          bak_maps: this.backups.has(m.mapFlag) ? [{ mapFlag: m.mapFlag, add_time: this.backups.get(m.mapFlag)! }] : [],
        })) }] });
      case 'manual_bak_map': {
        const flag = (params as Record<string, number>)['map_flag']!;
        if (!this.maps.some((m) => m.mapFlag === flag)) return respond({ error: { code: -10007, message: 'no such map' } });
        this.backups.set(flag, Math.floor(Date.now() / 1000) + this.backups.size);
        return respond(ok);
      }
      case 'recover_multi_map': {
        const flag = (params as Record<string, number>)['map_flag']!;
        if (!this.backups.has(flag)) return respond({ error: { code: -10007, message: 'no backup' } });
        this.savedAt.set(flag, Math.floor(Date.now() / 1000));
        return later(ok);
      }
      case 'name_multi_map': {
        const e = p0 as Record<string, unknown>;
        const m = this.maps.find((x) => x.mapFlag === e['multi_map']);
        if (m) m.name = String(e['name']);
        return respond(ok);
      }
      case 'del_map': this.maps = this.maps.filter((m) => m.mapFlag !== p0); s['map_status'] = this.maps.length ? 3 : 252; return respond(ok);
      case 'load_multi_map': {
        const flag = (data as number[])[0]!;
        s['map_status'] = (flag << 2) | 3;
        return later(ok);
      }
      case 'manual_segment_map': {
        const flag = [0, 1, 2, 3].find((f) => !this.maps.some((m) => m.mapFlag === f)) ?? 3;
        this.maps.push({ mapFlag: flag, name: '' });
        s['map_status'] = (flag << 2) | 3;
        return respond({ result: [1] }, 2_000);
      }
      case 'set_lab_status': {
        const e = (data as Array<Record<string, number>>)[0]!;
        s['lab_status'] = e['lab_status']!;
        if (e['reserve_map'] !== undefined) this.maps = this.maps.filter((m) => m.mapFlag === e['reserve_map']);
        return later(ok);
      }
      case 'get_clean_sequence': return respond({ result: this.sequence });
      case 'set_clean_sequence': this.sequence = data as number[]; return later(ok);
      case 'get_customize_clean_mode': return respond({ result: this.roomModes });
      case 'set_customize_clean_mode': this.roomModes = data as Array<Record<string, number>>; return later(ok);
      case 'save_map': {
        const entries = data as number[][];
        this.walls = entries.filter((e) => e[0] === 1).map((e) => ({ x0: e[1]!, y0: e[2]!, x1: e[3]!, y1: e[4]! }));
        this.noGo = entries.filter((e) => e[0] === 0).map((e) => zone(e.slice(1), 'NO_GO'));
        return later(ok);
      }
      case 'set_carpet_area': {
        const p = params as { flags?: number[]; zone_data: number[][] };
        // The robot fills in low bits of the flags itself.
        this.carpets = p.zone_data.map((q, i) => ({ ...zone(q, 'CARPET'), flags: (((p.flags?.[i] ?? 0x02338000) & 0xffff0000) | 0xe700) >>> 0 }));
        return respond(ok, 300);
      }
      case 'app_set_smart_door_sill': {
        const p = params as { zones: number[][] };
        this.thresholds = p.zones.map((q) => zone(q.slice(1), 'THRESHOLD'));
        return respond(ok, 300);
      }
      case 'set_segment_ground_material': {
        const [[seg, mat, dir]] = (params as { data: number[][] }).data as [[number, number, number]];
        this.materials.set(seg, mat);
        if (dir === -1) this.directions.delete(seg); else this.directions.set(seg, dir);
        return respond(ok, 300);
      }
      case 'split_segment': {
        const [seg, x1, y1, x2, y2] = data as number[];
        return later(this.split(seg!, x1!, y1!, x2!, y2!) ? ok : { error: { code: -10006, message: 'Split map failed' } });
      }
      case 'merge_segment': {
        const [a, b] = data as number[];
        this.recolor(b!, a!);
        return later(ok);
      }
      case 'name_segment': {
        const rows = data as Array<{ iotRoomId: string; robotRoomId: number; robotTagId: number }>;
        this.roomTable = rows.map((r) => [r.robotRoomId, r.iotRoomId, r.robotTagId]);
        return later({ result: rows.map((r) => ({ oldId: r.robotRoomId, newId: r.robotRoomId })) });
      }
      case 'check_homesec_password':
      case 'set_homesec_password':
        return respond({ error: { code: -1007, message: 'password is disable' } });
      default:
        return respond({ error: { code: -10000, message: `unknown method ${method}` } });
    }
  }

  private recolor(from: number, to: number): void {
    const px = this.pixels;
    if (!px) return;
    for (let i = 0; i < px.length; i++) {
      const v = px[i]!;
      if (v !== 0 && (v & 7) !== 1 && ((v >>> 3) & 0x1f) === from) px[i] = (to << 3) | (v & 7);
    }
  }

  /** Give the part of `seg` on one side of the line a new segment id; false when the line misses the room. */
  private split(seg: number, x1: number, y1: number, x2: number, y2: number): boolean {
    const px = this.pixels;
    if (!px) return false;
    const used = new Set<number>();
    for (const v of px) if (v !== 0 && (v & 7) !== 1) used.add((v >>> 3) & 0x1f);
    const fresh = [...Array(31).keys()].map((i) => i + 1).find((id) => !used.has(id));
    if (fresh === undefined) return false;
    const ax = x1 / 50 - this.image.left, ay = y1 / 50 - this.image.top;
    const bx = x2 / 50 - this.image.left, by = y2 / 50 - this.image.top;
    const changed: number[] = [];
    let kept = 0;
    for (let row = 0; row < this.image.height; row++) {
      for (let col = 0; col < this.image.width; col++) {
        const i = row * this.image.width + col;
        const v = px[i]!;
        if (v === 0 || (v & 7) === 1 || ((v >>> 3) & 0x1f) !== seg) continue;
        const cross = (bx - ax) * (row - ay) - (by - ay) * (col - ax);
        if (cross > 0) changed.push(i); else kept++;
      }
    }
    if (changed.length < 20 || kept < 20) return false;
    for (const i of changed) px[i] = (fresh << 3) | (px[i]! & 7);
    return true;
  }
}

function zone(c: number[], kind: MapZone['kind']): MapZone {
  return { x0: c[0]!, y0: c[1]!, x1: c[2]!, y1: c[3]!, x2: c[4]!, y2: c[5]!, x3: c[6]!, y3: c[7]!, kind };
}

/** One 23-byte furniture record: corners (u16 x, y), two unknown bytes, type, subtype, display flag, id, one more byte. */
function furnitureBytes(id: number, type: number, subtype: number, corners: Array<[number, number]>, display = 1): number[] {
  const b = new Array<number>(23).fill(0);
  corners.forEach(([x, y], i) => { b[i * 4] = x & 0xff; b[i * 4 + 1] = x >> 8; b[i * 4 + 2] = y & 0xff; b[i * 4 + 3] = y >> 8; });
  b[16] = 7; b[18] = type; b[19] = subtype; b[20] = display; b[21] = id; b[22] = 1;
  return b;
}
