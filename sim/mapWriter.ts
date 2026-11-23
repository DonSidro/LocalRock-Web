import type { MapZone, VirtualWall } from '../shared/map.js';

/*
 * Rewrites a legacy "rr" map with new restriction / material blocks and edited pixels, so the
 * simulated robot can answer map edits with a map that shows them (the read-back the app relies on).
 */

export interface MapEdits {
  pixels: Uint8Array;
  noGo: MapZone[];
  noMop: MapZone[];
  walls: VirtualWall[];
  carpets: MapZone[];
  thresholds: MapZone[];
  materials: Map<number, number>;
  directions: Map<number, number>;
  robot: { x: number; y: number; angle: number } | null;
  /** Obstacles with photo ids (block 15, 28-byte records). */
  obstacles?: Array<{ x: number; y: number; type: number; photoId: string }>;
  /** A Cruise record's points (block 37). */
  patrol?: { taskId: number; points: Array<{ x: number; y: number; photoIds: string[] }> };
}

const REPLACED = new Set([8, 9, 10, 12, 13, 14, 15, 16, 22, 24, 28, 32, 37, 39]);

function block(type: number, headerLen: number, data: Buffer, count?: number): Buffer {
  const header = Buffer.alloc(headerLen);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(headerLen, 2);
  header.writeUInt32LE(data.length, 4);
  if (count !== undefined && headerLen >= 12) header.writeUInt16LE(count, 8);
  return Buffer.concat([header, data]);
}

function quads(zones: MapZone[]): Buffer {
  const b = Buffer.alloc(zones.length * 16);
  zones.forEach((z, i) => [z.x0, z.y0, z.x1, z.y1, z.x2, z.y2, z.x3, z.y3].forEach((v, k) => b.writeUInt16LE(v, i * 16 + k * 2)));
  return b;
}

export function writeLegacyMap(base: Buffer, edits: MapEdits): Buffer {
  const headerLen = base.readUInt16LE(2);
  const parts: Buffer[] = [base.subarray(0, headerLen)];
  let off = headerLen;
  let inserted = false;
  const generated = (): Buffer[] => {
    const out: Buffer[] = [];
    if (edits.robot) {
      const p = Buffer.alloc(12);
      p.writeInt32LE(edits.robot.x, 0);
      p.writeInt32LE(edits.robot.y, 4);
      p.writeInt32LE(edits.robot.angle, 8);
      out.push(block(8, 8, p));
    }
    out.push(block(9, 12, quads(edits.noGo), edits.noGo.length));
    out.push(block(12, 12, quads(edits.noMop), edits.noMop.length));
    const w = Buffer.alloc(edits.walls.length * 8);
    edits.walls.forEach((wl, i) => [wl.x0, wl.y0, wl.x1, wl.y1].forEach((v, k) => w.writeUInt16LE(v, i * 8 + k * 2)));
    out.push(block(10, 12, w, edits.walls.length));
    out.push(block(22, 12, quads(edits.carpets), edits.carpets.length));
    const flags = Buffer.alloc(edits.carpets.length * 4);
    edits.carpets.forEach((c, i) => flags.writeUInt32LE((c.flags ?? 0x02338000) >>> 0, i * 4));
    out.push(block(39, 12, Buffer.concat([quads(edits.carpets), flags]), edits.carpets.length));
    out.push(block(28, 12, quads(edits.thresholds), edits.thresholds.length));
    const mat = Buffer.alloc(32);
    for (const [seg, m] of edits.materials) if (seg < 32) mat[seg] = m;
    out.push(block(24, 8, mat));
    const dirs = [...edits.directions];
    const d = Buffer.alloc(dirs.length * 3);
    dirs.forEach(([seg, deg], i) => { d[i * 3] = seg; d.writeUInt16LE(deg, i * 3 + 1); });
    out.push(block(32, 8, d));
    if (edits.obstacles?.length) {
      const o = Buffer.alloc(edits.obstacles.length * 28);
      edits.obstacles.forEach((ob, i) => {
        const p = i * 28;
        o.writeUInt16LE(ob.x, p); o.writeUInt16LE(ob.y, p + 2); o.writeUInt16LE(ob.type, p + 4);
        o.writeUInt16LE(8505, p + 6); o.writeUInt16LE(1001, p + 8);
        o.write(ob.photoId, p + 12, 16, 'ascii');
      });
      out.push(block(15, 12, o, edits.obstacles.length));
    }
    if (edits.patrol) {
      const recLen = 6 + 32 * 2;
      const pts = Buffer.alloc(edits.patrol.points.length * recLen);
      edits.patrol.points.forEach((pt, i) => {
        const p = i * recLen;
        pts.writeUInt16LE(pt.x, p); pts.writeUInt16LE(pt.y, p + 2); pts[p + 4] = 1; pts[p + 5] = pt.photoIds.length;
        pt.photoIds.forEach((id, j) => pts.write(id, p + 6 + j * 32, 32, 'ascii'));
      });
      const header = Buffer.alloc(16);
      header.writeUInt16LE(37, 0); header.writeUInt16LE(16, 2); header.writeUInt32LE(pts.length, 4);
      header.writeUInt32LE(edits.patrol.taskId, 8); header.writeUInt32LE(edits.patrol.points.length, 12);
      out.push(Buffer.concat([header, pts]));
    }
    return out;
  };
  while (off + 8 <= base.length) {
    const type = base.readUInt16LE(off);
    const h = base.readUInt16LE(off + 2);
    const len = base.readUInt32LE(off + 4);
    const whole = base.subarray(off, off + h + len);
    if (type === 1024 && !inserted) {
      parts.push(...generated());
      inserted = true;
    }
    if (type === 2) {
      parts.push(whole.subarray(0, h), Buffer.from(edits.pixels));
    } else if (!REPLACED.has(type)) {
      parts.push(whole);
    }
    off += h + len;
  }
  if (!inserted) parts.push(...generated());
  return Buffer.concat(parts);
}
