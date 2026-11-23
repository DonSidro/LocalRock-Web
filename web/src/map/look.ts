import { FloorMaterial, erasedCells, erasedRoomIds, roomIdAtCell, type FloorPlanPoint, type FloorPlanZone, type ParsedMap } from '../../../shared/map.js';

/*
 * The map's look, ported from LocalRock's RoomColors.kt, FloorTexture.kt, MapBorders.kt,
 * MapOutline.kt and FloorPlan.kt (app commit 24b1b6c). Pure functions, so they are unit tested;
 * render.ts turns them into pixels.
 */

// ---- Room colours ----------------------------------------------------------------------------------

/** Blue, salmon, teal and yellow in the order the Roborock app numbers them, then grey for a room it has no colour for. */
export const OFFICIAL_ROOM_COLORS = ['#6EA8EB', '#DB7F66', '#26CFC8', '#E8BA5C', '#B8B8B8'];
/** Palette slot of the colour a room gets when the app cannot give it one of its four. */
export const NO_COLOUR_SLOT = 4;

const ROOM_IDS = 32;
const COLOURS = 4;
const LOOK_ACROSS_CELLS = 6;

const slotCache = new WeakMap<ParsedMap, Map<number, number>>();

/**
 * Palette slot per room id (0 blue, 1 salmon, 2 teal, 3 yellow, NO_COLOUR_SLOT grey), assigned as the
 * Roborock app does: most-touching rooms first, each the lowest of four colours its coloured neighbours lack.
 */
export function roomColorSlots(map: ParsedMap): Map<number, number> {
  const hit = slotCache.get(map);
  if (hit) return hit;
  let out: Map<number, number>;
  if (!map.originalGrid) {
    out = lookAcrossColorSlots(map, COLOURS);
  } else {
    const colours = appRoomColours(map.originalGrid, map.width, map.height, floorPlanTouches(map.zoneLines), erasedRoomIds(map));
    out = new Map([...colours].map(([id, c]) => [id, c >= 1 && c <= 4 ? c - 1 : NO_COLOUR_SLOT]));
  }
  slotCache.set(map, out);
  return out;
}

/** Colour 1-4 per room (0 when it got none) from the raw segment bytes, plus any extra touching pairs. */
export function appRoomColours(
  raw: Uint8Array, width: number, height: number,
  extraTouches: Array<[number, number]> = [], hidden: Set<number> = new Set(),
): Map<number, number> {
  const segment = new Int32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    segment[i] = (v & 0x07) !== 0 ? v >>> 3 : 0;
  }
  const exists = new Array<boolean>(ROOM_IDS).fill(false);
  const pixels = new Array<number>(ROOM_IDS).fill(0);
  const touches = Array.from({ length: ROOM_IDS }, () => new Array<boolean>(ROOM_IDS).fill(false));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const id = segment[i]!;
      if (id === 0) continue;
      exists[id] = true;
      pixels[id]!++;
      if (y > 0) {
        const up = segment[i - width]!;
        if (up !== 0 && up !== id) { touches[id]![up] = true; touches[up]![id] = true; }
      }
      if (x > 0) {
        const left = segment[i - 1]!;
        if (left !== 0 && left !== id) { touches[id]![left] = true; touches[left]![id] = true; }
      }
    }
  }
  for (const [a, b] of extraTouches) {
    if (a >= 1 && a < ROOM_IDS && b >= 1 && b < ROOM_IDS) { touches[a]![b] = true; touches[b]![a] = true; }
  }
  for (const id of hidden) if (id >= 0 && id < ROOM_IDS) { exists[id] = false; pixels[id] = 0; }
  return colourRooms(exists, pixels, touches);
}

