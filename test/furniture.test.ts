import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLegacyMap } from '../server/map/legacy.js';
import { writeLegacyMap } from '../sim/mapWriter.js';
import {
  FURNITURE_CATALOG, blockRecords, editablePlacements, furnitureEditParams, furnitureEditPlan, furnitureEditsConfirmed,
  furnitureKind, furnitureMapBlocker, furnitureSupportFromFlags, hasKnownLayout, mapFurniture, movedPlacement, newFurniture,
  placementCenter, placementDepth, placementWidth, resizedFromHandle, rotatedFromHandle, rotatedPlacement, sameFurnitureBase,
  validFurniturePlacement, type FurniturePlacement,
} from '../shared/furniture.js';
import { floorPlanFitsGrid, type FloorPlanZone, type ParsedMap } from '../shared/map.js';

/* Ported from the app's MapFurnitureTest, FurnitureEditsTest, FurnitureEditGeometryTest and FloorPlanFitTest. Synthetic geometry only. */

const base = readFileSync(fileURLToPath(new URL('./fixtures/real_map_sample.bin', import.meta.url)));
const plain = parseLegacyMap(base);

function record(id: number, type: number, subtype: number, corners: Array<[number, number]>, flag = 1): number[] {
  const b = new Array<number>(23).fill(0);
  corners.forEach(([x, y], i) => { b[i * 4] = x & 0xff; b[i * 4 + 1] = x >> 8; b[i * 4 + 2] = y & 0xff; b[i * 4 + 3] = y >> 8; });
  b[16] = 16; b[17] = 39; b[18] = type; b[19] = subtype; b[20] = flag; b[21] = id; b[22] = 173;
  return b;
}

const box = (x: number, y: number, w: number, h: number): Array<[number, number]> => [[x, y + h], [x + w, y + h], [x + w, y], [x, y]];
const sofa = record(1, 46, 3, box(24_000, 25_000, 2_000, 836));
const bed = record(2, 45, 1, box(27_000, 22_000, 1_200, 2_400));
const hidden = record(3, 50, 0, box(23_000, 22_600, 400, 400), 0);

function mapWith(furniture: number[][] | undefined): ParsedMap {
  return parseLegacyMap(writeLegacyMap(base, {
    pixels: plain.originalGrid!, noGo: plain.noGoZones, noMop: plain.noMopZones, walls: plain.virtualWalls, carpets: plain.carpetAreas,
    thresholds: plain.thresholds, materials: new Map(), directions: new Map(), robot: plain.robotMm, furniture,
  }));
}

describe('furniture block', () => {
  it('keeps every byte of every record, visible or not', () => {
    const map = mapWith([sofa, bed, hidden]);
    const items = mapFurniture(map);
    expect(items).toHaveLength(3);
    expect(items[0]!.rawBytes).toEqual(sofa);
    expect(items[0]!.cornersMm[0]).toEqual({ x: 24_000, y: 25_836 });
    expect([items[0]!.type, items[0]!.subtype, items[0]!.id]).toEqual([46, 3, 1]);
    expect(items.map((f) => f.isVisible)).toEqual([true, true, false]);
    expect(map.noGoZones).toEqual(plain.noGoZones);
  });

  it('reads a map without furniture, and an empty block', () => {
    expect(mapFurniture(plain)).toEqual([]);
    const empty = mapWith([]);
    expect(empty.furnitureBlocks).toHaveLength(1);
    expect(mapFurniture(empty)).toEqual([]);
  });

  it('keeps an unknown layout without guessing a stride, and blocks editing', () => {
    const block = { headerBytes: [25, 0, 12, 0, 23, 0, 0, 0, 2, 0, 0, 0], bodyBytes: sofa };
    expect(hasKnownLayout(block)).toBe(false);
    expect(blockRecords(block)).toEqual([]);
    const map = { ...mapWith([sofa]), furnitureBlocks: [block] };
    expect(furnitureMapBlocker(map, 0)).toMatch(/layout/);
  });

  it('does not draw a crossed or collapsed footprint', () => {
    const crossed = record(4, 46, 1, [[0, 1000], [1000, 0], [1000, 1000], [0, 0]]);
    expect(mapFurniture(mapWith([crossed]))[0]!.isVisible).toBe(false);
  });
});

