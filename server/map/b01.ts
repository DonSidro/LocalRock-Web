import type { MapRoom, ParsedMap } from '../../shared/map.js';
import { MapParseError } from './legacy.js';

/*
 * B01 (Q-series / newer firmware) map parser, ported from LocalRock's B01Map.kt. The map is an
 * SCMap protobuf; only the fields below are read:
 *   RobotMap { 3: mapHead MapHeadInfo, 4: mapData MapDataInfo, 12: repeated roomDataInfo }
 *   MapHeadInfo { 2: sizeX, 3: sizeY, 4: minX f32, 5: minY f32, 6: maxX f32, 7: maxY f32, 8: resolution f32 }
 *   MapDataInfo { 1: mapData bytes }
 *   RoomDataInfo { 1: roomId, 2: roomName, 8: roomNamePos DevicePointInfo, 10: colorId }
 *   DevicePointInfo { 1: x f32, 2: y f32 }
 */

type Field = { wire: 0; value: bigint } | { wire: 1; bytes: Buffer } | { wire: 2; bytes: Buffer } | { wire: 5; bytes: Buffer };

function readVarint(b: Buffer, pos: { p: number }): bigint {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos.p >= b.length) throw new MapParseError('Truncated varint');
    const byte = b[pos.p++]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new MapParseError('Varint too long');
}

/** Every field of one message, by field number, in wire order. */
function readMessage(b: Buffer): Map<number, Field[]> {
  const out = new Map<number, Field[]>();
  const pos = { p: 0 };
  while (pos.p < b.length) {
    const tag = readVarint(b, pos);
    const fieldNo = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (fieldNo === 0) throw new MapParseError('Invalid protobuf field number 0');
    let field: Field;
    switch (wire) {
      case 0:
        field = { wire: 0, value: readVarint(b, pos) };
        break;
      case 1:
        if (pos.p + 8 > b.length) throw new MapParseError('Truncated fixed64');
        field = { wire: 1, bytes: b.subarray(pos.p, pos.p + 8) };
        pos.p += 8;
        break;
      case 2: {
        const len = readVarint(b, pos);
        if (len > BigInt(b.length - pos.p)) throw new MapParseError('Truncated length-delimited field');
        const n = Number(len);
        field = { wire: 2, bytes: b.subarray(pos.p, pos.p + n) };
        pos.p += n;
        break;
      }
      case 5:
        if (pos.p + 4 > b.length) throw new MapParseError('Truncated fixed32');
        field = { wire: 5, bytes: b.subarray(pos.p, pos.p + 4) };
        pos.p += 4;
        break;
      default:
        throw new MapParseError(`Unsupported protobuf wire type ${wire}`);
    }
    const list = out.get(fieldNo);
    if (list) list.push(field); else out.set(fieldNo, [field]);
  }
  return out;
}

function last(fields: Map<number, Field[]>, no: number): Field | undefined {
  const list = fields.get(no);
  return list ? list[list.length - 1] : undefined;
}

function int32(fields: Map<number, Field[]>, no: number): number {
  const f = last(fields, no);
  if (!f) return 0;
  if (f.wire !== 0) throw new MapParseError(`Field ${no} is not a varint`);
  return Number(BigInt.asIntN(32, f.value));
}

function float32(fields: Map<number, Field[]>, no: number): number {
  const f = last(fields, no);
  if (!f) return 0;
  if (f.wire !== 5) throw new MapParseError(`Field ${no} is not a fixed32 float`);
  return f.bytes.readFloatLE(0);
}

function bytesField(fields: Map<number, Field[]>, no: number): Buffer | null {
  const f = last(fields, no);
  if (!f) return null;
  if (f.wire !== 2) throw new MapParseError(`Field ${no} is not length-delimited`);
  return f.bytes;
}

function messages(fields: Map<number, Field[]>, no: number): Map<number, Field[]>[] {
  return (fields.get(no) ?? []).map((f) => {
    if (f.wire !== 2) throw new MapParseError(`Field ${no} is not a message`);
    return readMessage(f.bytes);
  });
}

