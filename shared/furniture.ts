import { MAX_MAP_COORD_MM, type ParsedMap } from './map.js';

/*
 * Map furniture (legacy block 25), ported from LocalRock's MapFurniture.kt, FurnitureCatalog.kt,
 * FurnitureSupport.kt, FurnitureEdits.kt and FurnitureEditGeometry.kt. Shared so the editor in the
 * browser and the server check edits with exactly the same rules.
 *
 * A record is 23 bytes: four corners as u16 x/y pairs in robot mm (bytes 0-15), two bytes not yet
 * understood (16-17), type (18), subtype (19), display flag (20), the furniture's persistent id (21)
 * and one more byte (22). Every byte is kept, so untouched and hidden records stay exactly as read.
 * The layout and display flag were checked on an S7 MaxV; other layouts are not guessed.
 */

export const FURNITURE_RECORD_SIZE = 23;
/** How far a saved corner may move in the robot's readback and still match what was sent. */
const READBACK_TOLERANCE_MM = 2;

/** The whole block as read, so unknown layouts are kept and can be refused for editing. */
export interface MapFurnitureBlock { headerBytes: number[]; bodyBytes: number[] }

export interface FurniturePoint { x: number; y: number }

export interface MapFurniture {
  rawBytes: number[];
  cornersMm: FurniturePoint[];
  type: number;
  subtype: number;
  displayFlag: number;
  id: number;
  /** Only flag 1 was verified as displayed; hidden and unfamiliar flags stay in the model. */
  isVisible: boolean;
}

const u16 = (b: number[], off: number) => b[off]! | (b[off + 1]! << 8);

/** Rejects collapsed or crossed quads for drawing, without dropping their raw records. */
export function hasUsableFootprint(corners: FurniturePoint[]): boolean {
  const turns = corners.map((a, i) => {
    const b = corners[(i + 1) % 4]!;
    const c = corners[(i + 2) % 4]!;
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  });
  return turns.every((t) => t > 0) || turns.every((t) => t < 0);
}

export function furnitureRecord(rawBytes: number[]): MapFurniture {
  if (rawBytes.length !== FURNITURE_RECORD_SIZE) throw new Error('A furniture record is 23 bytes');
  const cornersMm = [0, 1, 2, 3].map((i) => ({ x: u16(rawBytes, i * 4), y: u16(rawBytes, i * 4 + 2) }));
  const displayFlag = rawBytes[20]!;
  return {
    rawBytes, cornersMm, type: rawBytes[18]!, subtype: rawBytes[19]!, displayFlag, id: rawBytes[21]!,
    isVisible: displayFlag === 1 && hasUsableFootprint(cornersMm),
  };
}

/** A 12-byte header whose u32 count at byte 8 matches 23-byte records; anything else may be another format. */
export function hasKnownLayout(block: MapFurnitureBlock): boolean {
  if (block.headerBytes.length !== 12) return false;
  const h = block.headerBytes;
  const count = h[8]! + h[9]! * 0x100 + h[10]! * 0x10000 + h[11]! * 0x1000000;
  return count * FURNITURE_RECORD_SIZE === block.bodyBytes.length;
}

export function blockRecords(block: MapFurnitureBlock): MapFurniture[] {
  // A different header or stride may be a different format: do not misalign its records.
  if (!hasKnownLayout(block)) return [];
  const out: MapFurniture[] = [];
  for (let i = 0; i + FURNITURE_RECORD_SIZE <= block.bodyBytes.length; i += FURNITURE_RECORD_SIZE) {
    out.push(furnitureRecord(block.bodyBytes.slice(i, i + FURNITURE_RECORD_SIZE)));
  }
  return out;
}

const furnitureCache = new WeakMap<ParsedMap, MapFurniture[]>();

/** Every furniture record on the map, visible or not. */
export function mapFurniture(map: ParsedMap): MapFurniture[] {
  const hit = furnitureCache.get(map);
  if (hit) return hit;
  const out = (map.furnitureBlocks ?? []).flatMap(blockRecords);
  furnitureCache.set(map, out);
  return out;
}

// ---- Catalog ----------------------------------------------------------------------------------

