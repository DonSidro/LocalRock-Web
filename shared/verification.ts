import type { MapZone, ParsedMap, VirtualWall } from './map.js';

/*
 * Read-back checks run after every map edit, ported from LocalRock's MapEditVerification.kt: a
 * change only counts as applied when the next map shows it. Order of entries and corners is
 * ignored and one map pixel (50 mm) of drift is allowed.
 */

export const READBACK_TOLERANCE_MM = 50;

type Pt = [number, number];

function zoneCorners(z: MapZone): Pt[] {
  const pts: Pt[] = [[z.x0, z.y0], [z.x1, z.y1], [z.x2, z.y2], [z.x3, z.y3]];
  return pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function near(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) <= READBACK_TOLERANCE_MM && Math.abs(a[1] - b[1]) <= READBACK_TOLERANCE_MM;
}

function zoneMatches(a: MapZone, b: MapZone): boolean {
  const ca = zoneCorners(a);
  const cb = zoneCorners(b);
  return ca.every((p, i) => near(p, cb[i]!));
}

function wallMatches(a: VirtualWall, b: VirtualWall): boolean {
  const a0: Pt = [a.x0, a.y0], a1: Pt = [a.x1, a.y1];
  const b0: Pt = [b.x0, b.y0], b1: Pt = [b.x1, b.y1];
  return (near(a0, b0) && near(a1, b1)) || (near(a0, b1) && near(a1, b0));
}

/** True when every expected item pairs with a distinct actual item and nothing is left over. */
function matchAll<T>(expected: T[], actual: T[], matches: (a: T, b: T) => boolean): boolean {
  if (expected.length !== actual.length) return false;
  const remaining = [...actual];
  for (const e of expected) {
    const i = remaining.findIndex((r) => matches(e, r));
    if (i < 0) return false;
    remaining.splice(i, 1);
  }
  return true;
}

export const sameZones = (expected: MapZone[], actual: MapZone[]) => matchAll(expected, actual, zoneMatches);
export const sameWalls = (expected: VirtualWall[], actual: VirtualWall[]) => matchAll(expected, actual, wallMatches);

export function restrictionsMatch(map: ParsedMap, noGoZones: MapZone[], noMopZones: MapZone[], walls: VirtualWall[]): boolean {
  return sameZones(noGoZones, map.noGoZones) && sameZones(noMopZones, map.noMopZones) && sameWalls(walls, map.virtualWalls);
}
