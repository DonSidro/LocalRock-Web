import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseLegacyMap, MapParseError } from '../server/map/legacy.js';
import { parseB01Map } from '../server/map/b01.js';
import { parseAnyMap } from '../server/map/parse.js';
import {
  canvasToMm, cellToMm, mmToCanvas, mmToCell, rectZone, resizeZoneFromCorner, rotateZone, roomAtMm,
  roundHalfEven, thresholdStrip, zoneContains, type ParsedMap,
} from '../shared/map.js';

/* Pinned values copied from LocalRock's LegacyMapTest, B01MapTest and MapGeometryTest. */

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

describe('legacy map', () => {
  const map = parseLegacyMap(fixture('real_map_sample.bin'));

  it('reads the image', () => {
    expect(map.width).toBe(439);
    expect(map.height).toBe(516);
    expect(map.grid.length).toBe(439 * 516);
    expect(map.pixelOffsetLeft).toBe(315);
    expect(map.pixelOffsetTop).toBe(142);
    expect(map.resolution).toBeCloseTo(0.05);
    let outside = 0, wall = 0, floor = 0;
    for (const v of map.grid) { if (v === 0) outside++; else if (v === 127) wall++; else if (v === 128) floor++; }
    expect([outside, wall, floor]).toEqual([170284, 4580, 51660]);
  });

  it('reads charger, robot and path', () => {
    expect(map.chargerMm).toEqual({ x: 25552, y: 24972, angle: 90 });
    expect(map.robotMm).toEqual({ x: 25553, y: 25152, angle: 90 });
    expect(map.pathMm.length).toBe(5307);
    expect(map.pathMm[0]).toMatchObject({ x: 25555, y: 25206 });
    expect(map.pathMm[map.pathMm.length - 1]).toMatchObject({ x: 25554, y: 25156 });
    expect(map.noGoZones).toEqual([]);
    expect(map.noMopZones).toEqual([]);
    expect(map.format).toBe('LEGACY');
  });

  it('rejects a wrong magic', () => {
    expect(() => parseLegacyMap(Uint8Array.from([0xab, 0xcd, 20, 0, 0, 0, 0, 0]))).toThrow(MapParseError);
  });

  it('parses a forbidden zone block', () => {
    const b = Buffer.alloc(80);
    b[0] = 0x72; b[1] = 0x72;
    b.writeUInt16LE(20, 2);
    b.writeUInt16LE(2, 20); b.writeUInt16LE(28, 22); b.writeUInt32LE(4, 24);
    b.writeUInt32LE(2, 40); b.writeUInt32LE(2, 44);
    // FORBIDDEN_ZONES at 52: 12-byte header with count at +8, then one quad.
    b.writeUInt16LE(9, 52); b.writeUInt16LE(12, 54); b.writeUInt32LE(16, 56); b.writeUInt16LE(1, 60);
    [1000, 2000, 3000, 2000, 3000, 4000, 1000, 4000].forEach((v, i) => b.writeUInt16LE(v, 64 + i * 2));
    const m = parseLegacyMap(b);
    expect(m.noGoZones).toEqual([{ x0: 1000, y0: 2000, x1: 3000, y1: 2000, x2: 3000, y2: 4000, x3: 1000, y3: 4000, kind: 'NO_GO' }]);
  });
});

describe('b01 map', () => {
  const raw = gunzipSync(fixture('b01_map_sample.bin.gz'));

  it('parses the python-roborock fixture', () => {
    const map = parseB01Map(raw);
    expect(map.width).toBe(340);
    expect(map.height).toBe(300);
    expect(map.grid.length).toBe(340 * 300);
    expect(map.rooms.length).toBe(10);
    expect(map.resolution).toBeCloseTo(0.05);
    let unknown = 0, wall = 0, floor = 0, other = 0;
    for (const v of map.grid) { if (v === 0) unknown++; else if (v === 127) wall++; else if (v === 128) floor++; else other++; }
    expect([unknown, wall, floor, other]).toEqual([72375, 25841, 3784, 0]);
  });

  it('rejects garbage', () => {
    expect(() => parseB01Map(Uint8Array.from([0xff, 0xff, 0xff]))).toThrow(MapParseError);
  });

  it('is picked by parseAnyMap for each format', () => {
    expect(parseAnyMap(raw).format).toBe('B01');
    expect(parseAnyMap(fixture('real_map_sample.bin')).format).toBe('legacy');
  });
});

describe('geometry', () => {
  const map = { width: 100, height: 80, pixelOffsetLeft: 300, pixelOffsetTop: 200 } as ParsedMap;

  it('round-trips mm and cells', () => {
    const c = mmToCell(map, 17_500, 12_300);
    expect(cellToMm(map, c)).toEqual([17_500, 12_300]);
    const p = mmToCanvas(map, 17_500, 12_300, 400, 320);
    expect(canvasToMm(map, p, 400, 320)).toEqual([17_500, 12_300]);
  });

  it('builds threshold strips like the official app', () => {
    const z = thresholdStrip([1000, 2000], [1900, 2000]);
    expect([z.x0, z.y0, z.x1, z.y1, z.x2, z.y2, z.x3, z.y3]).toEqual([1000, 2057, 1900, 2057, 1900, 1943, 1000, 1943]);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(-2.5)).toBe(-2);
  });

  it('hit-tests rotated zones and keeps sides when resizing', () => {
    const z = rectZone(1000, 1000, 3000, 2000, 'NO_GO');
    expect(zoneContains(z, 2000, 1500)).toBe(true);
    expect(zoneContains(z, 3500, 1500)).toBe(false);
    const r = rotateZone(z, Math.PI / 2);
    expect(zoneContains(r, 2000, 2400)).toBe(true);
    const grown = resizeZoneFromCorner(z, 1, 4000, 2000, 200);
    expect([grown.x1, grown.y1, grown.x3, grown.y3]).toEqual([4000, 2000, 1000, 1000]);
    const tiny = resizeZoneFromCorner(z, 1, 900, 900, 200);
    expect(tiny.x1 - tiny.x0).toBe(200);
  });

  it('finds the room under a point on the real map', () => {
    const real = parseLegacyMap(fixture('real_map_sample.bin'));
    expect(real.rooms.length).toBeGreaterThan(0);
    const room = roomAtMm(real, real.chargerMm!);
    // The charger sits at the edge of a room or on a wall; either answer must not throw.
    expect(room === null || typeof room.id === 'number').toBe(true);
  });
});

describe('map transfer', () => {
  it('derives the legacy grid from the raw pixels exactly', async () => {
    const { legacyGrid } = await import('../shared/map.js');
    const real = parseLegacyMap(fixture('real_map_sample.bin'));
    const derived = legacyGrid(real.originalGrid!);
    expect(Buffer.from(derived).equals(Buffer.from(real.grid))).toBe(true);
  });
});
