import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLegacyMap } from '../server/map/legacy.js';
import { writeLegacyMap } from '../sim/mapWriter.js';
import { contentBoundsNorm, erasedCells, erasedRoomIds, roomAtNorm, roomIdAtCell, type MapZone } from '../shared/map.js';
import {
  appRoomColours, buildFloorPlan, carpetShade, colourRooms, floorPattern, floorPlanTouches, mapOutlineLoops,
  roomBorderEdges, roomColorSlots, textureShade, vividOf,
} from '../web/src/map/look.js';
import { MapTransform, fitScale, isTiltDrag, labelTextWidth, nextQuarterTurn, squashForTilt, supersampleFor } from '../web/src/map/view.js';
import { catalogName, modelSubtitle, productDisplayName } from '../shared/products.js';

const base = readFileSync(fileURLToPath(new URL('./fixtures/real_map_sample.bin', import.meta.url)));
const plain = parseLegacyMap(base);

function withLook(look: Parameters<typeof writeLegacyMap>[1]['look']) {
  return parseLegacyMap(writeLegacyMap(base, {
    pixels: plain.originalGrid!, noGo: plain.noGoZones, noMop: plain.noMopZones, walls: plain.virtualWalls, carpets: plain.carpetAreas,
    thresholds: plain.thresholds, materials: new Map(Object.entries(plain.segmentMaterials).map(([k, v]) => [Number(k), v])),
    directions: new Map(Object.entries(plain.segmentMaterialDirections).map(([k, v]) => [Number(k), v])), robot: plain.robotMm, look,
  }));
}