/** The colouring step on its own: which rooms exist, how many pixels each has, and which touch which. */
export function colourRooms(exists: boolean[], pixels: number[], touches: boolean[][]): Map<number, number> {
  const degree = Array.from({ length: ROOM_IDS }, (_, id) => {
    let n = 0;
    for (let o = 1; o < ROOM_IDS; o++) if (o !== id && touches[id]![o]) n++;
    return n;
  });
  // A stable sort, like Kotlin's sortedByDescending.
  const order = Array.from({ length: ROOM_IDS - 1 }, (_, i) => i + 1).sort((a, b) => degree[b]! - degree[a]!);
  let biggest = 0;
  for (let id = 0; id < ROOM_IDS; id++) if (pixels[id]! > pixels[biggest]!) biggest = id;

  const colour = new Array<number>(ROOM_IDS).fill(0);
  const buckets: number[][] = Array.from({ length: COLOURS }, () => []);
  if (biggest !== 0) {
    colour[biggest] = 1;
    buckets[0]!.push(biggest);
  }
  for (const room of order) {
    if (room === biggest || !exists[room]) continue;
    const used = new Array<boolean>(COLOURS + 1).fill(false);
    for (const other of order) if (touches[other]![room] && colour[other] !== 0) used[colour[other]!] = true;
    let c = 1;
    while (c <= COLOURS && used[c]) c++;
    if (c <= COLOURS) {
      colour[room] = c;
      buckets[c - 1]!.push(room);
    }
  }
  // A colour nobody got takes half of the rooms of an earlier one, so all four colours show.
  for (let i = 0; i < COLOURS; i++) {
    if (buckets[i]!.length > 0) continue;
    const source = Math.floor((i + 1) / 2) - 1;
    if (source < 0 || buckets[source]!.length <= 1) continue;
    const src = buckets[source]!;
    const half = src.length / 2;
    let k = src.length - 1;
    let moved = 0;
    while (k >= half) {
      buckets[i]!.push(src[k]!);
      moved++;
      k--;
    }
    src.splice(src.length - moved, moved);
  }
  let biggestBucket = 0;
  let emptyBucket = -1;
  let most = 0;
  for (let i = 0; i < COLOURS; i++) {
    if (buckets[i]!.length > most) { most = buckets[i]!.length; biggestBucket = i; }
    if (buckets[i]!.length === 0) emptyBucket = i;
  }
  if (buckets[biggestBucket]!.length >= 2 && emptyBucket !== -1 && buckets[biggestBucket]!.length > buckets[emptyBucket]!.length) {
    while (buckets[biggestBucket]!.length > buckets[emptyBucket]!.length) {
      buckets[emptyBucket]!.push(buckets[biggestBucket]!.pop()!);
    }
  }
  const result = new Map<number, number>();
  for (let id = 1; id < ROOM_IDS; id++) if (exists[id]) result.set(id, 0);
  buckets.forEach((bucket, i) => { for (const room of bucket) result.set(room, i + 1); });
  return result;
}

/** For maps with no raw segment bytes (B01): rooms a short way apart count as touching, then a greedy colouring. */
function lookAcrossColorSlots(map: ParsedMap, slots: number): Map<number, number> {
  const neighbours = new Map<number, Set<number>>();
  const w = map.width;
  const get = (id: number) => { let s = neighbours.get(id); if (!s) { s = new Set(); neighbours.set(id, s); } return s; };
  for (let idx = 0; idx < map.grid.length; idx++) {
    const a = roomIdAtCell(map, idx);
    if (a === null) continue;
    get(a);
    for (const stride of [1, w]) {
      for (let step = 1; step <= LOOK_ACROSS_CELLS; step++) {
        const at = idx + step * stride;
        if (stride === 1 && Math.floor(at / w) !== Math.floor(idx / w)) break;
        const b = roomIdAtCell(map, at);
        if (b === null) continue;
        if (b !== a) { get(a).add(b); get(b).add(a); }
        break;
      }
    }
  }
  const slotOf = new Map<number, number>();
  const rooms = [...neighbours.keys()].sort((a, b) => neighbours.get(b)!.size - neighbours.get(a)!.size || a - b);
  for (const room of rooms) {
    const taken = [...neighbours.get(room)!].map((n) => slotOf.get(n)).filter((s): s is number => s !== undefined);
    let free = -1;
    for (let s = 0; s < slots; s++) if (!taken.includes(s)) { free = s; break; }
    if (free < 0) {
      free = 0;
      for (let s = 1; s < slots; s++) if (taken.filter((t) => t === s).length < taken.filter((t) => t === free).length) free = s;
    }
    slotOf.set(room, free);
  }
  return slotOf;
}

/** The same hue at full strength: how a room looks when it is picked. */
export function vividOf(hex: string): string {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta < 0.001) return toHex(0.78, 0.78, 0.78);
  let hue = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  const s = 0.62, v = 0.95;
  const c = v * s;
  const sector = (hue / 60) % 6;
  const x = c * (1 - Math.abs((sector % 2) - 1));
  const m = v - c;
  const [rr, gg, bb] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(sector)]!;
  return toHex(rr! + m, gg! + m, bb! + m);
}

