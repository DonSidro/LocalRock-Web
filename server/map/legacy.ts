import { parseObstacles, parsePatrolPoints, type MapObstacle, type PatrolPoint } from '../../shared/obstacles.js';
import { legacyGrid, type MapPoint, type MapRoom, type MapZone, type ParsedMap, type VirtualWall, type ZoneKind } from '../../shared/map.js';

/*
 * Legacy "rr" map parser, ported from LocalRock's LegacyMap.kt. Blocks are TLV: u16 type, u16
 * header length, u32 data length. Block ids beyond the classic set (22, 24, 28, 32, 39) were
 * identified on an S8 Pro Ultra from captures of the official app.
 */

export class MapParseError extends Error {}

const BLOCK_CHARGER = 1;
const BLOCK_IMAGE = 2;
const BLOCK_PATH = 3;
const BLOCK_ROBOT_POSITION = 8;
const BLOCK_FORBIDDEN_ZONES = 9;
const BLOCK_VIRTUAL_WALLS = 10;
const BLOCK_FORBIDDEN_MOP_ZONES = 12;
const BLOCK_CARPET_AREAS = 22;
const BLOCK_SEGMENT_MATERIALS = 24;
const BLOCK_THRESHOLDS = 28;
const BLOCK_SEGMENT_MATERIAL_DIRECTIONS = 32;
const BLOCK_CARPETS_WITH_FLAGS = 39;
const BLOCK_DIGEST = 1024;

/** 19 no-carpet, 23 no-vacuum (mop-only), 30 cliff, 31 smart door-sill areas: detected, never rewritten. */
export const UNMODELED_RESTRICTION_BLOCKS: ReadonlySet<number> = new Set([19, 23, 30, 31]);

const LEGACY_PIXEL_RESOLUTION_M = 0.05;

export function isLegacyMap(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x72 && bytes[1] === 0x72;
}

