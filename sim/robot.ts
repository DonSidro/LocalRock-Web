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
  private materials = new Map<number, number>();
  private directions = new Map<number, number>();
  private path: Array<{ x: number; y: number }> = [];
  private robotPos: { x: number; y: number; angle: number } | null = null;
  private dock: { x: number; y: number; angle: number } | null = null;
  private pathIndex = 0;
  private roomTable: Array<[number, string, number]> = [];
  private maps: Array<{ mapFlag: number; name: string }> = [{ mapFlag: 0, name: 'Home' }];
  private sequence: number[] = [];
  private roomModes: Array<Record<string, number>> = [];
  private timers: Array<{ id: string; on: boolean; cron: string }> = [{ id: '1700000000', on: true, cron: '0 9 * * 1,2,3,4,5' }];
  private settings = { volume: 80, lock: 0, led: 1, carpet: 1, wash: 1, washInterval: 1, dust: 0 };
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

  mapBytes(): Buffer {
    if (this.b01Map) return this.b01Map;
    return writeLegacyMap(this.baseMap!, {
      pixels: this.pixels!, noGo: this.noGo, noMop: this.noMop, walls: this.walls, carpets: this.carpets,
      thresholds: this.thresholds, materials: this.materials, directions: this.directions, robot: this.robotPos,
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
      case 'set_custom_mode': s['fan_power'] = Number(p0); return respond(ok);
      case 'set_water_box_custom_mode': s['water_box_mode'] = Number(p0); return respond(ok);
      case 'set_mop_mode': this.mopMode = Number(p0); return respond(ok);
      case 'get_mop_mode': return respond({ result: [this.mopMode] });
      case 'set_clean_motor_mode': {
        const m = (p0 ?? {}) as Record<string, number>;
        s['fan_power'] = m['fan_power']!;
        s['water_box_mode'] = m['water_box_mode']!;
        this.mopMode = m['mop_mode']!;
        return respond(ok);
      }
      case 'get_consumable': return respond({ result: [this.consumables] });
      case 'reset_consumable': (this.consumables as Record<string, number>)[String(p0)] = 0; return respond(ok);
      case 'get_clean_summary': return respond({ result: [86_400 + 3_600 * 3, 412_000_000, 57, [1760600000, 1760500000, 1760400000]] });
      case 'get_clean_record': {
        const begin = Number(p0);
        return respond({ result: [[begin, begin + 2_700, 2_640, 48_500_000, 0, begin === 1760400000 ? 0 : 1]] });
      }
      case 'get_room_mapping': return respond({ result: this.roomTable });
      case 'find_me':
      case 'app_rc_move':
      case 'start_edit_map':
      case 'end_edit_map':
      case 'set_switch_map_mode':
        if (method === 'set_switch_map_mode') s['switch_map_mode'] = Number((params as Record<string, unknown>)['mode']);
        return respond(ok);
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
        return respond({ result: [{ max_multi_map: 4, max_bak_map: 1, multi_map_count: this.maps.length, map_info: this.maps.map((m) => ({ ...m, add_time: 1760000000, length: m.name.length, bak_maps: [] })) }] });
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