export function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// ---- Floor textures --------------------------------------------------------------------------------

export type FloorPattern = 'NONE' | 'WOOD_ALONG_X' | 'WOOD_ALONG_Y' | 'TILE';

const PLANK_CELLS = 3;
const TILE_CELLS = 8;
/** Plank and tile contrast as a share of the full pattern; the official app's is only a few percent of lightness. */
const FLOOR_TEXTURE_STRENGTH = 0.25;
/** Carpet hatching contrast as a share of the full pattern. */
const CARPET_HATCH_STRENGTH = 0.45;

/** Wood grain is 0 (planks left to right) or 90 (up and down) degrees; unreported is drawn as 0. */
export function floorPattern(materialId: number | undefined, direction: number | undefined): FloorPattern {
  if (materialId === FloorMaterial.WOOD) return direction === 90 ? 'WOOD_ALONG_Y' : 'WOOD_ALONG_X';
  if (materialId === FloorMaterial.TILE) return 'TILE';
  return 'NONE';
}

/** Shade of the cell at (x, y) against its room's tint, -1 to 1: darkest at plank and tile seams. */
export function textureShade(pattern: FloorPattern, x: number, y: number): number {
  switch (pattern) {
    case 'NONE': return 0;
    case 'WOOD_ALONG_Y': return FLOOR_TEXTURE_STRENGTH * plankShade(x);
    case 'WOOD_ALONG_X': return FLOOR_TEXTURE_STRENGTH * plankShade(y);
    case 'TILE':
      if (x % TILE_CELLS === 0 || y % TILE_CELLS === 0) return FLOOR_TEXTURE_STRENGTH * -0.16;
      return FLOOR_TEXTURE_STRENGTH * ((Math.floor(x / TILE_CELLS) + Math.floor(y / TILE_CELLS)) % 2 === 0 ? 0.03 : -0.03);
  }
}

/** across is the cell index across the grain: a plank is PLANK_CELLS cells wide. */
function plankShade(across: number): number {
  const plank = Math.floor(across / PLANK_CELLS);
  if (across % PLANK_CELLS === 0) return -0.18;
  // Kotlin Int arithmetic, so neighbouring planks differ the same way as in the app.
  const h = Math.imul(plank, 73856093) ^ (Math.imul(plank, 19349663) >>> 7);
  return ((h & 0xff) / 255 - 0.5) * 0.14;
}

/** Diagonal hatching for cells the robot has seen carpet on. */
export function carpetShade(x: number, y: number): number {
  return CARPET_HATCH_STRENGTH * ((x + y) % 4 < 2 ? -0.14 : 0.04);
}

/** base towards black (shade < 0) or white (shade > 0). */
export function shaded(base: [number, number, number], shade: number): [number, number, number] {
  if (shade === 0) return base;
  const t = Math.abs(shade);
  const to = shade < 0 ? 0 : 255;
  return [base[0] + (to - base[0]) * t, base[1] + (to - base[1]) * t, base[2] + (to - base[2]) * t];
}

// ---- Borders and walls ------------------------------------------------------------------------------

/** One straight border segment in drawn (Y-flipped) cell coordinates; either x0 == x1 or y0 == y1. */
export interface BorderRun { x0: number; y0: number; x1: number; y1: number }

function roomOf(grid: Uint8Array, raw: Uint8Array, i: number): number {
  const g = grid[i]!;
  if (g !== 127 && g !== 128) return 0;
  return (raw[i]! >>> 3) & 0x1f;
}

/** Edges between adjacent cells of different rooms, merged into straight runs. */
export function roomBorderEdges(grid: Uint8Array, raw: Uint8Array, width: number, height: number): BorderRun[] {
  const runs: BorderRun[] = [];
  for (let x = 1; x < width; x++) {
    let startY = -1;
    for (let y = 0; y <= height; y++) {
      let differs = false;
      if (y < height) {
        const a = roomOf(grid, raw, y * width + x - 1);
        const b = roomOf(grid, raw, y * width + x);
        differs = a !== 0 && b !== 0 && a !== b;
      }
      if (differs && startY < 0) startY = y;
      if (!differs && startY >= 0) { runs.push({ x0: x, y0: height - y, x1: x, y1: height - startY }); startY = -1; }
    }
  }
  for (let y = 1; y < height; y++) {
    let startX = -1;
    for (let x = 0; x <= width; x++) {
      let differs = false;
      if (x < width) {
        const a = roomOf(grid, raw, (y - 1) * width + x);
        const b = roomOf(grid, raw, y * width + x);
        differs = a !== 0 && b !== 0 && a !== b;
      }
      if (differs && startX < 0) startX = x;
      if (!differs && startX >= 0) { runs.push({ x0: startX, y0: height - y, x1: x, y1: height - y }); startX = -1; }
    }
  }
  return runs;
}

