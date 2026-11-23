import type { MapObstacle, PatrolPoint } from './obstacles.js';
/*
 * Parsed map model and the map's coordinate spaces, ported from LocalRock's B01Map.kt (ParsedMap),
 * MapGeometry.kt, MapEditCommands.kt (thresholdStrip) and MapRenderer.kt (contentBoundsNorm).
 *
 *   robot mm   what the robot sends and accepts; Y grows upwards; 50 mm per map pixel
 *   cell       bitmap pixel space of the rendered map; Y grows downwards (rows are flipped)
 *   canvas     cell space scaled to the size the bitmap is drawn at
 */

export type ZoneKind = 'NO_GO' | 'NO_MOP' | 'CARPET' | 'THRESHOLD';
export type MapFormat = 'LEGACY' | 'B01';

export interface MapPoint {
  x: number;
  y: number;
  angle: number;
}

/**
 * A quadrilateral restriction in robot millimetres. The four corners are kept exactly as read so
 * an untouched zone is written back unchanged. Zones the editor creates are axis-aligned with
 * corners top-left, top-right, bottom-right, bottom-left in robot space (Y grows upwards).
 */
export interface MapZone {
  x0: number; y0: number;
  x1: number; y1: number;
  x2: number; y2: number;
  x3: number; y3: number;
  kind: ZoneKind;
  /** Carpet flags from map block 39, sent back unchanged in set_carpet_area. */
  flags?: number | null;
}

export interface VirtualWall {
  x0: number; y0: number;
  x1: number; y1: number;
}

export interface MapRoom {
  id: number;
  name: string;
  labelNormX: number | null;
  labelNormY: number | null;
}

export interface ParsedMap {
  width: number;
  height: number;
  /** 0 outside, 127 wall, 128 floor (B01: 1-126 segment ids too). Row 0 is the bottom of the map. */
  grid: Uint8Array;
  rooms: MapRoom[];
  resolution: number;
  pixelOffsetLeft: number;
  pixelOffsetTop: number;
  chargerMm: MapPoint | null;
  robotMm: MapPoint | null;
  pathMm: MapPoint[];
  noGoZones: MapZone[];
  noMopZones: MapZone[];
  virtualWalls: VirtualWall[];
  /** Segment id -> raw floor material id (legacy block 24). */
  segmentMaterials: Record<number, number>;
  /** Segment id -> wood direction in degrees (legacy block 32). */
  segmentMaterialDirections: Record<number, number>;
  /** Legacy restriction block types this app does not model that hold at least one entry. */
  unmodeledRestrictionBlocks: number[];
  format: MapFormat;
  carpetAreas: MapZone[];
  /** Obstacles the robot recognised (legacy blocks 13-16). Shown, not edited. */
  obstacles: MapObstacle[];
  /** The points of a Cruise run's record map (legacy block 37), with its task id. */
  patrolPoints: PatrolPoint[];
  patrolTaskId: number | null;
  /** The map stores carpet flags (block 39), so set_carpet_area must send them back. */
  carpetFlagsPresent: boolean;
  thresholds: MapZone[];
  /** Legacy raw pixels: (v >> 3) & 0x1f is the room id. */
  originalGrid: Uint8Array | null;
}

/** Floor material ids seen on the S8 Pro Ultra and in captures of the official app. */
export const FloorMaterial = { DEFAULT: 0, WOOD: 3, TILE: 4 } as const;

export const CARPET_FLAG_ROUND = 0x04000000;
export const NEW_ROUND_CARPET_FLAGS = 0x06338000;
export const NEW_RECT_CARPET_FLAGS = 0x02338000;

export const MM_PER_CELL = 50;
/** Largest coordinate the robot's map can hold: 1024 pixels of 50 mm. */
export const MAX_MAP_COORD_MM = 51_200;
/** save_map refuses more than this many vertices in total (walls count 2, zones 4). */
export const MAX_RESTRICTION_VERTICES = 68;
/** Width of the threshold strips the official app drew (both captured ones measured ~114 mm). */
export const THRESHOLD_WIDTH_MM = 114;