describe('map look blocks', () => {
  it('reads the carpet layer, wash trips, removed areas and floor plan', () => {
    const eraser: MapZone = { x0: 20_000, y0: 30_000, x1: 23_000, y1: 30_000, x2: 23_000, y2: 27_000, x3: 20_000, y3: 27_000, kind: 'ERASER' };
    const m = withLook({ carpetRoom: 18, washTrip: [40, 80], eraser: [eraser], floorPlan: true });
    expect(m.carpetMask?.length).toBe(m.grid.length);
    const carpetCells = [...m.carpetMask!].filter((v) => v === 1).length;
    expect(carpetCells).toBeGreaterThan(0);
    expect(m.pathFlags.length).toBe(m.pathMm.length);
    expect(m.pathFlags.filter((f) => f & 2).length).toBe(40);
    expect(m.eraserZones).toEqual([eraser]);
    expect(m.zoneLines.length).toBe(m.rooms.length);
    expect(m.zoneLines.every((z) => z.points.length >= 4)).toBe(true);
    expect(m.zoneLines.flatMap((z) => z.points).some((p) => p.type === 3)).toBe(true);
  });

  it('leaves the fields empty on a map without them', () => {
    // The S8 sample has a carpet layer (block 17) with nothing on it.
    expect(plain.carpetMask?.length).toBe(plain.grid.length);
    expect(plain.pathFlags.length === 0 || plain.pathFlags.length === plain.pathMm.length).toBe(true);
    expect(plain.zoneLines).toEqual([]);
    expect(plain.eraserZones).toEqual([]);
    expect(erasedCells(plain)).toBeNull();
  });

  it('gives each room the width around its label', () => {
    for (const r of plain.rooms) {
      expect(r.labelSpanCells).toBeGreaterThan(0);
      expect(r.labelSpanCellsY).toBeGreaterThan(0);
    }
  });

  it('drops erased cells from picking and bounds, and a room erased whole', () => {
    const room = plain.rooms[0]!;
    // An eraser over the whole map removes every room.
    const all: MapZone = { x0: 0, y0: 51_200, x1: 51_200, y1: 51_200, x2: 51_200, y2: 0, x3: 0, y3: 0, kind: 'ERASER' };
    const gone = { ...plain, eraserZones: [all] };
    expect(erasedRoomIds(gone).has(room.id)).toBe(true);
    expect(roomAtNorm(gone, room.labelNormX!, room.labelNormY!)).toBeNull();
    expect(roomAtNorm(plain, room.labelNormX!, room.labelNormY!)?.id).toBe(room.id);
    const idx = plain.originalGrid!.findIndex((v) => (v & 7) === 7 && ((v >>> 3) & 0x1f) === room.id);
    expect(roomIdAtCell(plain, idx)).toBe(room.id);
    expect(roomIdAtCell(gone, idx)).toBeNull();
    expect(contentBoundsNorm(gone)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
  });
});

describe('room colours', () => {
  it('gives touching rooms different colours, the biggest room blue', () => {
    // Three rooms in a row: 1 | 2 | 3, room 2 the biggest.
    const w = 9, h = 2;
    const raw = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * w + x] = ((x < 2 ? 1 : x < 7 ? 2 : 3) << 3) | 7;
    const c = appRoomColours(raw, w, h);
    expect(c.get(2)).toBe(1);
    expect(c.get(1)).not.toBe(c.get(2));
    expect(c.get(3)).not.toBe(c.get(2));
  });

  it('spreads rooms over all four colours', () => {
    const exists = new Array(32).fill(false);
    const pixels = new Array(32).fill(0);
    const touches = Array.from({ length: 32 }, () => new Array(32).fill(false));
    for (const id of [1, 2, 3, 4, 5, 6]) { exists[id] = true; pixels[id] = 10 + id; }
    const c = colourRooms(exists, pixels, touches);
    expect(new Set(c.values())).toEqual(new Set([1, 2, 3, 4]));
  });

  it('colours the sample map with no two touching rooms alike', () => {
    const slots = roomColorSlots(plain);
    const raw = plain.originalGrid!;
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1]!, b = raw[i]!;
      if ((a & 7) !== 7 || (b & 7) !== 7) continue;
      const ra = (a >>> 3) & 0x1f, rb = (b >>> 3) & 0x1f;
      if (ra !== rb && slots.get(ra)! < 4 && slots.get(rb)! < 4 && i % plain.width !== 0) expect(slots.get(ra)).not.toBe(slots.get(rb));
    }
  });

  it('brightens a colour for a picked room', () => {
    expect(vividOf('#6EA8EB')).toMatch(/^#[0-9a-f]{6}$/);
    expect(vividOf('#B8B8B8')).toBe('#c7c7c7');
  });
});

describe('floor textures and outlines', () => {
  it('picks plank direction and tile', () => {
    expect(floorPattern(3, 90)).toBe('WOOD_ALONG_Y');
    expect(floorPattern(3, 0)).toBe('WOOD_ALONG_X');
    expect(floorPattern(4, undefined)).toBe('TILE');
    expect(floorPattern(0, undefined)).toBe('NONE');
    expect(textureShade('TILE', 8, 3)).toBeLessThan(0);
    expect(textureShade('WOOD_ALONG_X', 5, 0)).toBeLessThan(0);
    expect(carpetShade(0, 0)).toBeLessThan(carpetShade(2, 0));
  });

  it('outlines the plan with closed loops and finds room borders', () => {
    const loops = mapOutlineLoops(plain);
    expect(loops.length).toBeGreaterThan(0);
    expect(loops[0]!.length).toBeGreaterThan(8);
    const borders = roomBorderEdges(plain.grid, plain.originalGrid!, plain.width, plain.height);
    expect(borders.length).toBeGreaterThan(0);
    expect(borders.every((r) => r.x0 === r.x1 || r.y0 === r.y1)).toBe(true);
  });

  it('builds floor-plan runs by edge type and finds rooms that share a wall', () => {
    const zones = [
      { segment: 1, points: [{ x: 0, y: 0, type: 1 }, { x: 10, y: 0, type: 2 }, { x: 10, y: 10, type: 1 }, { x: 0, y: 10, type: 1 }] },
      { segment: 2, points: [{ x: 10, y: 0, type: 1 }, { x: 20, y: 0, type: 1 }, { x: 20, y: 10, type: 1 }, { x: 10, y: 10, type: 3 }] },
    ];
    const [a, b] = buildFloorPlan(zones, 10);
    // Room 1: bottom, top and left are outer runs (none continue each other), the right edge is inner.
    expect(a!.inner).toEqual([{ from: { x: 10, y: 10 }, to: { x: 10, y: 0 } }]);
    expect(a!.outer.length).toBe(3);
    expect(b!.door).toEqual([{ from: { x: 10, y: 0 }, to: { x: 10, y: 10 } }]);
    expect(floorPlanTouches(zones)).toEqual([[1, 2]]);
  });
});