/** The room a wall cell is painted as: its own room id, else a neighbouring floor cell's room, else null. */
export function flatWallRoom(grid: Uint8Array, raw: Uint8Array, width: number, height: number, x: number, y: number): number | null {
  const own = (raw[y * width + x]! >>> 3) & 0x1f;
  if (own !== 0) return own;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    const i = ny * width + nx;
    if (grid[i] === 128) {
      const id = (raw[i]! >>> 3) & 0x1f;
      if (id !== 0) return id;
    }
  }
  return null;
}

// ---- Outline -------------------------------------------------------------------------------------

export interface Pt { x: number; y: number }

const MAX_CUT_CELLS = 0.8;

/** The outline of every floor or wall cell as closed loops in drawn cell coordinates, with stair steps rounded off. */
export function mapOutlineLoops(map: ParsedMap, smoothing = 2): Pt[][] {
  const w = map.width, h = map.height;
  const erased = erasedCells(map);
  const filled = (x: number, yDrawn: number) => {
    if (x < 0 || x >= w || yDrawn < 0 || yDrawn >= h) return false;
    const i = (h - 1 - yDrawn) * w + x;
    if (erased?.[i]) return false;
    const v = map.grid[i]!;
    return v === 127 || v === 128;
  };
  // Directed unit edges with the filled cell on the right, keyed by where they start.
  const next = new Map<number, number[]>();
  const key = (x: number, y: number) => x * (h + 1) + y;
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = next.get(k);
    if (list) list.push(key(x1, y1)); else next.set(k, [key(x1, y1)]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled(x, y)) continue;
      if (!filled(x, y - 1)) edge(x, y, x + 1, y);
      if (!filled(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
      if (!filled(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
      if (!filled(x - 1, y)) edge(x, y + 1, x, y);
    }
  }
  const loops: Pt[][] = [];
  while (next.size > 0) {
    const start = next.keys().next().value as number;
    const points: number[] = [];
    let at = start;
    do {
      points.push(at);
      const out = next.get(at);
      if (!out) break;
      const to = out.pop()!;
      if (out.length === 0) next.delete(at);
      at = to;
    } while (at !== start);
    if (points.length >= 4) loops.push(smooth(dropCollinear(points, h), smoothing));
  }
  return loops;
}

function dropCollinear(points: number[], h: number): Pt[] {
  const pts = points.map((k) => ({ x: Math.floor(k / (h + 1)), y: k % (h + 1) }));
  const kept: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    if ((b.x - a.x) * (c.y - b.y) !== (b.y - a.y) * (c.x - b.x)) kept.push(b);
  }
  return kept;
}

/** Corner cutting: each pass turns a corner into two points up to halfway along its sides, never more than MAX_CUT_CELLS away. */
function smooth(points: Pt[], passes: number): Pt[] {
  let cur = points;
  for (let n = 0; n < passes; n++) {
    const out: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i]!;
      const b = cur[(i + 1) % cur.length]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const cut = Math.min(len * 0.5, MAX_CUT_CELLS) / len;
      out.push({ x: a.x + (b.x - a.x) * cut, y: a.y + (b.y - a.y) * cut });
      out.push({ x: b.x - (b.x - a.x) * cut, y: b.y - (b.y - a.y) * cut });
    }
    cur = out;
  }
  return cur;
}

// ---- Floor plan (block 55) --------------------------------------------------------------------------

/** One straight stretch of a wall, door or edge in drawn coordinates. */
export interface FloorPlanRun { from: Pt; to: Pt }

/** A room's closed fill outline plus its edges, merged into straight runs, by the type of their starting point. */
export interface FloorPlanShape { segment: number; fill: Pt[]; outer: FloorPlanRun[]; inner: FloorPlanRun[]; door: FloorPlanRun[] }