/** The 0 / 127 / 128 grid of a legacy map from its raw pixels (0 outside, low bits 1 wall, else floor). */
export function legacyGrid(pixels: Uint8Array): Uint8Array {
  const grid = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i]!;
    grid[i] = v === 0 ? 0 : (v & 0x07) === 1 ? 127 : 128;
  }
  return grid;
}

export function isRoundCarpet(z: MapZone): boolean {
  return z.kind === 'CARPET' && z.flags != null && (z.flags & CARPET_FLAG_ROUND) !== 0;
}

export function zoneBounds(z: MapZone) {
  return {
    minX: Math.min(z.x0, z.x1, z.x2, z.x3),
    minY: Math.min(z.y0, z.y1, z.y2, z.y3),
    maxX: Math.max(z.x0, z.x1, z.x2, z.x3),
    maxY: Math.max(z.y0, z.y1, z.y2, z.y3),
  };
}

/** Axis-aligned rectangle zone from two opposite corners in mm. */
export function rectZone(axMm: number, ayMm: number, bxMm: number, byMm: number, kind: ZoneKind): MapZone {
  const loX = Math.min(axMm, bxMm), hiX = Math.max(axMm, bxMm);
  const loY = Math.min(ayMm, byMm), hiY = Math.max(ayMm, byMm);
  return { x0: loX, y0: hiY, x1: hiX, y1: hiY, x2: hiX, y2: loY, x3: loX, y3: loY, kind };
}

/** Ties to even, like kotlin.math.round. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return r - 1;
  return r;
}

/**
 * A threshold strip along the line A-B, THRESHOLD_WIDTH_MM wide, with corners in the order the
 * official app used: A and B on one side, then B and A on the other.
 */
export function thresholdStrip(a: [number, number], b: [number, number]): MapZone {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) throw new Error('Draw the threshold as a line across the doorway');
  const half = THRESHOLD_WIDTH_MM / 2;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  const p = (x: number, y: number, sign: number): [number, number] =>
    [roundHalfEven(x + sign * nx), roundHalfEven(y + sign * ny)];
  const a1 = p(a[0], a[1], 1), b1 = p(b[0], b[1], 1);
  const b2 = p(b[0], b[1], -1), a2 = p(a[0], a[1], -1);
  return { x0: a1[0], y0: a1[1], x1: b1[0], y1: b1[1], x2: b2[0], y2: b2[1], x3: a2[0], y3: a2[1], kind: 'THRESHOLD' };
}

export interface Offset { x: number; y: number }

/** Robot mm -> bitmap cell (Y flipped to match the renderer). */
export function mmToCell(map: ParsedMap, xMm: number, yMm: number): Offset {
  const cellX = xMm / MM_PER_CELL - map.pixelOffsetLeft;
  const cellYFromBottom = yMm / MM_PER_CELL - map.pixelOffsetTop;
  return { x: cellX, y: (map.height - 1) - cellYFromBottom };
}

/** Bitmap cell -> robot mm; exact inverse of mmToCell up to rounding. */
export function cellToMm(map: ParsedMap, cell: Offset): [number, number] {
  const xMm = Math.round((cell.x + map.pixelOffsetLeft) * MM_PER_CELL);
  const yMm = Math.round(((map.height - 1) - cell.y + map.pixelOffsetTop) * MM_PER_CELL);
  return [xMm, yMm];
}

export function mmToCanvas(map: ParsedMap, xMm: number, yMm: number, canvasW: number, canvasH: number): Offset {
  const c = mmToCell(map, xMm, yMm);
  return { x: (c.x * canvasW) / map.width, y: (c.y * canvasH) / map.height };
}

export function canvasToMm(map: ParsedMap, p: Offset, canvasW: number, canvasH: number): [number, number] {
  return cellToMm(map, { x: (p.x * map.width) / canvasW, y: (p.y * map.height) / canvasH });
}