/**
 * Type/subtype pairs observed for all 21 S7 MaxV picker choices. Sizes are LocalRock starting sizes
 * based on saved footprints, not claims about OEM defaults or firmware size limits.
 */
export interface FurnitureKind { type: number; subtype: number; label: string; widthMm: number; depthMm: number; symbol: FurnitureSymbol; image: string }

export type FurnitureSymbol =
  | 'SOFA' | 'DOUBLE_SOFA' | 'ARMCHAIR' | 'CHAISE_LEFT' | 'CHAISE_RIGHT' | 'DINING_SET' | 'BED' | 'WIDE_BED'
  | 'TV_STAND' | 'SQUARE_TABLE' | 'COFFEE_TABLE' | 'SHOE_RACK' | 'WARDROBE' | 'NIGHTSTAND'
  | 'LITTER_BOX' | 'COVERED_LITTER_BOX' | 'PET_CAGE' | 'PET_BED' | 'PET_BOWLS' | 'MIRROR' | 'CAT_TOWER' | 'UNKNOWN';

const kind = (type: number, subtype: number, label: string, widthMm: number, depthMm: number, symbol: FurnitureSymbol, image: string): FurnitureKind =>
  ({ type, subtype, label, widthMm, depthMm, symbol, image: `furniture/furniture_${image}.png` });

export const FURNITURE_CATALOG: readonly FurnitureKind[] = [
  kind(45, 2, 'Wide bed', 2400, 2400, 'WIDE_BED', 'wide_bed'),
  kind(45, 1, 'Narrow bed', 1200, 2400, 'BED', 'narrow_bed'),
  kind(43, 0, 'TV stand', 1000, 400, 'TV_STAND', 'tv_stand'),
  kind(46, 3, 'Multi-seat sofa', 2000, 836, 'SOFA', 'multi_seat_sofa'),
  kind(46, 2, 'Double sofa', 2000, 1000, 'DOUBLE_SOFA', 'double_sofa'),
  kind(46, 1, 'Single sofa', 1000, 1000, 'ARMCHAIR', 'single_sofa'),
  kind(46, 4, 'Left chaise sofa', 2000, 800, 'CHAISE_LEFT', 'left_chaise_sofa'),
  kind(46, 5, 'Right chaise sofa', 2000, 806, 'CHAISE_RIGHT', 'right_chaise_sofa'),
  kind(47, 0, 'Dining set', 1200, 800, 'DINING_SET', 'dining_set'),
  kind(48, 2, 'Square table', 1500, 1500, 'SQUARE_TABLE', 'square_table'),
  kind(48, 1, 'Coffee table', 1200, 900, 'COFFEE_TABLE', 'coffee_table'),
  kind(49, 0, 'Shoe rack', 1000, 400, 'SHOE_RACK', 'shoe_rack'),
  kind(51, 0, 'Wardrobe', 2500, 700, 'WARDROBE', 'wardrobe'),
  kind(50, 0, 'Nightstand', 400, 400, 'NIGHTSTAND', 'nightstand'),
  kind(52, 0, 'Litter box', 350, 500, 'LITTER_BOX', 'litter_box'),
  kind(53, 0, 'Enclosed litter box', 500, 700, 'COVERED_LITTER_BOX', 'enclosed_litter_box'),
  kind(54, 0, 'Pet cage', 400, 400, 'PET_CAGE', 'pet_cage'),
  kind(55, 0, 'Pet bed', 411, 400, 'PET_BED', 'pet_bed'),
  kind(56, 0, 'Pet bowls', 300, 150, 'PET_BOWLS', 'pet_bowls'),
  kind(57, 0, 'Floor mirror', 400, 300, 'MIRROR', 'floor_mirror'),
  kind(58, 0, 'Cat tower', 400, 400, 'CAT_TOWER', 'cat_tower'),
];

export function furnitureKind(type: number, subtype: number): FurnitureKind | null {
  return FURNITURE_CATALOG.find((k) => k.type === type && k.subtype === subtype) ?? null;
}

export const furnitureSymbol = (type: number, subtype: number): FurnitureSymbol => furnitureKind(type, subtype)?.symbol ?? 'UNKNOWN';

// ---- Support ----------------------------------------------------------------------------------

