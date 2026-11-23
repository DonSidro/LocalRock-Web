import { erasedCells, isRoundCarpet, mmToCell, roomIdAtCell, zoneBounds, type MapZone, type ParsedMap, type VirtualWall } from '../../../shared/map';
import {
  OFFICIAL_ROOM_COLORS, carpetShade, flatWallRoom, floorPattern, floorPlanShapes, mapOutlineLoops, rgb, roomBorderEdges,
  roomColorSlots, shaded, textureShade, vividOf, type FloorPattern, type FloorPlanShape,
} from './look';
import type { MapTransform } from './view';

/*
 * Map drawing, ported from LocalRock's MapRenderer.kt (app commit 24b1b6c, "draw it the way the
 * Roborock app does"). The floor is rendered once per map into an offscreen layer a few pixels per
 * 50 mm cell: official room colours, floor textures, carpet hatching, smooth outer edges or the
 * floor-plan polygons of block 55. The route, zones and markers are drawn as vectors on top every
 * frame, so they stay sharp at any zoom, heading and tilt.
 */

export interface MapPalette {
  wall: string;
  floor: string;
  rooms: string[];
  /** The route's thin line, and the wide faint band under it for the ground the robot has covered. */
  path: string;
  pathBand: string;
  /** The route on a map that is not being cleaned. */
  idlePath: string;
  charger: string;
  robot: string;
  markerRing: string;
  /** Behind the map; null leaves the page's surface showing. */
  background: string | null;
}

// The hero is black in both themes, as in the Roborock app: the bright room colours need it, and
// gaps in the plan then read as unscanned instead of grey floor.
export const HERO: MapPalette = {
  wall: '#3A4A52',
  floor: '#E9EFEE',
  rooms: OFFICIAL_ROOM_COLORS,
  path: 'rgba(255,255,255,0.6)',
  pathBand: 'rgba(229,229,229,0.3)',
  idlePath: 'rgba(255,255,255,0.35)',
  charger: '#1FB36A',
  robot: '#1FB36A',
  markerRing: '#FFFFFF',
  background: '#000000',
};

export const HERO_DARK: MapPalette = { ...HERO, wall: '#070B0C', floor: '#17201F', charger: '#2ED47E', robot: '#2ED47E', markerRing: '#0B1112' };

// Map pictures on the themed surface (editors, history) need a dark route in light mode.
export const LIGHT: MapPalette = {
  ...HERO,
  path: 'rgba(27,42,48,0.8)',
  pathBand: 'rgba(27,42,48,0.2)',
  idlePath: 'rgba(27,42,48,0.45)',
  background: null,
};

export const DARK: MapPalette = { ...HERO_DARK, background: null };

export const ZONE_COLORS = {
  NO_GO: { fill: 'rgba(244, 67, 54, 0.2)', stroke: 'rgba(244, 67, 54, 0.8)', solid: '#f44336' },
  NO_MOP: { fill: 'rgba(33, 150, 243, 0.2)', stroke: 'rgba(33, 150, 243, 0.8)', solid: '#2196f3' },
  CARPET: { fill: 'rgba(161, 136, 127, 0.25)', stroke: 'rgba(161, 136, 127, 0.8)', solid: '#a1887f' },
  THRESHOLD: { fill: 'rgba(255, 179, 0, 0.4)', stroke: 'rgba(255, 179, 0, 1)', solid: '#ffb300' },
  ERASER: { fill: 'rgba(0, 0, 0, 0)', stroke: 'rgba(0, 0, 0, 0)', solid: '#000000' },
} as const;
export const WALL_COLOR = '#e53935';

// Flat map look, widths in cells.
const MAP_OUTLINE_COLOR = '#8A8F93';
const MAP_OUTLINE_WIDTH_CELLS = 0.3;
const MAP_ROOM_BORDER_COLOR = '#7C8185';
const MAP_ROOM_BORDER_WIDTH_CELLS = 0.22;
// Floor-plan look (block 55): stroke widths in screen px, so they don't shrink with the zoom.
const FLOOR_PLAN_STROKES: Array<['outer' | 'inner' | 'door', string, number]> = [
  ['outer', '#959B9F', 2.8], ['inner', '#B4B9BC', 2.0], ['door', '#F2F2F7', 4.0],
];