/** Even-odd ray cast over the zone's four corners, so rotated zones hit-test correctly. */
export function zoneContains(z: MapZone, xMm: number, yMm: number): boolean {
  const xs = [z.x0, z.x1, z.x2, z.x3];
  const ys = [z.y0, z.y1, z.y2, z.y3];
  let inside = false;
  let j = 3;
  for (let i = 0; i < 4; i++) {
    if ((ys[i]! > yMm) !== (ys[j]! > yMm)) {
      const crossX = xs[i]! + ((yMm - ys[i]!) * (xs[j]! - xs[i]!)) / (ys[j]! - ys[i]!);
      if (xMm < crossX) inside = !inside;
    }
    j = i;
  }
  return inside;
}

/** Shortest distance in mm from a point to the segment A-B. */
export function distanceToSegmentMm(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function zoneCorners(z: MapZone): [number, number][] {
  return [[z.x0, z.y0], [z.x1, z.y1], [z.x2, z.y2], [z.x3, z.y3]];
}

function withCorners(z: MapZone, c: [number, number][]): MapZone {
  return {
    ...z,
    x0: Math.round(c[0]![0]), y0: Math.round(c[0]![1]),
    x1: Math.round(c[1]![0]), y1: Math.round(c[1]![1]),
    x2: Math.round(c[2]![0]), y2: Math.round(c[2]![1]),
    x3: Math.round(c[3]![0]), y3: Math.round(c[3]![1]),
  };
}

export function zoneCenter(z: MapZone): [number, number] {
  return [(z.x0 + z.x1 + z.x2 + z.x3) / 4, (z.y0 + z.y1 + z.y2 + z.y3) / 4];
}

export function translateZone(z: MapZone, dx: number, dy: number): MapZone {
  return {
    ...z,
    x0: z.x0 + dx, y0: z.y0 + dy, x1: z.x1 + dx, y1: z.y1 + dy,
    x2: z.x2 + dx, y2: z.y2 + dy, x3: z.x3 + dx, y3: z.y3 + dy,
  };
}

/** Rotate every corner about the zone's centre; corner order is kept. */
export function rotateZone(z: MapZone, angleRad: number): MapZone {
  const [cx, cy] = zoneCenter(z);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return withCorners(z, zoneCorners(z).map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as [number, number];
  }));
}

/**
 * Move corner `index` of a rectangular zone to (x, y) while the opposite corner stays put and the
 * zone keeps its angle and corner order. Each side is kept at least minSideMm and never flips.
 */
export function resizeZoneFromCorner(z: MapZone, index: number, x: number, y: number, minSideMm: number): MapZone {
  const p = zoneCorners(z);
  const k = (index + 2) % 4;
  const pk = p[k]!;
  const n1 = p[(k + 1) % 4]!;
  const n3 = p[(k + 3) % 4]!;
  const e1: [number, number] = [n1[0] - pk[0], n1[1] - pk[1]];
  const e2: [number, number] = [n3[0] - pk[0], n3[1] - pk[1]];
  const len1 = Math.hypot(e1[0], e1[1]);
  const len2 = Math.hypot(e2[0], e2[1]);
  if (len1 === 0 || len2 === 0) return z;
  const u: [number, number] = [e1[0] / len1, e1[1] / len1];
  const v: [number, number] = [e2[0] / len2, e2[1] / len2];
  const dx = x - pk[0];
  const dy = y - pk[1];
  const a = Math.max(dx * u[0] + dy * u[1], minSideMm);
  const b = Math.max(dx * v[0] + dy * v[1], minSideMm);
  const out: [number, number][] = [pk, pk, pk, pk];
  out[(k + 1) % 4] = [pk[0] + a * u[0], pk[1] + a * u[1]];
  out[(k + 2) % 4] = [pk[0] + a * u[0] + b * v[0], pk[1] + a * u[1] + b * v[1]];
  out[(k + 3) % 4] = [pk[0] + b * v[0], pk[1] + b * v[1]];
  return withCorners(z, out);
}

/** Centre line of a threshold strip: the midpoints of its two short ends. */
export function thresholdCenterLine(z: MapZone): [[number, number], [number, number]] {
  return [
    [Math.trunc((z.x0 + z.x3) / 2), Math.trunc((z.y0 + z.y3) / 2)],
    [Math.trunc((z.x1 + z.x2) / 2), Math.trunc((z.y1 + z.y2) / 2)],
  ];
}