/** A robot-reported capability, separate from whether LocalRock can edit its map format. */
export type FurnitureSupport = 'UNKNOWN' | 'UNSUPPORTED' | 'SUPPORTED';

export function furnitureBlockedReason(support: FurnitureSupport): string | null {
  switch (support) {
    case 'UNKNOWN': return 'Furniture support could not be verified. Retry while the robot is connected.';
    case 'UNSUPPORTED': return 'This robot does not report furniture support.';
    default: return null;
  }
}

/** new_feature_info bit for furniture (python-roborock is_support_furniture). */
const FURNITURE_BIT = 36n;

/**
 * Bit 36 of the decimal `new_feature_info` number in app_get_init_status, not the hexadecimal
 * new_feature_info_str. A missing or malformed answer can never authorise a map write, and there is
 * no model-name fallback.
 */
export function furnitureSupportFromFlags(newFeatureInfo: string | null): FurnitureSupport {
  if (newFeatureInfo === null || !/^\d+$/.test(newFeatureInfo)) return 'UNKNOWN';
  return ((BigInt(newFeatureInfo) >> FURNITURE_BIT) & 1n) === 1n ? 'SUPPORTED' : 'UNSUPPORTED';
}

// ---- Placements -------------------------------------------------------------------------------

/** Positive keys are stable robot ids; negative keys exist only in an unsaved draft. */
export interface FurniturePlacement { key: number; type: number; subtype: number; corners: FurniturePoint[] }

const dist = (a: FurniturePoint, b: FurniturePoint) => Math.hypot(b.x - a.x, b.y - a.y);
export const placementWidth = (p: FurniturePlacement) => dist(p.corners[0]!, p.corners[1]!);
export const placementDepth = (p: FurniturePlacement) => dist(p.corners[0]!, p.corners[3]!);
export const placementCenter = (p: FurniturePlacement): FurniturePoint => ({
  x: p.corners.reduce((s, c) => s + c.x, 0) / 4,
  y: p.corners.reduce((s, c) => s + c.y, 0) / 4,
});

export function movedPlacement(p: FurniturePlacement, dx: number, dy: number): FurniturePlacement {
  return { ...p, corners: p.corners.map((c) => ({ x: c.x + dx, y: c.y + dy })) };
}