describe('furniture support', () => {
  it('reads bit 36 of the decimal new_feature_info and nothing else', () => {
    expect(furnitureSupportFromFlags(String(2 ** 36 + 8))).toBe('SUPPORTED');
    expect(furnitureSupportFromFlags('8')).toBe('UNSUPPORTED');
    expect(furnitureSupportFromFlags(null)).toBe('UNKNOWN');
    expect(furnitureSupportFromFlags('0x1000000000')).toBe('UNKNOWN');
  });

  it('only the first saved map of a legacy map can be edited', () => {
    const map = mapWith([sofa]);
    expect(furnitureMapBlocker(map, 0)).toBeNull();
    expect(furnitureMapBlocker(map, 1)).toMatch(/first saved map/);
    expect(furnitureMapBlocker(map, null)).toMatch(/first saved map/);
    expect(furnitureMapBlocker({ ...map, format: 'B01' }, 0)).toMatch(/format/);
    expect(furnitureMapBlocker(mapWith([sofa, record(1, 45, 1, box(30_000, 30_000, 1_200, 2_400))]), 0)).toMatch(/identifiers/);
  });
});

describe('furniture catalog and geometry', () => {
  it('has all 21 observed choices, each once', () => {
    expect(FURNITURE_CATALOG).toHaveLength(21);
    expect(new Set(FURNITURE_CATALOG.map((k) => `${k.type}/${k.subtype}`)).size).toBe(21);
  });

  it('move, rotate and resize keep the id, type and centre', () => {
    const p = newFurniture(-1, furnitureKind(46, 3)!, 25_000, 25_000);
    expect(validFurniturePlacement(p)).toBe(true);
    expect(placementWidth(p)).toBe(2_000);
    const moved = movedPlacement(p, 100, -50);
    expect(placementCenter(moved)).toEqual({ x: 25_100, y: 24_950 });
    const turned = rotatedPlacement(p, 90);
    expect(placementCenter(turned).x).toBeCloseTo(25_000, 0);
    expect(placementWidth(turned)).toBeCloseTo(2_000, 0);
    expect(validFurniturePlacement(turned)).toBe(true);
    const bigger = resizedFromHandle(p, 200, -100);
    expect(placementWidth(bigger)).toBeCloseTo(2_200, 0);
    expect(placementDepth(bigger)).toBeCloseTo(936, 0);
    expect(bigger.corners[0]).toEqual(p.corners[0]);
    // Never below the 100 mm minimum, however far the handle is dragged.
    expect(validFurniturePlacement(resizedFromHandle(p, -10_000, 10_000))).toBe(true);
  });

  it('rotates by the angle swept around the centre', () => {
    const p = newFurniture(-1, furnitureKind(48, 2)!, 25_000, 25_000);
    const r = rotatedFromHandle(p, { x: 26_000, y: 25_000 }, { x: 25_000, y: 26_000 });
    // A quarter turn anticlockwise in robot space moves the top-left corner to the bottom-left.
    expect(r.corners[0]!.x).toBeCloseTo(p.corners[3]!.x, -1);
    expect(r.corners[0]!.y).toBeCloseTo(p.corners[3]!.y, -1);
  });

  it('refuses unknown kinds, tiny or skewed shapes and points off the map', () => {
    const p = newFurniture(-1, furnitureKind(50, 0)!, 25_000, 25_000);
    expect(validFurniturePlacement({ ...p, type: 99 })).toBe(false);
    expect(validFurniturePlacement({ ...p, corners: p.corners.map((c, i) => (i === 2 ? { x: c.x + 300, y: c.y } : c)) })).toBe(false);
    expect(validFurniturePlacement(movedPlacement(p, 60_000, 0))).toBe(false);
  });
});