/** A map's floor, drawn once: its layer at `scale` px per cell, and the floor-plan shapes stroked per frame. */
export interface FloorLayer { canvas: HTMLCanvasElement; scale: number; shapes: FloorPlanShape[] }

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return [c, c.getContext('2d')!];
}

/** Paints cells into a 1-px-per-cell image; color returns null for a cell left transparent. */
function cellImage(map: ParsedMap, color: (idx: number, x: number, y: number) => [number, number, number] | null): HTMLCanvasElement {
  const [c, ctx] = canvasOf(map.width, map.height);
  const img = ctx.createImageData(map.width, map.height);
  const d = img.data;
  for (let y = 0; y < map.height; y++) {
    const drawY = map.height - 1 - y;
    for (let x = 0; x < map.width; x++) {
      const v = color(y * map.width + x, x, y);
      if (!v) continue;
      const o = (drawY * map.width + x) * 4;
      d[o] = v[0]; d[o + 1] = v[1]; d[o + 2] = v[2]; d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The floor: rooms in the official colours, textures, carpet, smooth edges or the floor plan. */
export function renderFloor(map: ParsedMap, palette: MapPalette, scale: number): FloorLayer {
  const w = map.width, h = map.height;
  const slots = roomColorSlots(map);
  const roomRgb = palette.rooms.map(rgb);
  const base = (room: number) => roomRgb[slots.get(room) ?? 0]!;
  const patterns = new Map<number, FloorPattern>();
  const patternOf = (room: number) => {
    let p = patterns.get(room);
    if (!p) { p = floorPattern(map.segmentMaterials[room], map.segmentMaterialDirections[room]); patterns.set(room, p); }
    return p;
  };
  const raw = map.originalGrid;
  const carpet = map.carpetMask;
  const erased = erasedCells(map);
  const shapes = floorPlanShapes(map);
  const zoned = new Set(shapes.map((s) => s.segment));
  const textured = (room: number, idx: number, x: number, y: number) => {
    const b = base(room);
    const pattern = patternOf(room);
    const floor = pattern === 'NONE' ? b : shaded(b, textureShade(pattern, x, y));
    return carpet && (carpet[idx]! & 1) === 1 ? shaded(floor, carpetShade(x, y)) : floor;
  };
  const wallRgb = rgb(MAP_OUTLINE_COLOR);
  const floorRgb = rgb(palette.floor);
  const cells = cellImage(map, (idx, x, y) => {
    if (erased?.[idx]) return null;
    const gv = map.grid[idx]!;
    if (raw) {
      if (gv !== 127 && gv !== 128) return null;
      // The flat map has no dark wall cells: a wall is painted as the room it belongs to.
      const room = gv === 127 ? flatWallRoom(map.grid, raw, w, h, x, y) : (raw[idx]! >>> 3) & 0x1f;
      if (room === null || zoned.has(room)) return null;
      return textured(room, idx, x, y);
    }
    // B01: segment ids in the grid itself.
    if (gv === 0) return null;
    if (gv === 127) return wallRgb;
    if (gv === 128) return floorRgb;
    return textured(gv, idx, x, y);
  });

  const [layer, ctx] = canvasOf(w * scale, h * scale);
  ctx.imageSmoothingEnabled = false;
  ctx.scale(scale, scale);
  // Rooms with a floor-plan polygon are painted from it, textures clipped to it so no ragged edge shows.
  for (const shape of shapes) {
    const outline = polygon(shape.fill);
    const b = base(shape.segment);
    ctx.fillStyle = `rgb(${b.join(',')})`;
    ctx.fill(outline);
    if (patternOf(shape.segment) === 'NONE' && !carpet) continue;
    const xs = shape.fill.map((p) => p.x), ys = shape.fill.map((p) => p.y);
    const x0 = clamp(Math.trunc(Math.min(...xs)), 0, w), x1 = clamp(Math.trunc(Math.max(...xs)), 0, w);
    const rowTop = clamp(h - Math.trunc(Math.max(...ys)), 0, h), rowBottom = clamp(h - Math.trunc(Math.min(...ys)), 0, h);
    const tex = cellImage(map, (idx, x, y) => {
      if (x < x0 || x >= x1 || y < rowTop || y >= rowBottom || erased?.[idx]) return null;
      const t = textured(shape.segment, idx, x, y);
      return t === b ? null : t;
    });
    ctx.save();
    ctx.clip(outline);
    ctx.drawImage(tex, 0, 0);
    ctx.restore();
  }
  if (shapes.length > 0) {
    ctx.drawImage(cells, 0, 0);
    return { canvas: layer, scale, shapes };
  }
  ctx.drawImage(cells, 0, 0);
  if (raw) {
    ctx.beginPath();
    for (const r of roomBorderEdges(map.grid, raw, w, h)) { ctx.moveTo(r.x0, r.y0); ctx.lineTo(r.x1, r.y1); }
    ctx.strokeStyle = MAP_ROOM_BORDER_COLOR;
    ctx.lineWidth = MAP_ROOM_BORDER_WIDTH_CELLS;
    ctx.stroke();
  }
  // The cells are masked by a rounded outline of the plan, so its edges are smooth, not stair steps.
  const outline = new Path2D();
  for (const loop of mapOutlineLoops(map)) {
    outline.moveTo(loop[0]!.x, loop[0]!.y);
    for (let i = 1; i < loop.length; i++) outline.lineTo(loop[i]!.x, loop[i]!.y);
    outline.closePath();
  }
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#000';
  ctx.fill(outline, 'evenodd');
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = MAP_OUTLINE_COLOR;
  ctx.lineWidth = MAP_OUTLINE_WIDTH_CELLS;
  ctx.lineJoin = 'round';
  ctx.stroke(outline);
  return { canvas: layer, scale: scale, shapes };
}

/** The selected rooms' floor cells in a vivid version of their own colour; null while nothing is selected. */
export function renderSelection(map: ParsedMap, palette: MapPalette, selected: number[]): HTMLCanvasElement | null {
  if (selected.length === 0) return null;
  const want = new Set(selected);
  const slots = roomColorSlots(map);
  const vivid = palette.rooms.map((c) => rgb(vividOf(c)));
  return cellImage(map, (idx) => {
    const room = roomIdAtCell(map, idx);
    return room !== null && want.has(room) ? vivid[slots.get(room) ?? 0]! : null;
  });
}

/** The wall cells alone, as (side, top), for the 3D view to stack into walls. */
export function renderWalls(map: ParsedMap, palette: MapPalette): [HTMLCanvasElement, HTMLCanvasElement] {
  const erased = erasedCells(map);
  const wall = rgb(palette.wall);
  const mix = (t: number): [number, number, number] => [wall[0] + (255 - wall[0]) * t, wall[1] + (255 - wall[1]) * t, wall[2] + (255 - wall[2]) * t];
  const isWall = (idx: number) => map.grid[idx] === 127 && !erased?.[idx];
  const side = mix(0.1), top = mix(0.3);
  return [cellImage(map, (idx) => (isWall(idx) ? side : null)), cellImage(map, (idx) => (isWall(idx) ? top : null))];
}

/** Draws a layer of `scale` px per cell through the view at `height` cells above the floor. */
export function drawLayer(ctx: CanvasRenderingContext2D, layer: CanvasImageSource, view: MapTransform, scale: number, dpr: number, smooth: boolean, height = 0): void {
  const [a, b, c, d, e, f] = view.layerMatrix(scale, height);
  ctx.setTransform(a * dpr, b * dpr, c * dpr, d * dpr, e * dpr, f * dpr);
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(layer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/** The floor-plan walls and doors at a constant width in screen pixels. */
export function drawFloorPlanStrokes(ctx: CanvasRenderingContext2D, shapes: FloorPlanShape[], toScreen: (x: number, y: number) => { x: number; y: number }): void {
  if (shapes.length === 0) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [kind, color, width] of FLOOR_PLAN_STROKES) {
    ctx.beginPath();
    for (const s of shapes) {
      for (const r of s[kind]) {
        const a = toScreen(r.from.x, r.from.y), b = toScreen(r.to.x, r.to.y);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

export type ToScreen = (xMm: number, yMm: number) => { x: number; y: number };

export function zonePath(ctx: CanvasRenderingContext2D, zone: MapZone, toScreen: ToScreen): void {
  ctx.beginPath();
  if (isRoundCarpet(zone)) {
    // An ellipse in robot space, sampled, so it turns and tilts with the map.
    const b = zoneBounds(zone);
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2, rx = (b.maxX - b.minX) / 2, ry = (b.maxY - b.minY) / 2;
    for (let i = 0; i < 48; i++) {
      const t = (i / 48) * Math.PI * 2;
      const p = toScreen(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
  } else {
    const pts = [toScreen(zone.x0, zone.y0), toScreen(zone.x1, zone.y1), toScreen(zone.x2, zone.y2), toScreen(zone.x3, zone.y3)];
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
  }
}

export function drawZone(ctx: CanvasRenderingContext2D, zone: MapZone, toScreen: ToScreen, lineWidth = 1.5, dim = false): void {
  const c = ZONE_COLORS[zone.kind];
  zonePath(ctx, zone, toScreen);
  ctx.globalAlpha = dim ? 0.5 : 1;
  ctx.fillStyle = c.fill;
  ctx.fill();
  ctx.strokeStyle = c.stroke;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawWall(ctx: CanvasRenderingContext2D, wall: VirtualWall, toScreen: ToScreen, lineWidth = 3, dim = false): void {
  const a = toScreen(wall.x0, wall.y0);
  const b = toScreen(wall.x1, wall.y1);
  ctx.globalAlpha = dim ? 0.5 : 1;
  ctx.strokeStyle = WALL_COLOR;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export function drawRestrictions(ctx: CanvasRenderingContext2D, map: ParsedMap, toScreen: ToScreen): void {
  for (const z of map.carpetAreas) drawZone(ctx, z, toScreen);
  for (const z of map.thresholds) drawZone(ctx, z, toScreen);
  for (const z of map.noMopZones) drawZone(ctx, z, toScreen);
  for (const z of map.noGoZones) drawZone(ctx, z, toScreen);
  for (const w of map.virtualWalls) drawWall(ctx, w, toScreen);
}

const inside = (map: ParsedMap, x: number, y: number) => {
  const c = mmToCell(map, x, y);
  return c.x >= 0 && c.x <= map.width && c.y >= -1 && c.y <= map.height;
};

/**
 * The route as vectors: a wide faint band for the ground covered (a robot's width), the thin line
 * of the route over it, and the trips to wash the mop dashed. A faint route is a thin line alone,
 * for a robot that isn't cleaning. pxPerCell sizes the band and line with the zoom.
 */
export function drawRoute(ctx: CanvasRenderingContext2D, map: ParsedMap, palette: MapPalette, toScreen: ToScreen, pxPerCell: number, faint: boolean): void {
  if (map.pathMm.length < 2) return;
  const main = new Path2D();
  const wash = new Path2D();
  let kind = -1;
  let started = false;
  map.pathMm.forEach((p, i) => {
    // As the app's route parser does: only bit 1 is a wash trip; bits 3 and 4 stay on the main route.
    const now = ((map.pathFlags[i] ?? 0) & 0b10) !== 0 ? 2 : 0;
    if (!inside(map, p.x, p.y)) { started = false; return; }
    const s = toScreen(p.x, p.y);
    const target = now === 2 ? wash : main;
    if (!started || now !== kind) target.moveTo(s.x, s.y); else target.lineTo(s.x, s.y);
    started = true;
    kind = now;
  });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (faint) {
    ctx.strokeStyle = palette.idlePath;
    ctx.lineWidth = Math.max(1, 0.45 * pxPerCell);
    ctx.stroke(main);
    return;
  }
  ctx.strokeStyle = palette.pathBand;
  ctx.lineWidth = 6.5 * pxPerCell;
  ctx.stroke(main);
  ctx.strokeStyle = palette.path;
  ctx.lineWidth = Math.max(1, 0.9 * pxPerCell);
  ctx.stroke(main);
  ctx.globalAlpha = 0.33;
  ctx.setLineDash([2 * pxPerCell, 3 * pxPerCell]);
  ctx.stroke(wash);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/**
 * Square dock with a small house, round robot seen from above turned to its heading. Drawn in
 * screen space at the points' screen positions, so they stay upright when the map turns or tilts.
 */
export function drawMarkers(ctx: CanvasRenderingContext2D, map: ParsedMap, palette: MapPalette, toScreen: ToScreen, pxPerCell: number): void {
  const r = Math.min(26, Math.max(6, 5.5 * pxPerCell));
  if (map.chargerMm && inside(map, map.chargerMm.x, map.chargerMm.y)) {
    const s = toScreen(map.chargerMm.x, map.chargerMm.y);
    const q = r * 0.8;
    ctx.fillStyle = palette.markerRing;
    roundRect(ctx, s.x - q - 1.5, s.y - q - 1.5, (q + 1.5) * 2, (q + 1.5) * 2, q * 0.45);
    ctx.fill();
    ctx.fillStyle = palette.charger;
    roundRect(ctx, s.x - q, s.y - q, q * 2, q * 2, q * 0.36);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(s.x, s.y - q * 0.6);
    ctx.lineTo(s.x + q * 0.6, s.y - q * 0.05);
    ctx.lineTo(s.x + q * 0.4, s.y - q * 0.05);
    ctx.lineTo(s.x + q * 0.4, s.y + q * 0.55);
    ctx.lineTo(s.x - q * 0.4, s.y + q * 0.55);
    ctx.lineTo(s.x - q * 0.4, s.y - q * 0.05);
    ctx.lineTo(s.x - q * 0.6, s.y - q * 0.05);
    ctx.closePath();
    ctx.fill();
  }
  const robot = map.robotMm;
  if (robot && inside(map, robot.x, robot.y)) {
    const s = toScreen(robot.x, robot.y);
    // The heading in robot space, carried through the view so it turns with the map.
    const h = ((robot.angle + 180) * Math.PI) / 180;
    const ahead = toScreen(robot.x + Math.cos(h) * 100, robot.y + Math.sin(h) * 100);
    const dir = Math.atan2(ahead.y - s.y, ahead.x - s.x);
    ctx.fillStyle = palette.markerRing;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 1.5, 0, Math.PI * 2);
    ctx.fill();
    drawRobotBody(ctx, s.x, s.y, r, dir);
  }
}

/** The robot from above, with proportions from python-roborock; dir is the screen angle it faces. */
function drawRobotBody(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, dir: number): void {
  const ink = '#455A64';
  const unit = r / 16;
  ctx.lineWidth = Math.max(1, r * 0.09);
  ctx.strokeStyle = ink;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, unit * 14, 0, Math.PI * 2); ctx.stroke();
  // The bin cover is a chord across the heading side (the app draws it at its heading ±76 degrees).
  const back = unit * 13;
  const end = (offset: number) => {
    const a = dir + (offset * Math.PI) / 180;
    return [cx + back * Math.cos(a), cy + back * Math.sin(a)] as const;
  };
  const [ax, ay] = end(76), [bx, by] = end(-76);
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  const lx = cx + unit * 3 * Math.cos(dir), ly = cy + unit * 3 * Math.sin(dir);
  ctx.beginPath(); ctx.arc(lx, ly, unit * 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(69,90,100,0.6)';
  ctx.beginPath(); ctx.arc(cx + unit * 10 * Math.cos(dir), cy + unit * 10 * Math.sin(dir), unit * 2, 0, Math.PI * 2); ctx.fill();
}

function polygon(pts: Array<{ x: number; y: number }>): Path2D {
  const p = new Path2D();
  p.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i]!.x, pts[i]!.y);
  p.closePath();
  return p;
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