export function parseLegacyMap(input: Uint8Array): ParsedMap {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 20) throw new MapParseError(`Legacy map too short (${bytes.length} bytes)`);
  if (!isLegacyMap(bytes)) throw new MapParseError("Legacy map missing 'rr' magic");
  const headerLen = bytes.readUInt16LE(2);
  if (headerLen !== 20) throw new MapParseError(`Unexpected file header length: ${headerLen}`);

  let imageWidth = 0, imageHeight = 0, imageLeft = 0, imageTop = 0;
  let imagePixels: Uint8Array | null = null;
  let charger: MapPoint | null = null;
  let robot: MapPoint | null = null;
  let path: MapPoint[] = [];
  let noGoZones: MapZone[] = [];
  let noMopZones: MapZone[] = [];
  let virtualWalls: VirtualWall[] = [];
  let carpetAreas: MapZone[] = [];
  let flaggedCarpets: MapZone[] | null = null;
  let thresholds: MapZone[] = [];
  let segmentMaterials: Record<number, number> = {};
  let segmentMaterialDirections: Record<number, number> = {};
  const unmodeled = new Set<number>();
  const obstacles: MapObstacle[] = [];
  let patrolPoints: PatrolPoint[] = [];
  let patrolTaskId: number | null = null;

  let off = headerLen;
  while (off + 8 <= bytes.length) {
    const type = bytes.readUInt16LE(off);
    const blockHeaderLen = bytes.readUInt16LE(off + 2);
    const blockDataLen = bytes.readInt32LE(off + 4);
    if (blockHeaderLen < 8 || blockHeaderLen > bytes.length - off) {
      throw new MapParseError(`Invalid block at off=${off}: header_len=${blockHeaderLen}`);
    }
    if (blockDataLen < 0 || off + blockHeaderLen + blockDataLen > bytes.length) {
      throw new MapParseError(`Block body out of range at off=${off}`);
    }
    const body = off + blockHeaderLen;
    if (type === BLOCK_DIGEST) break;
    switch (type) {
      case BLOCK_IMAGE: {
        if (blockHeaderLen >= 28) {
          const ih = off + 8;
          imageTop = bytes.readInt32LE(ih + 4);
          imageLeft = bytes.readInt32LE(ih + 8);
          imageHeight = bytes.readInt32LE(ih + 12);
          imageWidth = bytes.readInt32LE(ih + 16);
        }
        const count = imageWidth * imageHeight;
        if (count > 0 && body + count <= bytes.length) {
          imagePixels = new Uint8Array(bytes.subarray(body, body + count));
        }
        break;
      }
      case BLOCK_CHARGER:
        if (blockDataLen >= 12) charger = readPoint(bytes, body);
        break;
      case BLOCK_ROBOT_POSITION:
        if (blockDataLen >= 12) robot = readPoint(bytes, body);
        break;
      case BLOCK_PATH: {
        const pointCount = Math.floor(blockDataLen / 4);
        if (pointCount > 0 && body + pointCount * 4 <= bytes.length) {
          const pts: MapPoint[] = new Array(pointCount);
          for (let i = 0; i < pointCount; i++) {
            const p = body + i * 4;
            pts[i] = { x: bytes.readUInt16LE(p), y: bytes.readUInt16LE(p + 2), angle: 0 };
          }
          path = pts;
        }
        break;
      }
      case BLOCK_FORBIDDEN_ZONES:
        noGoZones = parseQuadZones(bytes, off, blockHeaderLen, blockDataLen, 'NO_GO');
        break;
      case BLOCK_FORBIDDEN_MOP_ZONES:
        noMopZones = parseQuadZones(bytes, off, blockHeaderLen, blockDataLen, 'NO_MOP');
        break;
      case BLOCK_VIRTUAL_WALLS:
        virtualWalls = parseWalls(bytes, off, blockHeaderLen, blockDataLen);
        break;
      case BLOCK_CARPET_AREAS:
        carpetAreas = parseQuadZones(bytes, off, blockHeaderLen, blockDataLen, 'CARPET');
        break;
      case BLOCK_CARPETS_WITH_FLAGS:
        flaggedCarpets = parseFlaggedCarpets(bytes, off, blockHeaderLen, blockDataLen);
        break;
      case BLOCK_THRESHOLDS:
        thresholds = parseQuadZones(bytes, off, blockHeaderLen, blockDataLen, 'THRESHOLD');
        break;
      case BLOCK_SEGMENT_MATERIALS: {
        // One byte per segment id, indexed from 0.
        const m: Record<number, number> = {};
        for (let i = 0; i < blockDataLen; i++) m[i] = bytes[body + i]!;
        segmentMaterials = m;
        break;
      }
      case BLOCK_SEGMENT_MATERIAL_DIRECTIONS: {
        // Triplets of u8 segment id + u16 direction in degrees.
        const m: Record<number, number> = {};
        for (let p = 0; p + 3 <= blockDataLen; p += 3) m[bytes[body + p]!] = bytes.readUInt16LE(body + p + 1);
        segmentMaterialDirections = m;
        break;
      }
      // Obstacle blocks, ids from vacuum-map-parser-roborock: 13 obstacles, 14 ignored, 15 and 16 the same with photo ids.
      case 13: case 14: case 15: case 16:
        obstacles.push(...parseObstacles(bytes, body, entryCount(bytes, off, blockHeaderLen, blockDataLen), blockDataLen, type === 14 || type === 16));
        break;
      // A Cruise record: the header carries the task id (u32 at 8) and the point count (u32 at 12).
      case 37:
        if (blockHeaderLen >= 16) {
          patrolTaskId = bytes.readUInt32LE(off + 8);
          patrolPoints = parsePatrolPoints(bytes, body, bytes.readUInt32LE(off + 12), blockDataLen);
        }
        break;
      default:
        if (UNMODELED_RESTRICTION_BLOCKS.has(type) && entryCount(bytes, off, blockHeaderLen, blockDataLen) > 0) {
          unmodeled.add(type);
        }
    }
    off += blockHeaderLen + blockDataLen;
  }

  // Block 39 repeats block 22's corners and adds each carpet's flags. Use it only when the two
  // agree on the count, so a map where they differ can never lose carpets.
  const carpetsFromFlags = flaggedCarpets && flaggedCarpets.length === carpetAreas.length ? flaggedCarpets : null;
  if (carpetsFromFlags) carpetAreas = carpetsFromFlags;

  if (!imagePixels) throw new MapParseError('Legacy map has no IMAGE block');
  const pixels = imagePixels;
  const grid = legacyGrid(pixels);

  const sumX = new Map<number, number>();
  const sumY = new Map<number, number>();
  const count = new Map<number, number>();
  for (let y = 0; y < imageHeight; y++) {
    for (let x = 0; x < imageWidth; x++) {
      const v = pixels[y * imageWidth + x]!;
      if (v !== 0 && (v & 0x07) !== 1) {
        const roomId = (v >>> 3) & 0x1f;
        if (roomId > 0) {
          sumX.set(roomId, (sumX.get(roomId) ?? 0) + x);
          sumY.set(roomId, (sumY.get(roomId) ?? 0) + y);
          count.set(roomId, (count.get(roomId) ?? 0) + 1);
        }
      }
    }
  }
  const rooms: MapRoom[] = [...count.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roomId, n]) => ({
      id: roomId,
      name: `Room ${roomId}`,
      labelNormX: clamp01(sumX.get(roomId)! / n / imageWidth),
      labelNormY: clamp01((imageHeight - 1 - sumY.get(roomId)! / n) / imageHeight),
    }));

  return {
    obstacles,
    patrolPoints,
    patrolTaskId,
    width: imageWidth,
    height: imageHeight,
    grid,
    rooms,
    resolution: LEGACY_PIXEL_RESOLUTION_M,
    pixelOffsetLeft: imageLeft,
    pixelOffsetTop: imageTop,
    chargerMm: charger,
    robotMm: robot,
    pathMm: path,
    noGoZones,
    noMopZones,
    virtualWalls,
    segmentMaterials,
    segmentMaterialDirections,
    unmodeledRestrictionBlocks: [...unmodeled].sort((a, b) => a - b),
    format: 'LEGACY',
    carpetAreas,
    carpetFlagsPresent: carpetsFromFlags !== null,
    thresholds,
    originalGrid: pixels,
  };
}

