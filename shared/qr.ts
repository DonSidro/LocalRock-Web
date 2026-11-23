/*
 * A small QR code encoder for short texts (versions 1 to 10), enough for a Matter setup payload.
 * Ported from LocalRock's QrCode.kt. Uses alphanumeric mode when the text allows it and byte mode
 * otherwise.
 */

/** A finished QR symbol: `size` modules square, true is a dark module. */
export interface QrMatrix {
  size: number;
  get(x: number, y: number): boolean;
}

export type QrLevel = 'L' | 'M' | 'Q';
const LEVEL: Record<QrLevel, { formatBits: number; index: number }> = { L: { formatBits: 1, index: 0 }, M: { formatBits: 0, index: 1 }, Q: { formatBits: 3, index: 2 } };

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MAX_VERSION = 10;

// Index by level (L, M, Q), then version 1..10 (position 0 unused).
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
];

const countBits = (version: number, alnum: boolean) => (alnum ? (version <= 9 ? 9 : 11) : (version <= 9 ? 8 : 16));
const dataBitsAlnum = (n: number) => Math.floor(n / 2) * 11 + (n % 2) * 6;

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

const dataCodewords = (version: number, level: QrLevel) =>
  Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[LEVEL[level].index]![version]! * BLOCKS[LEVEL[level].index]![version]!;

export function encodeQr(text: string, level: QrLevel = 'M'): QrMatrix {
  const alnum = text.length > 0 && [...text].every((c) => ALPHANUMERIC.includes(c));
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (;;) {
    if (version > MAX_VERSION) throw new Error('Text is too long for this QR encoder');
    const capacityBits = dataCodewords(version, level) * 8;
    const used = 4 + countBits(version, alnum) + (alnum ? dataBitsAlnum(text.length) : bytes.length * 8);
    if (used <= capacityBits) break;
    version++;
  }
  const data = buildData(text, bytes, alnum, version, level);
  return buildSymbol(version, level, addEccAndInterleave(data, version, level));
}

function buildData(text: string, bytes: Uint8Array, alnum: boolean, version: number, level: QrLevel): Uint8Array {
  const bits: boolean[] = [];
  const put = (value: number, count: number) => { for (let i = count - 1; i >= 0; i--) bits.push(((value >>> i) & 1) === 1); };
  if (alnum) {
    put(0b0010, 4);
    put(text.length, countBits(version, true));
    let i = 0;
    while (i + 1 < text.length) {
      put(ALPHANUMERIC.indexOf(text[i]!) * 45 + ALPHANUMERIC.indexOf(text[i + 1]!), 11);
      i += 2;
    }
    if (i < text.length) put(ALPHANUMERIC.indexOf(text[i]!), 6);
  } else {
    put(0b0100, 4);
    put(bytes.length, countBits(version, false));
    for (const b of bytes) put(b, 8);
  }
  const capacity = dataCodewords(version, level) * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(false);
  const out = new Uint8Array(capacity / 8);
  bits.forEach((b, i) => { if (b) out[i >> 3]! |= 1 << (7 - (i % 8)); });
  let pad = 0xec;
  for (let i = bits.length / 8; i < out.length; i++) {
    out[i] = pad;
    pad ^= 0xec ^ 0x11;
  }
  return out;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: Uint8Array, divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result[0]!;
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i++) result[i]! ^= gfMultiply(divisor[i]!, factor);
  }
  return result;
}

function addEccAndInterleave(data: Uint8Array, version: number, level: QrLevel): Uint8Array {
  const blocks = BLOCKS[LEVEL[level].index]![version]!;
  const eccLen = ECC_PER_BLOCK[LEVEL[level].index]![version]!;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const result: Uint8Array[] = [];
  let k = 0;
  for (let i = 0; i < blocks; i++) {
    const datLen = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    const block = new Uint8Array(shortLen + 1);
    block.set(dat);
    block.set(ecc, shortLen + 1 - eccLen);
    result.push(block);
  }
  const out = new Uint8Array(raw);
  let o = 0;
  for (let i = 0; i <= shortLen; i++) {
    for (let j = 0; j < blocks; j++) {
      if (i !== shortLen - eccLen || j >= shortBlocks) out[o++] = result[j]![i]!;
    }
  }
  return out;
}

function buildSymbol(version: number, level: QrLevel, codewords: Uint8Array): QrMatrix {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; isFunction[y]![x] = true; };
  const bit = (value: number, i: number) => ((value >>> i) & 1) !== 0;

  const drawFormatBits = (mask: number) => {
    const data = (LEVEL[level].formatBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true);
  };

  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
    }
  };
  const alignment = (cx: number, cy: number) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };
  const alignmentPositions = (): number[] => {
    if (version === 1) return [];
    const count = Math.floor(version / 7) + 2;
    const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    const result = new Array<number>(count).fill(0);
    result[0] = 6;
    let pos = size - 7;
    for (let i = count - 1; i >= 1; i--) { result[i] = pos; pos -= step; }
    return result;
  };

  // Function patterns
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = alignmentPositions();
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
    alignment(align[i]!, align[j]!);
  }
  drawFormatBits(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Codewords, in the zigzag order
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const upward = ((right + 1) & 2) === 0;
      const y = upward ? size - 1 - vert : vert;
      if (!isFunction[y]![x] && n < codewords.length * 8) {
        modules[y]![x] = bit(codewords[n >>> 3]!, 7 - (n & 7));
        n++;
      }
    }
  }

  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let invert: boolean;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
        case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
        default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      }
      if (invert && !isFunction[y]![x]) modules[y]![x] = !modules[y]![x];
    }
  };

  /** Runs of one colour, 2x2 blocks and the dark share; the finder-like rule is left out. */
  const penalty = (): number => {
    let total = 0;
    for (const horizontal of [true, false]) {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const same = horizontal ? modules[a]![b] === modules[a]![b - 1] : modules[b]![a] === modules[b - 1]![a];
          if (same) {
            run++;
            if (run === 5) total += 3; else if (run > 5) total++;
          } else run = 1;
        }
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) total += 3;
    }
    let dark = 0;
    for (const row of modules) for (const m of row) if (m) dark++;
    const k = Math.floor((Math.abs(dark * 20 - size * size * 10) + size * size - 1) / (size * size)) - 1;
    return total + k * 10;
  };

  let bestMask = 0;
  let bestPenalty = Number.MAX_SAFE_INTEGER;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormatBits(mask);
    const p = penalty();
    if (p < bestPenalty) { bestPenalty = p; bestMask = mask; }
    applyMask(mask);
  }
  applyMask(bestMask);
  drawFormatBits(bestMask);
  return { size, get: (x, y) => x >= 0 && x < size && y >= 0 && y < size && modules[y]![x]! };
}
