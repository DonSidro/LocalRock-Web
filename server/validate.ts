import type { FurniturePlacement } from '../shared/furniture.js';
import { MAX_MAP_COORD_MM, type MapZone, type VirtualWall, type ZoneKind } from '../shared/map.js';
import type { RoomCleanMode } from '../shared/codes.js';
import { UserError } from './vacuum/errors.js';

/* Strict checks on everything the browser sends before it reaches a robot. */

export type Args = Record<string, unknown>;

export function obj(v: unknown, what = 'request'): Args {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new UserError(`Invalid ${what}`);
  return v as Args;
}

export function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new UserError(`Invalid ${name}: expected a whole number from ${min} to ${max}`);
  }
  return v;
}

export function num(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new UserError(`Invalid ${name}`);
  return v;
}

export function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new UserError(`Invalid ${name}`);
  return v;
}

export function str(v: unknown, name: string, maxLen: number, allowEmpty = false): string {
  if (typeof v !== 'string' || v.length > maxLen || (!allowEmpty && v.trim().length === 0)) throw new UserError(`Invalid ${name}`);
  return v;
}

export function oneOf<T extends number>(v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'number' || !allowed.includes(v as T)) throw new UserError(`Invalid ${name}`);
  return v as T;
}

export function intList(v: unknown, name: string, min: number, max: number, maxItems: number, minItems = 0): number[] {
  if (!Array.isArray(v) || v.length > maxItems || v.length < minItems) throw new UserError(`Invalid ${name}`);
  return v.map((x) => int(x, name, min, max));
}

const mm = (v: unknown, name: string) => int(v, name, 0, MAX_MAP_COORD_MM);

export function point(v: unknown, name: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new UserError(`Invalid ${name}`);
  return [mm(v[0], name), mm(v[1], name)];
}

export function zoneList(v: unknown, kind: ZoneKind, maxItems: number): MapZone[] {
  if (!Array.isArray(v) || v.length > maxItems) throw new UserError(`Invalid ${kind.toLowerCase()} list`);
  return v.map((raw) => {
    const z = obj(raw, 'zone');
    if (z['kind'] !== kind) throw new UserError('Zone of the wrong kind');
    const zone: MapZone = {
      x0: mm(z['x0'], 'zone'), y0: mm(z['y0'], 'zone'),
      x1: mm(z['x1'], 'zone'), y1: mm(z['y1'], 'zone'),
      x2: mm(z['x2'], 'zone'), y2: mm(z['y2'], 'zone'),
      x3: mm(z['x3'], 'zone'), y3: mm(z['y3'], 'zone'),
      kind,
    };
    if (z['flags'] !== undefined && z['flags'] !== null) zone.flags = int(z['flags'], 'carpet flags', 0, 0xffffffff);
    return zone;
  });
}

/** A furniture draft: up to 64 items, each a key (robot id 1-255, or a negative draft key), a type, a subtype and four corners. */
export function furnitureList(v: unknown): FurniturePlacement[] {
  if (!Array.isArray(v) || v.length > 64) throw new UserError('Invalid furniture list');
  return v.map((raw) => {
    const f = obj(raw, 'furniture');
    const corners = f['corners'];
    if (!Array.isArray(corners) || corners.length !== 4) throw new UserError('Invalid furniture corners');
    return {
      key: int(f['key'], 'furniture id', -1_000_000, 255),
      type: int(f['type'], 'furniture type', 0, 255),
      subtype: int(f['subtype'], 'furniture subtype', 0, 255),
      corners: corners.map((c) => { const p = obj(c, 'corner'); return { x: mm(p['x'], 'furniture'), y: mm(p['y'], 'furniture') }; }),
    };
  });
}

export function wallList(v: unknown, maxItems: number): VirtualWall[] {
  if (!Array.isArray(v) || v.length > maxItems) throw new UserError('Invalid wall list');
  return v.map((raw) => {
    const w = obj(raw, 'wall');
    return { x0: mm(w['x0'], 'wall'), y0: mm(w['y0'], 'wall'), x1: mm(w['x1'], 'wall'), y1: mm(w['y1'], 'wall') };
  });
}

export function roomModes(v: unknown): RoomCleanMode[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 64) throw new UserError('Invalid room settings');
  return v.map((raw) => {
    const m = obj(raw, 'room settings');
    return {
      segment: int(m['segment'], 'segment', 0, 255),
      fanPower: int(m['fanPower'], 'suction', 100, 120),
      waterBoxMode: int(m['waterBoxMode'], 'water flow', 200, 260),
      mopMode: int(m['mopMode'], 'route', 300, 310),
    };
  });
}