describe('map view transform', () => {
  it('round-trips a point at any heading and tilt', () => {
    for (const [yaw, tilt] of [[0, 0], [90, 0], [35, 53], [270, 70]] as const) {
      const v = new MapTransform(800, 600, 100, 80, 3.5, 20, -10, yaw, squashForTilt(tilt));
      const s = v.toScreen(123.4, 56.7);
      const c = v.toCell(s.x, s.y);
      expect(c.x).toBeCloseTo(123.4, 6);
      expect(c.y).toBeCloseTo(56.7, 6);
    }
  });

  it('matches the layer matrix with toScreen', () => {
    const v = new MapTransform(800, 600, 100, 80, 2, 5, 7, 35, squashForTilt(53));
    const [a, b, c, d, e, f] = v.layerMatrix(3, 4);
    const px = 30 * 3, py = 40 * 3;
    const s = v.toScreen(30, 40, 4);
    expect(a * px + c * py + e).toBeCloseTo(s.x, 6);
    expect(b * px + d * py + f).toBeCloseTo(s.y, 6);
  });

  it('fits the plan as turned, or its diagonal in 3D', () => {
    expect(fitScale(400, 200, 100, 50, 0, 1, false)).toBe(4);
    expect(fitScale(400, 200, 100, 50, 90, 1, false)).toBe(2);
    expect(fitScale(400, 400, 30, 40, 0, 1, true)).toBe(8);
  });

  it('turns in quarters, tells a tilt drag from a pinch and sizes the layers', () => {
    expect(nextQuarterTurn(0)).toBe(90);
    expect(nextQuarterTurn(270)).toBe(0);
    expect(isTiltDrag(2, 1, 10, 1, 0)).toBe(true);
    expect(isTiltDrag(2, 1, 10, 1.1, 0)).toBe(false);
    expect(isTiltDrag(1, 1, 10, 1, 0)).toBe(false);
    expect(labelTextWidth(false, 10, 36, 300)).toBe(300);
    expect(labelTextWidth(true, 10, 36, 300)).toBe(36);
    expect(labelTextWidth(true, 500, 36, 300)).toBe(300);
    expect(supersampleFor(1024, 1024)).toBe(2);
    expect(supersampleFor(400, 300)).toBe(3);
    expect(supersampleFor(3000, 100)).toBe(1);
  });
});

describe('product names', () => {
  it('prefers the server name, then the catalogue, then the model', () => {
    expect(productDisplayName({ name: 'Roborock Qrevo Curv 2 Pro', model: 'roborock.vacuum.a245' })).toBe('Roborock Qrevo Curv 2 Pro');
    expect(productDisplayName({ name: ' ', model: 'roborock.vacuum.a70' })).toBe('Roborock S8 Pro Ultra');
    expect(catalogName('roborock.vacuum.zz9')).toBe('roborock.vacuum.zz9');
    expect(productDisplayName(null)).toBeNull();
    expect(modelSubtitle('Roborock S8 Pro Ultra', 'roborock s8 pro ultra')).toBeNull();
    expect(modelSubtitle('Kitchen bot', 'Roborock S8 Pro Ultra')).toBe('Roborock S8 Pro Ultra');
  });
});