describe('furniture edits', () => {
  const baseline = mapWith([sofa, bed, hidden]);
  const items = editablePlacements(baseline);

  it('only visible records with a known kind are editable; the hidden one never is', () => {
    expect(items.map((p) => p.key)).toEqual([1, 2]);
  });

  it('sends only the changed records, by stable id', () => {
    const moved = movedPlacement(items[0]!, 500, 0);
    const added = newFurniture(-1, furnitureKind(50, 0)!, 22_000, 22_000);
    const plan = furnitureEditPlan(baseline, 'SUPPORTED', [moved, added]);
    expect(plan.deleted).toEqual([2]);
    expect(furnitureEditParams(plan)).toEqual({
      data: [
        [1, 1, ...moved.corners.flatMap((c) => [c.x, c.y]), 46, 3, 1],
        [1, -1, ...added.corners.flatMap((c) => [c.x, c.y]), 50, 0, 1],
        [0, 2],
      ],
      map_flag: 0,
    });
  });

  it('refuses an edit the robot does not support, forged ids and changed kinds', () => {
    expect(() => furnitureEditPlan(baseline, 'UNKNOWN', items)).toThrow(/verified/);
    expect(() => furnitureEditPlan(baseline, 'UNSUPPORTED', items)).toThrow(/does not report/);
    expect(() => furnitureEditPlan(baseline, 'SUPPORTED', [{ ...items[0]!, key: 3 }])).toThrow(/selection has changed/);
    expect(() => furnitureEditPlan(baseline, 'SUPPORTED', [{ ...items[0]!, type: 45, subtype: 1 }])).toThrow(/selection has changed/);
    expect(() => furnitureEditPlan(baseline, 'SUPPORTED', [items[0]!, items[0]!])).toThrow(/invalid/);
  });

  it('a readback confirms adds, moves and deletes, and the hidden record must stay byte for byte', () => {
    const moved = movedPlacement(items[0]!, 500, 0);
    const added = newFurniture(-1, furnitureKind(50, 0)!, 22_000, 22_000);
    const plan = furnitureEditPlan(baseline, 'SUPPORTED', [moved, items[1]!, added]);
    const savedSofa = record(1, 46, 3, moved.corners.map((c) => [c.x, c.y] as [number, number]));
    const savedAdd = record(9, 50, 0, added.corners.map((c) => [c.x, c.y] as [number, number]));
    expect(furnitureEditsConfirmed(plan, mapWith([savedSofa, bed, hidden, savedAdd]))).toBe(true);
    // The robot moved the corners round by one: still the same item.
    const shifted = [...moved.corners.slice(1), moved.corners[0]!];
    expect(furnitureEditsConfirmed(plan, mapWith([record(1, 46, 3, shifted.map((c) => [c.x, c.y])), bed, hidden, savedAdd]))).toBe(true);
    const touchedHidden = [...hidden]; touchedHidden[22] = 0;
    expect(furnitureEditsConfirmed(plan, mapWith([savedSofa, bed, touchedHidden, savedAdd]))).toBe(false);
    expect(furnitureEditsConfirmed(plan, mapWith([sofa, bed, hidden, savedAdd]))).toBe(false);
    expect(furnitureEditsConfirmed(plan, mapWith([savedSofa, bed, hidden]))).toBe(false);
  });

  it('two overlapping additions need two distinct records', () => {
    const a = newFurniture(-1, furnitureKind(50, 0)!, 22_000, 22_000);
    const b = { ...a, key: -2 };
    const plan = furnitureEditPlan(baseline, 'SUPPORTED', [...items, a, b]);
    const saved = (id: number) => record(id, 50, 0, a.corners.map((c) => [c.x, c.y] as [number, number]));
    expect(furnitureEditsConfirmed(plan, mapWith([sofa, bed, hidden, saved(8)]))).toBe(false);
    expect(furnitureEditsConfirmed(plan, mapWith([sofa, bed, hidden, saved(8), saved(9)]))).toBe(true);
  });

  it('an unchanged readback does not confirm a small nudge inside the tolerance', () => {
    const nudged: FurniturePlacement = movedPlacement(items[0]!, 1, 0);
    const plan = furnitureEditPlan(baseline, 'SUPPORTED', [nudged, items[1]!]);
    expect(furnitureEditsConfirmed(plan, baseline)).toBe(false);
  });

  it('notices when the map under the draft changed', () => {
    expect(sameFurnitureBase(baseline, mapWith([sofa, bed, hidden]))).toBe(true);
    expect(sameFurnitureBase(baseline, mapWith([sofa, bed]))).toBe(false);
    const grid = new Uint8Array(baseline.grid); grid[0] = grid[0] === 0 ? 128 : 0;
    expect(sameFurnitureBase(baseline, { ...baseline, grid })).toBe(false);
  });
});