function readPoint(b: Buffer, off: number): MapPoint {
  return { x: b.readInt32LE(off), y: b.readInt32LE(off + 4), angle: b.readInt32LE(off + 8) };
}

/**
 * Number of entries a restriction block declares: the u16 at off+8 of its 12-byte header. A block
 * with a shorter header has no count field, so any payload counts as present.
 */
function entryCount(b: Buffer, off: number, headerLen: number, dataLen: number): number {
  if (headerLen >= 12) return b.readUInt16LE(off + 8);
  return dataLen > 0 ? 1 : 0;
}

function parseQuadZones(b: Buffer, off: number, headerLen: number, dataLen: number, kind: ZoneKind): MapZone[] {
  const n = Math.min(entryCount(b, off, headerLen, dataLen), Math.floor(dataLen / 16));
  const body = off + headerLen;
  const out: MapZone[] = [];
  for (let i = 0; i < n; i++) {
    const p = body + i * 16;
    out.push({
      x0: b.readUInt16LE(p), y0: b.readUInt16LE(p + 2),
      x1: b.readUInt16LE(p + 4), y1: b.readUInt16LE(p + 6),
      x2: b.readUInt16LE(p + 8), y2: b.readUInt16LE(p + 10),
      x3: b.readUInt16LE(p + 12), y3: b.readUInt16LE(p + 14),
      kind,
    });
  }
  return out;
}

/** Block 39: quadrilaterals like block 22, followed by one u32 of flags per carpet in the same order. */
function parseFlaggedCarpets(b: Buffer, off: number, headerLen: number, dataLen: number): MapZone[] | null {
  const n = entryCount(b, off, headerLen, dataLen);
  if (n * 20 > dataLen) return null;
  const quads = parseQuadZones(b, off, headerLen, dataLen, 'CARPET');
  const flagsStart = off + headerLen + n * 16;
  return quads.map((z, i) => ({ ...z, flags: b.readUInt32LE(flagsStart + i * 4) }));
}

function parseWalls(b: Buffer, off: number, headerLen: number, dataLen: number): VirtualWall[] {
  const n = Math.min(entryCount(b, off, headerLen, dataLen), Math.floor(dataLen / 8));
  const body = off + headerLen;
  const out: VirtualWall[] = [];
  for (let i = 0; i < n; i++) {
    const p = body + i * 8;
    out.push({ x0: b.readUInt16LE(p), y0: b.readUInt16LE(p + 2), x1: b.readUInt16LE(p + 4), y1: b.readUInt16LE(p + 6) });
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
