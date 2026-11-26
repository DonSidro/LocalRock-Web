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
  /** The map look's extra layers: carpet seen in one room (17), path points that are wash trips (18), removed areas (47), and floor-plan polygons made from the rooms (55). */
  /** Furniture records (block 25), 23 bytes each. */
  furniture?: number[][];
  look?: { carpetRoom?: number; washTrip?: [number, number]; eraser?: MapZone[]; floorPlan?: boolean };
}

const REPLACED = new Set([8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 22, 24, 25, 28, 32, 37, 39, 47, 55]);

/** The image block's size and offset, and the path's point count, of a legacy map. */
function imageInfo(base: Buffer): { width: number; height: number; left: number; top: number; pathPoints: number } {
  let off = base.readUInt16LE(2);
  const out = { width: 0, height: 0, left: 0, top: 0, pathPoints: 0 };
  while (off + 8 <= base.length) {
    const type = base.readUInt16LE(off);
    const h = base.readUInt16LE(off + 2);
    const len = base.readUInt32LE(off + 4);
    if (type === 2 && h >= 28) {
      out.top = base.readInt32LE(off + 12); out.left = base.readInt32LE(off + 16);
      out.height = base.readInt32LE(off + 20); out.width = base.readInt32LE(off + 24);
    }
    if (type === 3) out.pathPoints = Math.floor(len / 4);
    off += h + len;
  }
  return out;
}

/**
 * Block 55 from the room pixels: each room's outer loop of cell edges, typed 1 (outer wall) or 2
 * (shared with another room), with a 16-cell door (type 3) in the middle of every long shared edge.
 */
export function floorPlanBlock(pixels: Uint8Array, width: number, height: number, left: number, top: number): Buffer {
  const roomAt = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    const v = pixels[y * width + x]!;
    return v !== 0 && (v & 0x07) !== 1 ? (v >>> 3) & 0x1f : 0;
  };
  const rooms = new Set<number>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const r = roomAt(x, y); if (r) rooms.add(r); }
  const zones: Buffer[] = [];
  for (const room of [...rooms].sort((a, b) => a - b)) {
    // Directed unit edges with the room on the left, keyed by start corner, typed by what is across.
    const next = new Map<number, Array<[number, number]>>();
    const key = (x: number, y: number) => x * (height + 1) + y;
    const edge = (x0: number, y0: number, x1: number, y1: number, across: number) => {
      const k = key(x0, y0);
      const e: [number, number] = [key(x1, y1), across !== 0 ? 2 : 1];
      const l = next.get(k); if (l) l.push(e); else next.set(k, [e]);
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (roomAt(x, y) !== room) continue;
        const below = roomAt(x, y - 1), right = roomAt(x + 1, y), above = roomAt(x, y + 1), leftR = roomAt(x - 1, y);
        if (below !== room) edge(x, y, x + 1, y, below);
        if (right !== room) edge(x + 1, y, x + 1, y + 1, right);
        if (above !== room) edge(x + 1, y + 1, x, y + 1, above);
        if (leftR !== room) edge(x, y + 1, x, y, leftR);
      }
    }
    let best: Array<[number, number]> = [];
    while (next.size > 0) {
      const start = next.keys().next().value as number;
      const loop: Array<[number, number]> = [];
      let at = start;
      do {
        const out = next.get(at);
        if (!out) break;
        const [to, type] = out.pop()!;
        if (out.length === 0) next.delete(at);
        loop.push([at, type]);
        at = to;
      } while (at !== start);
      if (loop.length > best.length) best = loop;
    }
    if (best.length < 4) continue;
    const xy = (k: number) => [Math.floor(k / (height + 1)), k % (height + 1)] as const;
    // Merge straight runs of one type into single edges, then put a door in long shared runs.
    const runs: Array<{ from: readonly [number, number]; dir: readonly [number, number]; len: number; type: number }> = [];
    for (let i = 0; i < best.length; i++) {
      const [k, type] = best[i]!;
      const a = xy(k), b = xy(best[(i + 1) % best.length]![0]);
      const dir = [b[0] - a[0], b[1] - a[1]] as const;
      const last = runs[runs.length - 1];
      if (last && last.type === type && last.dir[0] === dir[0] && last.dir[1] === dir[1]) last.len++;
      else runs.push({ from: a, dir, len: 1, type });
    }
    const points: Array<[number, number, number]> = [];
    for (const r of runs) {
      const at = (n: number) => [r.from[0] + r.dir[0] * n, r.from[1] + r.dir[1] * n] as const;
      if (r.type === 2 && r.len >= 24) {
        const d0 = Math.floor((r.len - 16) / 2);
        points.push([...at(0), 2], [...at(d0), 3], [...at(d0 + 16), 2]);
      } else {
        points.push([...at(0), r.type]);
      }
    }
    const z = Buffer.alloc(6 + points.length * 6);
    z.writeUInt16LE(room, 0); z.writeUInt16LE(points.length, 2); z.writeUInt16LE(6, 4);
    points.forEach(([x, y, t], i) => {
      z.writeUInt16LE((x + left) * 50, 6 + i * 6); z.writeUInt16LE((y + top) * 50, 8 + i * 6); z.writeInt16LE(t, 10 + i * 6);
    });
    zones.push(z);
  }
  const header = Buffer.alloc(12);
  const data = Buffer.concat(zones);
  header.writeUInt16LE(55, 0); header.writeUInt16LE(12, 2); header.writeUInt32LE(data.length, 4); header.writeUInt32LE(zones.length, 8);
  return Buffer.concat([header, data]);
}

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
    if (edits.look) {
      const info = imageInfo(base);
      const look = edits.look;
      if (look.carpetRoom !== undefined) {
        const mask = Buffer.alloc(edits.pixels.length);
        edits.pixels.forEach((v, i) => { if (v !== 0 && (v & 0x07) !== 1 && ((v >>> 3) & 0x1f) === look.carpetRoom) mask[i] = 1; });
        out.push(block(17, 8, mask));
      }
      if (look.washTrip && info.pathPoints > 0) {
        const flags = Buffer.alloc(info.pathPoints);
        for (let i = look.washTrip[0]; i < Math.min(look.washTrip[1], info.pathPoints); i++) flags[i] = 0b10;
        out.push(block(18, 8, flags));
      }
      if (look.eraser?.length) {
        const e = Buffer.alloc(look.eraser.length * 20);
        look.eraser.forEach((z, i) => { e.writeUInt32LE(i + 1, i * 20); [z.x0, z.y0, z.x1, z.y1, z.x2, z.y2, z.x3, z.y3].forEach((v, k) => e.writeUInt16LE(v, i * 20 + 4 + k * 2)); });
        out.push(block(47, 12, e, look.eraser.length));
      }
      if (look.floorPlan) out.push(floorPlanBlock(edits.pixels, info.width, info.height, info.left, info.top));
    }
    if (edits.furniture) {
      // A 12-byte header with the record count as a u32 at byte 8, as an S7 MaxV sends it.
      out.push(block(25, 12, Buffer.from(edits.furniture.flat()), edits.furniture.length));
    }
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