const FLOOR_PLAN_OUTER = new Set([1]);
// Type 6 is where two rooms touch with no type 2 edge on either side; it is drawn as an inner wall.
const FLOOR_PLAN_INNER = new Set([2, 6]);
// The plugin names only 3 as a door, but type 4 edges sit exactly where the official app draws its white door bars.
const FLOOR_PLAN_DOOR = new Set([3, 4]);

/** Image-frame cell corners to drawn coordinates: x is the column, y is flipped like the floor. */
const offsetOf = (height: number, p: FloorPlanPoint): Pt => ({ x: p.x, y: height - p.y });

/** Edge i runs from point i to point i + 1 (the last to the first) and takes point i's type; other types are not drawn. */
export function buildFloorPlan(zones: FloorPlanZone[], height: number): FloorPlanShape[] {
  return zones.filter((z) => z.points.length >= 3).map((zone) => {
    const pts = zone.points.map((p) => offsetOf(height, p));
    const runsOf = (types: Set<number>) => {
      const edges: Array<FloorPlanRun | null> = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        edges.push(types.has(zone.points[i]!.type) && (a.x !== b.x || a.y !== b.y) ? { from: a, to: b } : null);
      }
      return mergeCollinear(edges);
    };
    return { segment: zone.segment, fill: pts, outer: runsOf(FLOOR_PLAN_OUTER), inner: runsOf(FLOOR_PLAN_INNER), door: runsOf(FLOOR_PLAN_DOOR) };
  });
}

/** The room polygons for the floor-plan look; empty when the map has none. */
export function floorPlanShapes(map: ParsedMap): FloorPlanShape[] {
  if (!map.originalGrid || map.zoneLines.length === 0) return [];
  const gone = erasedRoomIds(map);
  return buildFloorPlan(map.zoneLines.filter((z) => !gone.has(z.segment)), map.height);
}

function mergeCollinear(edges: Array<FloorPlanRun | null>): FloorPlanRun[] {
  const runs: FloorPlanRun[] = [];
  let open = null as FloorPlanRun | null;
  for (const edge of edges) {
    const cur = open;
    if (edge === null) { if (cur) runs.push(cur); open = null; }
    else if (cur && continues(cur, edge)) open = { from: cur.from, to: edge.to };
    else { if (cur) runs.push(cur); open = edge; }
  }
  if (open) runs.push(open);
  if (runs.length >= 2 && edges[0] && edges[edges.length - 1] && continues(runs[runs.length - 1]!, runs[0]!)) {
    const first = runs.shift()!;
    runs[runs.length - 1] = { from: runs[runs.length - 1]!.from, to: first.to };
  }
  return runs;
}

function continues(a: FloorPlanRun, b: FloorPlanRun): boolean {
  if (a.to.x !== b.from.x || a.to.y !== b.from.y) return false;
  const ax = a.to.x - a.from.x, ay = a.to.y - a.from.y;
  const bx = b.to.x - b.from.x, by = b.to.y - b.from.y;
  return ax * by - ay * bx === 0 && ax * bx + ay * by > 0;
}

/** Pairs of room ids (smaller first) whose polygons share a stretch of wall. */
export function floorPlanTouches(zones: FloorPlanZone[]): Array<[number, number]> {
  const lines = new Map<string, Array<[number, number, number]>>();
  const add = (k: string, e: [number, number, number]) => { const l = lines.get(k); if (l) l.push(e); else lines.set(k, [e]); };
  for (const zone of zones) {
    const pts = zone.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      if (a.x === b.x && a.y !== b.y) add(`v${a.x}`, [Math.min(a.y, b.y), Math.max(a.y, b.y), zone.segment]);
      else if (a.y === b.y && a.x !== b.x) add(`h${a.y}`, [Math.min(a.x, b.x), Math.max(a.x, b.x), zone.segment]);
    }
  }
  const touches = new Map<string, [number, number]>();
  for (const edges of lines.values()) {
    for (let i = 0; i < edges.length; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const [lo1, hi1, r1] = edges[i]!;
        const [lo2, hi2, r2] = edges[j]!;
        if (r1 !== r2 && Math.min(hi1, hi2) > Math.max(lo1, lo2)) {
          const pair: [number, number] = [Math.min(r1, r2), Math.max(r1, r2)];
          touches.set(pair.join(','), pair);
        }
      }
    }
  }
  return [...touches.values()];
}
