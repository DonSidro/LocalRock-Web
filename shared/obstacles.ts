/*
 * Obstacles the robot recognised and the points of a Cruise run, ported from LocalRock's
 * MapObstacles.kt and the PATROL block of LegacyMap.kt.
 */

/** An obstacle from legacy map blocks 13-16, in robot millimetres. */
export interface MapObstacle {
  x: number;
  y: number;
  type: number | null;
  /** 0-1, null when the record has no confidence fields. */
  confidence: number | null;
  /** Names the photo get_photo returns; null when the robot kept none. */
  photoId: string | null;
  /** From the "ignored" blocks (14 and 16): obstacles the user told the robot to stop avoiding. */
  ignored: boolean;
}

/** One point of a Cruise run (legacy block 37): where it stopped, the result, and the photos it took. */
export interface PatrolPoint {
  x: number;
  y: number;
  result: number;
  photoIds: string[];
}

export interface ObstacleType { name: string; description: string }

const GENERAL_DESC = 'Intelligently recognizes and avoids obstacles that may block its way.';
const PEDESTAL: ObstacleType = { name: 'Pedestal', description: 'Pedestal avoided preventing entrapment.' };
const FABRIC: ObstacleType = { name: 'Fabric', description: 'Fabric recognized, preventing tangling and entrapment.' };
const GENERAL: ObstacleType = { name: 'Obstacle', description: GENERAL_DESC };
const CROSSBAR: ObstacleType = { name: 'Easily trapped furniture', description: 'Furniture with a crossbar, i.e., cantilever chair, avoided preventing entrapment.' };
const PET: ObstacleType = { name: 'Pet', description: 'Pets recognized, preventing collision and disturbance.' };
const FABRIC_BALL: ObstacleType = { name: 'Fabric/paper balls', description: 'Fabric/paper balls recognized, preventing tangling and entrapment.' };

/** The official type table; other types read as a plain obstacle. */
const OBSTACLE_TYPES: Record<number, ObstacleType> = {
  0: { name: 'Wire', description: 'Cord/Wire avoided preventing tangling. Long, thin cords may still become tangled.' },
  1: { name: 'Pet Waste', description: 'Pet waste avoided preventing mess.' },
  2: { name: 'Footwear', description: 'Shoes/slippers avoided preventing entrapment.' },
  3: PEDESTAL,
  4: PEDESTAL,
  5: { name: 'Power Strip', description: 'Power strip avoided preventing entrapment.' },
  9: { name: 'Scale', description: 'Scale avoided preventing entrapment.' },
  10: FABRIC,
  18: GENERAL,
  25: { name: 'Dustpan', description: 'Dustpan or similar objects avoided preventing entrapment.' },
  26: CROSSBAR,
  27: CROSSBAR,
  34: FABRIC,
  42: GENERAL,
  48: { name: 'Cords/wires', description: 'Cords/wires avoided, preventing tangling. Long, thin cords may still be tangled.' },
  49: PET,
  50: PET,
  51: FABRIC_BALL,
  54: { name: 'Stand Mirror', description: 'The robot recognizes stand mirrors, turns to avoid collisions in advance.' },
  65: { name: 'Greenery', description: 'The robot detected greenery and turned to avoid hitting it.' },
  66: FABRIC_BALL,
  67: { name: 'Hanger', description: 'The robot detected a hanger and turned to avoid getting stuck.' },
  69: { name: 'Plastic bag', description: 'The robot detected a plastic bag and turned to avoid entanglement.' },
  70: { name: 'Carryout bag', description: 'The robot detected a carryout bag and turned to avoid entanglement.' },
  81: { name: 'Card', description: 'Card avoided to prevent card being sucked in and causing a jam.' },
};

export function obstacleType(type: number | null): ObstacleType {
  return (type !== null ? OBSTACLE_TYPES[type] : undefined) ?? GENERAL;
}

/** Whole percent as the official sheet shows it ("Confidence:89%"): truncated, not rounded. */
export function confidencePercent(o: MapObstacle): number | null {
  return o.confidence !== null && o.confidence > 0 ? Math.floor(o.confidence * 100 + 1e-4) : null;
}

const u16 = (b: Uint8Array, off: number) => b[off]! | (b[off + 1]! << 8);

function asciiAt(b: Uint8Array, start: number, max: number): string | null {
  let end = start;
  while (end < start + max && end < b.length && b[end] !== 0) end++;
  if (end === start) return null;
  const text = String.fromCharCode(...b.subarray(start, end));
  return /^[!-~]+$/.test(text) ? text : null;
}

/**
 * One obstacle block. Records are evenly sized and the size differs by model: 28 bytes on an S8 Pro
 * Ultra, 36 on a Saros 20 Neo. x and y are u16 at 0 and 2, the type u16 at 4, the confidence u16/u16 at
 * 6 and 8, and records of 28 bytes or more hold the photo id as up to 16 ASCII characters from byte 12.
 */
export function parseObstacles(b: Uint8Array, body: number, count: number, dataLen: number, ignored: boolean): MapObstacle[] {
  if (count <= 0 || dataLen <= 0) return [];
  const size = Math.floor(dataLen / count);
  if (size < 4) return [];
  const out: MapObstacle[] = [];
  for (let i = 0; i < count; i++) {
    const p = body + i * size;
    // vacuum-map-parser-roborock reads the percentage as u1 * 10 / u2 (8505 and 1001 make 85 %).
    let confidence: number | null = null;
    if (size >= 10) { const scale = u16(b, p + 8); confidence = scale === 0 ? 0 : u16(b, p + 6) / (scale * 10); }
    out.push({
      x: u16(b, p), y: u16(b, p + 2), type: size >= 6 ? u16(b, p + 4) : null, confidence,
      photoId: size >= 28 ? asciiAt(b, p + 12, 16) : null, ignored,
    });
  }
  return out;
}

const PATROL_FIXED_BYTES = 6;
const PATROL_ID_BYTES = 32;

/** A PATROL (37) block: per point u16 x, u16 y, u8 result, u8 photo count, then 32-byte photo ids. */
export function parsePatrolPoints(b: Uint8Array, body: number, count: number, dataLen: number): PatrolPoint[] {
  if (count <= 0 || Math.floor(dataLen / count) < PATROL_FIXED_BYTES) return [];
  const recordLen = Math.floor(dataLen / count);
  const out: PatrolPoint[] = [];
  for (let i = 0; i < count; i++) {
    const p = body + i * recordLen;
    const slots = Math.min(b[p + 5]!, Math.floor((recordLen - PATROL_FIXED_BYTES) / PATROL_ID_BYTES));
    const ids: string[] = [];
    for (let j = 0; j < slots; j++) {
      const start = p + PATROL_FIXED_BYTES + j * PATROL_ID_BYTES;
      ids.push(String.fromCharCode(...b.subarray(start, start + PATROL_ID_BYTES)).replace(/\0+$/, ''));
    }
    out.push({ x: u16(b, p), y: u16(b, p + 2), result: b[p + 4]!, photoIds: ids });
  }
  return out;
}