export function translateWall(w: VirtualWall, dx: number, dy: number): VirtualWall {
  return { x0: w.x0 + dx, y0: w.y0 + dy, x1: w.x1 + dx, y1: w.y1 + dy };
}

export function wallWithEnd(w: VirtualWall, end: number, x: number, y: number): VirtualWall {
  return end === 0 ? { ...w, x0: x, y0: y } : { ...w, x1: x, y1: y };
}

export function inMapRange(...coords: number[]): boolean {
  return coords.every((c) => c >= 0 && c <= MAX_MAP_COORD_MM);
}

export const zoneFitsMap = (z: MapZone) => inMapRange(z.x0, z.y0, z.x1, z.y1, z.x2, z.y2, z.x3, z.y3);
export const wallFitsMap = (w: VirtualWall) => inMapRange(w.x0, w.y0, w.x1, w.y1);

export function restrictionVertexCount(walls: number, zones: number): number {
  return walls * 2 + zones * 4;
}

/** The room under a normalised point (0..1, Y as drawn: 0 is the top). */
export function roomAtNorm(map: ParsedMap, normX: number, normY: number): MapRoom | null {
  if (map.rooms.length === 0) return null;
  const col = clampInt(Math.trunc(normX * map.width), 0, map.width - 1);
  const row = clampInt(Math.trunc((1 - normY) * map.height), 0, map.height - 1);
  const idx = row * map.width + col;

  if (map.originalGrid) {
    const v = map.originalGrid[idx]!;
    if (v === 0 || (v & 0x07) === 1) return null;
    const roomId = (v >>> 3) & 0x1f;
    return roomId > 0 ? map.rooms.find((r) => r.id === roomId) ?? null : null;
  }

  // B01: 0 = outside, 127 = wall, 128 = unassigned floor, 1-126 = segment id.
  const v = map.grid[idx]!;
  if (v === 0 || v === 127) return null;
  if (v !== 128) {
    const hit = map.rooms.find((r) => r.id === v);
    if (hit) return hit;
  }
  // Unassigned floor or unmatched segment: fall back to the nearest labelled room.
  let best: MapRoom | null = null;
  let bestD = Infinity;
  for (const r of map.rooms) {
    if (r.labelNormX == null || r.labelNormY == null) continue;
    const dx = r.labelNormX - normX;
    const dy = r.labelNormY - normY;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/** The room under a point in robot mm, or null when it is on no room's floor. */
export function roomAtMm(map: ParsedMap, point: { x: number; y: number }): MapRoom | null {
  const col = Math.floor(point.x / 50 - map.pixelOffsetLeft);
  const row = Math.floor(point.y / 50 - map.pixelOffsetTop);
  if (col < 0 || col >= map.width || row < 0 || row >= map.height) return null;
  return roomAtNorm(map, (col + 0.5) / map.width, 1 - (row + 0.5) / map.height);
}

export interface ContentBounds { left: number; top: number; right: number; bottom: number }

/**
 * Normalised bounds (0..1, drawn-image space with Y flipped) of the cells that contain floor or
 * wall, so a view can frame the floor plan instead of the mostly empty grid.
 */
export function contentBoundsNorm(map: ParsedMap): ContentBounds {
  let minX = map.width, maxX = -1, minY = map.height, maxY = -1;
  for (let y = 0; y < map.height; y++) {
    const rowOff = y * map.width;
    const drawY = map.height - 1 - y;
    for (let x = 0; x < map.width; x++) {
      const gv = map.grid[rowOff + x]!;
      if (gv !== 127 && gv !== 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (drawY < minY) minY = drawY;
      if (drawY > maxY) maxY = drawY;
    }
  }
  if (maxX < 0 || maxY < 0) return { left: 0, top: 0, right: 1, bottom: 1 };
  return {
    left: minX / map.width,
    top: minY / map.height,
    right: (maxX + 1) / map.width,
    bottom: (maxY + 1) / map.height,
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