describe('floor plan fit', () => {
  const w = 40, h = 40;
  const grid = (floor: (x: number, y: number) => boolean) => Uint8Array.from({ length: w * h }, (_, i) => (floor(i % w, Math.trunc(i / w)) ? 128 : 0));
  /** A rectangle over grid cells x0 until x1, y0 until y1 (row 0 at the bottom), as block 55 points. */
  const zone = (x0: number, y0: number, x1: number, y1: number, segment = 1): FloorPlanZone => ({
    segment, points: [{ x: x0, y: y1, type: 1 }, { x: x1, y: y1, type: 1 }, { x: x1, y: y0, type: 1 }, { x: x0, y: y0, type: 1 }],
  });

  it('an outline that matches the floor fits', () => {
    expect(floorPlanFitsGrid([zone(5, 5, 25, 20)], grid((x, y) => x >= 5 && x < 25 && y >= 5 && y < 20), w, h)).toBe(true);
  });

  it('a box around a room that fills only part of it does not fit', () => {
    expect(floorPlanFitsGrid([zone(5, 5, 35, 35)], grid((x, y) => x >= 5 && x < 35 && y >= 5 && y < 15), w, h)).toBe(false);
  });

  it('one bad room among good ones is enough to fall back', () => {
    const g = grid((x, y) => (x < 10 && y < 10) || (x >= 20 && y >= 20 && y < 25));
    expect(floorPlanFitsGrid([zone(0, 0, 10, 10), zone(20, 20, 40, 40, 2)], g, w, h)).toBe(false);
  });

  it('walls count as part of the room, and a small outline is not judged', () => {
    const g = Uint8Array.from({ length: w * h }, (_, i) => {
      const x = i % w, y = Math.trunc(i / w);
      if (x < 4 || x > 25 || y < 4 || y > 20) return 0;
      return x === 4 || x === 25 || y === 4 || y === 20 ? 127 : 128;
    });
    expect(floorPlanFitsGrid([zone(4, 4, 26, 21)], g, w, h)).toBe(true);
    expect(floorPlanFitsGrid([zone(0, 0, 7, 7)], grid(() => false), w, h)).toBe(true);
  });

  it("the simulator's floor plan fits its own map", () => {
    const m = parseLegacyMap(writeLegacyMap(base, {
      pixels: plain.originalGrid!, noGo: [], noMop: [], walls: [], carpets: [], thresholds: [],
      materials: new Map(), directions: new Map(), robot: null, look: { floorPlan: true },
    }));
    expect(m.zoneLines.length).toBeGreaterThan(0);
    expect(floorPlanFitsGrid(m.zoneLines, m.grid, m.width, m.height)).toBe(true);
  });
});