export function parseB01Map(input: Uint8Array): ParsedMap {
  let root: Map<number, Field[]>;
  let headFields: Map<number, Field[]> | null;
  let dataFields: Map<number, Field[]> | null;
  let roomFields: Map<number, Field[]>[];
  try {
    root = readMessage(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    const head = bytesField(root, 3);
    const data = bytesField(root, 4);
    headFields = head ? readMessage(head) : null;
    dataFields = data ? readMessage(data) : null;
    roomFields = messages(root, 12);
  } catch (e) {
    throw new MapParseError(`Failed to decode B01 SCMap protobuf: ${(e as Error).message}`);
  }
  if (!headFields) throw new MapParseError('B01 map missing mapHead');
  if (!dataFields) throw new MapParseError('B01 map missing mapData');
  const width = int32(headFields, 2);
  const height = int32(headFields, 3);
  const minX = float32(headFields, 4);
  const minY = float32(headFields, 5);
  const maxX = float32(headFields, 6);
  const maxY = float32(headFields, 7);
  const resolution = float32(headFields, 8);
  if (width <= 0 || height <= 0) throw new MapParseError(`B01 map has zero dimensions (${width} x ${height})`);
  const raw = bytesField(dataFields, 1) ?? Buffer.alloc(0);
  const expected = width * height;
  if (raw.length < expected) {
    throw new MapParseError(`B01 map grid is ${raw.length} bytes, expected at least ${expected} for ${width}x${height}`);
  }
  const grid = new Uint8Array(raw.subarray(0, expected));

  // Segment pixels (not outside / wall / unassigned floor) give a fallback label position.
  const sumX = new Map<number, number>();
  const sumY = new Map<number, number>();
  const count = new Map<number, number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = grid[y * width + x]!;
      if (v !== 0 && v !== 127 && v !== 128) {
        sumX.set(v, (sumX.get(v) ?? 0) + x);
        sumY.set(v, (sumY.get(v) ?? 0) + y);
        count.set(v, (count.get(v) ?? 0) + 1);
      }
    }
  }

  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const rooms: MapRoom[] = roomFields.map((r) => {
    const roomId = int32(r, 1);
    const nameBytes = bytesField(r, 2);
    const roomName = nameBytes ? nameBytes.toString('utf8') : '';
    const colorId = int32(r, 10);
    const posBytes = bytesField(r, 8);
    let nx: number | null = null;
    let ny: number | null = null;
    if (posBytes && rangeX > 0 && rangeY > 0) {
      const pos = readMessage(posBytes);
      nx = clamp01((float32(pos, 1) - minX) / rangeX);
      ny = clamp01(1 - (float32(pos, 2) - minY) / rangeY);
    } else {
      const key = [...count.keys()].find((k) => k === colorId && k > 0) ?? [...count.keys()].find((k) => k === roomId && k > 0);
      if (key !== undefined) {
        const n = count.get(key)!;
        nx = clamp01(sumX.get(key)! / n / width);
        ny = clamp01((height - 1 - sumY.get(key)! / n) / height);
      }
    }
    return { id: roomId, name: roomName.trim().length === 0 ? `Room ${roomId}` : roomName, labelNormX: nx, labelNormY: ny };
  });

  return {
    width,
    height,
    grid,
    rooms,
    resolution,
    pixelOffsetLeft: 0,
    pixelOffsetTop: 0,
    chargerMm: null,
    robotMm: null,
    pathMm: [],
    noGoZones: [],
    noMopZones: [],
    virtualWalls: [],
    segmentMaterials: {},
    segmentMaterialDirections: {},
    unmodeledRestrictionBlocks: [],
    format: 'B01',
    carpetAreas: [],
    carpetFlagsPresent: false,
    thresholds: [],
    obstacles: [],
    patrolPoints: [],
    patrolTaskId: null,
    pathFlags: [],
    carpetMask: null,
    zoneLines: [],
    eraserZones: [],
    originalGrid: null,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