export function rotatedPlacement(p: FurniturePlacement, degrees: number): FurniturePlacement {
  const { x: cx, y: cy } = placementCenter(p);
  const r = (degrees * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return {
    ...p,
    corners: p.corners.map((c) => {
      const x = c.x - cx, y = c.y - cy;
      return { x: Math.round(cx + x * cos - y * sin), y: Math.round(cy + x * sin + y * cos) };
    }),
  };
}

/** Grows the item from its first corner by a total pointer delta, so a padded handle never jumps. */
export function resizedFromHandle(p: FurniturePlacement, dx: number, dy: number): FurniturePlacement {
  if (dx === 0 && dy === 0) return p;
  const a = p.corners[0]!;
  const w = placementWidth(p), d = placementDepth(p);
  const ux = (p.corners[1]!.x - a.x) / w, uy = (p.corners[1]!.y - a.y) / w;
  const vx = (p.corners[3]!.x - a.x) / d, vy = (p.corners[3]!.y - a.y) / d;
  // One mm of rounding allowance keeps rotated edges above the 100 mm validation minimum.
  const width = Math.max(101, w + dx * ux + dy * uy);
  const height = Math.max(101, d + dx * vx + dy * vy);
  const pt = (x: number, y: number) => ({ x: Math.round(a.x + x * ux * width + y * vx * height), y: Math.round(a.y + x * uy * width + y * vy * height) });
  return { ...p, corners: [a, pt(1, 0), pt(1, 1), pt(0, 1)] };
}

/** Rotates by the angle a pointer swept around the item's centre, in robot space. */
export function rotatedFromHandle(p: FurniturePlacement, start: FurniturePoint, end: FurniturePoint): FurniturePlacement {
  const { x: cx, y: cy } = placementCenter(p);
  const ax = start.x - cx, ay = start.y - cy, bx = end.x - cx, by = end.y - cy;
  if (ax * ax + ay * ay < 1 || bx * bx + by * by < 1) return p;
  return rotatedPlacement(p, (Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * 180) / Math.PI);
}

export function placementContains(p: FurniturePlacement, x: number, y: number): boolean {
  const turns = p.corners.map((a, i) => {
    const b = p.corners[(i + 1) % 4]!;
    return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
  });
  return turns.every((t) => t >= 0) || turns.every((t) => t <= 0);
}

/** A new item centred on (x, y); robot Y grows upwards, so the top corners have the larger Y. */
export function newFurniture(key: number, k: FurnitureKind, x: number, y: number): FurniturePlacement {
  if (key >= 0) throw new Error('A new furniture item needs a negative key');
  const left = x - Math.trunc(k.widthMm / 2), top = y + Math.trunc(k.depthMm / 2);
  return {
    key, type: k.type, subtype: k.subtype,
    corners: [{ x: left, y: top }, { x: left + k.widthMm, y: top }, { x: left + k.widthMm, y: top - k.depthMm }, { x: left, y: top - k.depthMm }],
  };
}

/** Generic editor geometry limits, not OEM size limits: a known kind, on the map, a near-rectangle of at least 100 mm. */
export function validFurniturePlacement(p: FurniturePlacement): boolean {
  if (p.key === 0 || !furnitureKind(p.type, p.subtype) || p.corners.length !== 4) return false;
  if (p.corners.some((c) => c.x < 0 || c.x > MAX_MAP_COORD_MM || c.y < 0 || c.y > MAX_MAP_COORD_MM)) return false;
  const w = placementWidth(p), d = placementDepth(p);
  if (w < 100 || d < 100) return false;
  const [a, b, c, e] = p.corners as [FurniturePoint, FurniturePoint, FurniturePoint, FurniturePoint];
  if (Math.abs(a.x + c.x - b.x - e.x) > 3 || Math.abs(a.y + c.y - b.y - e.y) > 3) return false;
  const dot = (b.x - a.x) * (e.x - a.x) + (b.y - a.y) * (e.y - a.y);
  return Math.abs(dot) <= w * d * 0.025;
}

export function editablePlacement(f: MapFurniture): FurniturePlacement | null {
  if (!f.isVisible || f.id < 1 || f.id > 255) return null;
  const p: FurniturePlacement = { key: f.id, type: f.type, subtype: f.subtype, corners: f.cornersMm };
  return validFurniturePlacement(p) ? p : null;
}

export const editablePlacements = (map: ParsedMap) =>
  mapFurniture(map).map(editablePlacement).filter((p): p is FurniturePlacement => p !== null);

/** Why this map's furniture can't be edited, or null. save_furnitures always names map 0. */
export function furnitureMapBlocker(map: ParsedMap, mapIndex: number | null): string | null {
  if (mapIndex !== 0) return 'Furniture editing is available only on the first saved map.';
  if (map.format !== 'LEGACY') return 'Furniture editing is not available for this map format yet.';
  if ((map.furnitureBlocks ?? []).some((b) => !hasKnownLayout(b))) return 'This map uses a furniture layout LocalRock cannot edit yet.';
  const items = mapFurniture(map);
  if (items.some((f) => f.id < 1 || f.id > 255) || new Set(items.map((f) => f.id)).size !== items.length) {
    return "The robot's furniture identifiers are unclear. Refresh the map before editing.";
  }
  return null;
}

const sameBytes = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameBlocks = (a: MapFurnitureBlock[], b: MapFurnitureBlock[]) =>
  a.length === b.length && a.every((x, i) => sameBytes(x.headerBytes, b[i]!.headerBytes) && sameBytes(x.bodyBytes, b[i]!.bodyBytes));

/** Also catches a floor or room change while a draft is open; the moving robot and its path don't count. */
export function sameFurnitureBase(a: ParsedMap, b: ParsedMap): boolean {
  if (a.format !== b.format || a.width !== b.width || a.height !== b.height) return false;
  if (a.pixelOffsetLeft !== b.pixelOffsetLeft || a.pixelOffsetTop !== b.pixelOffsetTop) return false;
  if (a.grid.length !== b.grid.length || a.grid.some((v, i) => v !== b.grid[i])) return false;
  const ids = (m: ParsedMap) => [...new Set(m.rooms.map((r) => r.id))].sort((x, y) => x - y).join(',');
  return ids(a) === ids(b) && sameBlocks(a.furnitureBlocks ?? [], b.furnitureBlocks ?? []);
}

/** A map read fresh for the furniture editor, with the support answer it was read under. */
export interface FurnitureSnapshot { map: ParsedMap; support: FurnitureSupport }

export interface FurnitureEditPlan {
  baseline: ParsedMap;
  changed: FurniturePlacement[];
  deleted: number[];
}

export class FurnitureEditError extends Error {}

/** The changes a draft makes to the baseline map, checked; throws with a message for the user. */
export function furnitureEditPlan(baseline: ParsedMap, support: FurnitureSupport, draft: FurniturePlacement[]): FurnitureEditPlan {
  const blocked = furnitureBlockedReason(support) ?? furnitureMapBlocker(baseline, 0);
  if (blocked) throw new FurnitureEditError(blocked);
  const original = new Map(editablePlacements(baseline).map((p) => [p.key, p]));
  if (new Set(draft.map((p) => p.key)).size !== draft.length || draft.some((p) => !validFurniturePlacement(p))) {
    throw new FurnitureEditError('One furniture item has an invalid size or position.');
  }
  for (const item of draft.filter((p) => p.key > 0)) {
    const old = original.get(item.key);
    if (!old || old.type !== item.type || old.subtype !== item.subtype) {
      throw new FurnitureEditError('The furniture selection has changed. Reload the editor.');
    }
  }
  const same = (a: FurniturePlacement, b: FurniturePlacement) => a.corners.every((c, i) => c.x === b.corners[i]!.x && c.y === b.corners[i]!.y);
  const keys = new Set(draft.map((p) => p.key));
  return {
    baseline,
    changed: draft.filter((p) => { const o = original.get(p.key); return !o || !same(o, p); }),
    deleted: [...original.keys()].filter((k) => !keys.has(k)).sort((a, b) => a - b),
  };
}

/** save_furnitures params: [1, id or -1, 8 corner values, type, subtype, 1] per add or update, [0, id] per delete. */
export function furnitureEditParams(plan: FurnitureEditPlan): { data: number[][]; map_flag: number } {
  return {
    data: [
      ...plan.changed.map((p) => [1, p.key < 0 ? -1 : p.key, ...p.corners.flatMap((c) => [c.x, c.y]), p.type, p.subtype, 1]),
      ...plan.deleted.map((id) => [0, id]),
    ],
    map_flag: 0,
  };
}

function matchesPlacement(expected: FurniturePlacement, actual: MapFurniture): boolean {
  if (!actual.isVisible || expected.type !== actual.type || expected.subtype !== actual.subtype) return false;
  // The map may reorder corners cyclically; each corner must still match a distinct corner.
  const pts = actual.cornersMm;
  return [pts, [...pts].reverse()].some((order) => [0, 1, 2, 3].some((shift) => expected.corners.every((a, i) => {
    const b = order[(i + shift) % 4]!;
    return Math.abs(a.x - b.x) <= READBACK_TOLERANCE_MM && Math.abs(a.y - b.y) <= READBACK_TOLERANCE_MM;
  })));
}

/** Whether a fresh map shows exactly the plan: every untouched and hidden record unchanged, every edit applied. */
export function furnitureEditsConfirmed(plan: FurnitureEditPlan, map: ParsedMap): boolean {
  if (furnitureMapBlocker(map, 0) !== null) return false;
  const actual = new Map(mapFurniture(map).map((f) => [f.id, f]));
  const updates = new Map(plan.changed.filter((p) => p.key > 0).map((p) => [p.key, p]));
  const deleted = new Set(plan.deleted);
  for (const original of mapFurniture(plan.baseline)) {
    if (deleted.has(original.id)) continue;
    const saved = actual.get(original.id);
    if (!saved) return false;
    actual.delete(original.id);
    const updated = updates.get(original.id);
    if (!updated) {
      if (!sameBytes(saved.rawBytes, original.rawBytes)) return false;
    } else {
      const unmoved = saved.cornersMm.every((c, i) => c.x === original.cornersMm[i]!.x && c.y === original.cornersMm[i]!.y);
      const wanted = updated.corners.some((c, i) => c.x !== original.cornersMm[i]!.x || c.y !== original.cornersMm[i]!.y);
      if ((unmoved && wanted) || !matchesPlacement(updated, saved)) return false;
      if (saved.rawBytes[16] !== original.rawBytes[16] || saved.rawBytes[17] !== original.rawBytes[17] || saved.rawBytes[22] !== original.rawBytes[22]) return false;
    }
  }
  const additions = plan.changed.filter((p) => p.key < 0);
  if (actual.size !== additions.length) return false;
  // Bipartite matching handles overlapping additions without an exponential search.
  const candidates = [...actual.values()];
  const assigned = new Array<number>(candidates.length).fill(-1);
  const assign = (item: number, seen: boolean[]): boolean => {
    for (let i = 0; i < candidates.length; i++) {
      if (seen[i] || !matchesPlacement(additions[item]!, candidates[i]!)) continue;
      seen[i] = true;
      if (assigned[i]! < 0 || assign(assigned[i]!, seen)) { assigned[i] = item; return true; }
    }
    return false;
  };
  return additions.every((_, i) => assign(i, new Array<boolean>(candidates.length).fill(false)));
}

// ---- Drawing ----------------------------------------------------------------------------------

/** One step of a furniture symbol in the item's own unit square (0..1 across, 0..1 down from corner 0). */
export type SymbolOp =
  | { op: 'shape'; pts: Array<[number, number]>; outline: boolean; erase: boolean }
  | { op: 'line'; pts: Array<[number, number]> };

const cache = new Map<FurnitureSymbol, SymbolOp[]>();

/** The plan-view artwork of a symbol: filled shapes with cut-out outlines and holes, as the app draws them. */
export function furnitureSymbolOps(symbol: FurnitureSymbol): SymbolOp[] {
  const hit = cache.get(symbol);
  if (hit) return hit;
  const ops: SymbolOp[] = [];
  const shape = (pts: Array<[number, number]>, outline = true, erase = false) => ops.push({ op: 'shape', pts, outline, erase });
  const line = (...pts: Array<[number, number]>) => ops.push({ op: 'line', pts });
  const curve = (...p: Array<[number, number]>): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let s = 0; s < Math.floor((p.length - 1) / 3); s++) {
      const q = p.slice(s * 3, s * 3 + 4);
      for (let step = 0; step <= 16; step++) {
        const t = step / 16, u = 1 - t;
        const v = (k: 0 | 1) => u * u * u * q[0]![k] + 3 * u * u * t * q[1]![k] + 3 * u * t * t * q[2]![k] + t * t * t * q[3]![k];
        out.push([v(0), v(1)]);
      }
    }
    return out;
  };
  const rounded = (l: number, t: number, r: number, b: number, radius = 0.035): Array<[number, number]> => {
    const rx = Math.min(radius, (r - l) / 2), ry = Math.min(radius, (b - t) / 2);
    const corners: Array<[number, number, number]> = [[r - rx, t + ry, -90], [r - rx, b - ry, 0], [l + rx, b - ry, 90], [l + rx, t + ry, 180]];
    return corners.flatMap(([cx, cy, start]) => Array.from({ length: 9 }, (_, i) => {
      const a = ((start + (i * 90) / 8) * Math.PI) / 180;
      return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as [number, number];
    }));
  };
  const box = (l: number, t: number, r: number, b: number, radius = 0.035, erase = false) => shape(rounded(l, t, r, b, radius), true, erase);
  const oval = (l: number, t: number, r: number, b: number) => shape(Array.from({ length: 64 }, (_, i) => {
    const a = (i * 2 * Math.PI) / 64;
    return [(l + r) / 2 + (Math.cos(a) * (r - l)) / 2, (t + b) / 2 + (Math.sin(a) * (b - t)) / 2] as [number, number];
  }));
  switch (symbol) {
    case 'BED': case 'WIDE_BED':
      box(0.04, 0.02, 0.96, 0.98, 0.055); box(0.04, 0.02, 0.96, 0.14, 0.055); box(0.08, 0.14, 0.92, 0.96, 0.04);
      if (symbol === 'WIDE_BED') { box(0.12, 0.17, 0.48, 0.37); box(0.52, 0.17, 0.88, 0.37); } else box(0.15, 0.17, 0.85, 0.37);
      box(0.08, 0.4, 0.92, 0.55); line([0.08, 0.55], [0.92, 0.55]);
      break;
    case 'SOFA': case 'DOUBLE_SOFA': case 'ARMCHAIR': case 'CHAISE_LEFT': case 'CHAISE_RIGHT': {
      const chaise = symbol === 'CHAISE_LEFT' || symbol === 'CHAISE_RIGHT';
      const bottom = chaise ? 0.62 : 0.95;
      const seats = symbol === 'ARMCHAIR' ? 1 : symbol === 'DOUBLE_SOFA' ? 2 : 3;
      for (let i = 0; i < seats; i++) {
        const l = 0.12 + (i * 0.76) / seats, r = 0.12 + ((i + 1) * 0.76) / seats;
        const extended = (symbol === 'CHAISE_LEFT' && i === 0) || (symbol === 'CHAISE_RIGHT' && i === seats - 1);
        box(l, 0.08, r, extended ? 0.96 : bottom); box(l, 0.08, r, 0.28);
      }
      box(0.02, 0.12, 0.12, bottom); box(0.88, 0.12, 0.98, bottom);
      break;
    }
    case 'TV_STAND':
      box(0.02, 0.1, 0.98, 0.9); box(0.13, 0.22, 0.87, 0.43, 0.015, true); box(0.4, 0.47, 0.6, 0.66, 0.005, true);
      break;
    case 'DINING_SET':
      for (const x of [0.2, 0.58]) {
        box(x, 0.04, x + 0.22, 0.32, 0.055); box(x, 0.68, x + 0.22, 0.96, 0.055);
        line(...curve([x, 0.12], [x + 0.07, 0.07], [x + 0.15, 0.07], [x + 0.22, 0.12]));
        line(...curve([x, 0.88], [x + 0.07, 0.93], [x + 0.15, 0.93], [x + 0.22, 0.88]));
      }
      box(0.08, 0.25, 0.92, 0.75, 0.02);
      break;
    case 'SQUARE_TABLE': case 'COFFEE_TABLE': case 'WARDROBE': case 'NIGHTSTAND':
      box(0.02, 0.02, 0.98, 0.98, 0.025); box(0.07, 0.08, 0.93, 0.92, 0.005);
      break;
    case 'SHOE_RACK':
      box(0.02, 0.05, 0.98, 0.95, 0.01);
      for (let i = 1; i <= 5; i++) { const y = 0.05 + i * 0.15; line([0.04, y], [0.96, y]); }
      box(0.02, 0.02, 0.07, 0.98, 0.01); box(0.93, 0.02, 0.98, 0.98, 0.01);
      for (const x of [0.17, 0.3, 0.63, 0.76]) oval(x, 0.19, x + 0.12, 0.83);
      break;
    case 'LITTER_BOX':
      box(0.03, 0.04, 0.97, 0.96, 0.09); box(0.08, 0.12, 0.92, 0.88, 0.07);
      break;
    case 'COVERED_LITTER_BOX':
      box(0.02, 0.4, 0.07, 0.6, 0.02); box(0.93, 0.4, 0.98, 0.6, 0.02);
      box(0.06, 0.04, 0.94, 0.96, 0.17); box(0.1, 0.1, 0.9, 0.9, 0.14);
      line([0.5, 0.1], [0.5, 0.9]); box(0.45, 0.41, 0.55, 0.59, 0.02);
      break;
    case 'PET_CAGE':
      box(0.03, 0.03, 0.97, 0.97, 0.03); box(0.09, 0.09, 0.91, 0.91, 0.005);
      for (let i = 1; i <= 4; i++) { const x = 0.09 + i * 0.164; line([x, 0.09], [x, 0.91]); }
      for (let i = 1; i <= 2; i++) { const y = 0.09 + i * 0.273; line([0.09, y], [0.91, y]); }
      for (const x of [0.02, 0.88]) for (const y of [0.02, 0.88]) box(x, y, x + 0.1, y + 0.1, 0.02);
      break;
    case 'PET_BED':
      box(0.02, 0.04, 0.98, 0.96, 0.09); box(0.05, 0.08, 0.95, 0.92, 0.065); box(0.15, 0.24, 0.85, 0.77, 0.005);
      line([0.05, 0.08], [0.15, 0.24]); line([0.95, 0.08], [0.85, 0.24]);
      line([0.05, 0.92], [0.15, 0.77]); line([0.95, 0.92], [0.85, 0.77]);
      box(0.15, 0.77, 0.32, 0.96, 0.055); box(0.68, 0.77, 0.85, 0.96, 0.055);
      box(0.32, 0.79, 0.68, 0.84, 0, true); box(0.32, 0.89, 0.68, 1, 0, true);
      break;
    case 'PET_BOWLS':
      // One curved, waisted holder with two recessed bowls.
      shape(curve(
        [0.02, 0.5], [0.02, 0.12], [0.18, -0.04], [0.34, 0.09],
        [0.46, 0.23], [0.54, 0.23], [0.66, 0.09],
        [0.82, -0.04], [0.98, 0.12], [0.98, 0.5],
        [0.98, 0.88], [0.82, 1.04], [0.66, 0.91],
        [0.54, 0.77], [0.46, 0.77], [0.34, 0.91],
        [0.18, 1.04], [0.02, 0.88], [0.02, 0.5],
      ));
      oval(0.07, 0.15, 0.45, 0.85); oval(0.55, 0.15, 0.93, 0.85);
      oval(0.1, 0.2, 0.42, 0.8); oval(0.58, 0.2, 0.9, 0.8);
      break;
    case 'MIRROR': {
      // An inverted-V support with rounded ends, seen from a shallow angle above.
      const support = (x0: number, x1: number) => {
        const aspect = 2.2;
        const angle = Math.atan2(0.07 - 0.96, (x1 - x0) * aspect);
        const ends: Array<[number, number, number]> = [[x0, 0.96, angle + Math.PI / 2], [x1, 0.07, angle - Math.PI / 2]];
        shape(ends.flatMap(([x, y, start]) => Array.from({ length: 17 }, (_, i) => {
          const a = start + (i * Math.PI) / 16;
          return [x + (Math.cos(a) * 0.05) / aspect, y + Math.sin(a) * 0.05] as [number, number];
        })));
      };
      support(0.15, 0.467); support(0.85, 0.533);
      shape([[0.02, 0.68], [0.98, 0.68], [0.94, 0.91], [0.06, 0.91]]);
      line([0.07, 0.91], [0.04, 0.72], [0.96, 0.72], [0.93, 0.91]);
      break;
    }
    case 'CAT_TOWER':
      shape(curve(
        [0.25, 0.12], [0.4, 0.1], [0.8, 0.1], [0.9, 0.1],
        [0.96, 0.1], [0.99, 0.18], [0.94, 0.26],
        [0.8, 0.5], [0.65, 0.78], [0.56, 0.94],
        [0.52, 1], [0.47, 1], [0.42, 0.93],
        [0.28, 0.7], [0.13, 0.43], [0.08, 0.3],
        [0.03, 0.17], [0.13, 0.12], [0.25, 0.12],
      ));
      oval(0.39, 0.42, 0.87, 0.91); oval(0.03, 0.02, 0.58, 0.59); oval(0.79, 0.13, 0.91, 0.26);
      break;
    default:
      box(0.02, 0.02, 0.98, 0.98);
  }
  cache.set(symbol, ops);
  return ops;
}

/** Bilinear point inside a quad: (0,0) is corner 0, (1,0) corner 1, (1,1) corner 2, (0,1) corner 3. */
export function quadPoint(c: FurniturePoint[], x: number, y: number): FurniturePoint {
  const w0 = (1 - x) * (1 - y), w1 = x * (1 - y), w2 = x * y, w3 = (1 - x) * y;
  return { x: c[0]!.x * w0 + c[1]!.x * w1 + c[2]!.x * w2 + c[3]!.x * w3, y: c[0]!.y * w0 + c[1]!.y * w1 + c[2]!.y * w2 + c[3]!.y * w3 };
}
