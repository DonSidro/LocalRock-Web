import { isRoundCarpet, mmToCell, zoneBounds, type MapZone, type ParsedMap, type VirtualWall } from '../../../shared/map';

/*
 * Map drawing, ported from LocalRock's MapRenderer.kt. The floor plan is rendered once per map
 * into an offscreen bitmap (one pixel per 50 mm cell); paths, zones and markers are drawn on top
 * in screen space so they stay sharp at any zoom.
 */

export interface MapPalette {
  wall: string;
  floor: string;
  rooms: string[];
  path: string;
  charger: string;
  robot: string;
  markerRing: string;
}

// Light is not the dark palette inverted: the rooms sit above a near-white hero.
export const LIGHT: MapPalette = {
  wall: '#3A4A52',
  floor: '#E9EFEE',
  rooms: ['#BFE0DC', '#C8DCEF', '#CBE3C4', '#EBDCC4', '#D8D2E8', '#C9E2E4', '#EBD5CC', '#D3E0D0'],
  path: '#C75B00',
  charger: '#1565C0',
  robot: '#00595A',
  markerRing: '#FFFFFF',
};

export const DARK: MapPalette = {
  wall: '#070B0C',
  floor: '#17201F',
  rooms: ['#1E3A38', '#1F3140', '#24382A', '#3A3328', '#2E2A3B', '#1C3639', '#38292A', '#26332A'],
  path: '#FFD54F',
  charger: '#64B5F6',
  robot: '#4CDADA',
  markerRing: '#0B1112',
};

export const ZONE_COLORS = {
  NO_GO: { fill: 'rgba(244, 67, 54, 0.2)', stroke: 'rgba(244, 67, 54, 0.8)', solid: '#f44336' },
  NO_MOP: { fill: 'rgba(33, 150, 243, 0.2)', stroke: 'rgba(33, 150, 243, 0.8)', solid: '#2196f3' },
  CARPET: { fill: 'rgba(161, 136, 127, 0.25)', stroke: 'rgba(161, 136, 127, 0.8)', solid: '#a1887f' },
  THRESHOLD: { fill: 'rgba(255, 179, 0, 0.4)', stroke: 'rgba(255, 179, 0, 1)', solid: '#ffb300' },
} as const;
export const WALL_COLOR = '#e53935';

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The floor plan as a bitmap, rows flipped so north is up like the Roborock app. */
export function renderFloor(map: ParsedMap, palette: MapPalette): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(map.width, map.height);
  const data = img.data;
  const wall = rgb(palette.wall);
  const floor = rgb(palette.floor);
  const rooms = palette.rooms.map(rgb);
  const raw = map.originalGrid;
  for (let y = 0; y < map.height; y++) {
    const rowOff = y * map.width;
    const drawY = map.height - 1 - y;
    for (let x = 0; x < map.width; x++) {
      const gv = map.grid[rowOff + x]!;
      let c: [number, number, number] | null = null;
      if (gv === 127) c = wall;
      else if (gv === 128) c = raw ? rooms[((raw[rowOff + x]! >>> 3) & 0x1f) % rooms.length]! : floor;
      else if (gv !== 0 && !raw) c = rooms[gv % rooms.length]!; // B01 segment pixels
      if (!c) continue;
      const o = (drawY * map.width + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export type ToScreen = (xMm: number, yMm: number) => { x: number; y: number };

export function zonePath(ctx: CanvasRenderingContext2D, zone: MapZone, toScreen: ToScreen): void {
  ctx.beginPath();
  if (isRoundCarpet(zone)) {
    const b = zoneBounds(zone);
    const a = toScreen(b.minX, b.minY);
    const c = toScreen(b.maxX, b.maxY);
    const cx = (a.x + c.x) / 2, cy = (a.y + c.y) / 2;
    ctx.ellipse(cx, cy, Math.abs(c.x - a.x) / 2, Math.abs(c.y - a.y) / 2, 0, 0, Math.PI * 2);
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

/** Path, restrictions and markers, in screen space. */
export function drawOverlays(
  ctx: CanvasRenderingContext2D,
  map: ParsedMap,
  palette: MapPalette,
  toScreen: ToScreen,
  pxPerCell: number,
  drawRestrictions: boolean,
): void {
  if (map.pathMm.length >= 2) {
    ctx.strokeStyle = palette.path;
    ctx.lineWidth = Math.max(1, Math.min(2, pxPerCell * 0.5));
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    let started = false;
    for (const p of map.pathMm) {
      const c = mmToCell(map, p.x, p.y);
      if (c.x < 0 || c.x > map.width || c.y < 0 || c.y > map.height) {
        started = false;
        continue;
      }
      const s = toScreen(p.x, p.y);
      if (!started) { ctx.moveTo(s.x, s.y); started = true; } else ctx.lineTo(s.x, s.y);
    }
    ctx.stroke();
  }
  if (drawRestrictions) {
    for (const z of map.carpetAreas) drawZone(ctx, z, toScreen);
    for (const z of map.thresholds) drawZone(ctx, z, toScreen);
    for (const z of map.noMopZones) drawZone(ctx, z, toScreen);
    for (const z of map.noGoZones) drawZone(ctx, z, toScreen);
    for (const w of map.virtualWalls) drawWall(ctx, w, toScreen);
  }
  // Square dock, round robot: distinguishable without relying on colour.
  const r = Math.max(5, Math.min(9, pxPerCell * 3));
  if (map.chargerMm) marker(ctx, map, map.chargerMm, toScreen, palette.charger, palette.markerRing, true, r);
  if (map.robotMm) marker(ctx, map, map.robotMm, toScreen, palette.robot, palette.markerRing, false, r);
}

function marker(
  ctx: CanvasRenderingContext2D, map: ParsedMap, p: { x: number; y: number }, toScreen: ToScreen,
  color: string, ring: string, square: boolean, r: number,
): void {
  const c = mmToCell(map, p.x, p.y);
  if (c.x < 0 || c.x > map.width || c.y < 0 || c.y > map.height) return;
  const s = toScreen(p.x, p.y);
  ctx.fillStyle = ring;
  if (square) {
    ctx.fillRect(s.x - r - 1.5, s.y - r - 1.5, (r + 1.5) * 2, (r + 1.5) * 2);
    ctx.fillStyle = color;
    ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
  } else {
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
