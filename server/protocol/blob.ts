import { createDecipheriv, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { RoborockProtocolError } from './codec.js';
import type { JsonValue } from './json.js';
import type { SecurityData } from './mapResponse.js';

/*
 * Photos the robot sends as "ROBOROCK" blob frames, ported from LocalRock's ObstaclePhoto.kt,
 * PatrolPhoto.kt and PatrolCipher.kt (following python-roborock's BlobRpcChannel). get_photo and
 * get_patrol_photo are answered with ["ok"], then the photo arrives as a frame carrying the request id.
 * A large photo starts on protocol 300 with the header and part of the body; headerless protocol-301
 * frames carry the rest.
 */

export const BLOB_FIRST_PART_PROTOCOL = 300;
export const BLOB_PROTOCOL = 301;
const MAGIC = Buffer.from('ROBOROCK', 'ascii');

/** The full 640x480 frame the official obstacle sheet shows. */
export const PHOTO_TYPE_FULL = 0;
/** type of a cruise thumbnail request; the original of one photo is type 0 with its photo id. */
export const PATROL_TYPE_THUMBNAILS = 1;
export const PATROL_TYPE_ORIGINAL = 0;

export const CIPHER_SUITE_PLAIN = 0;
export const CIPHER_SUITE_RSA = 1;
/** The placeholder endpoint the official app puts in cipher_suite 1 params. */
export const OFFICIAL_PARAMS_ENDPOINT = 'xxx';
export const OFFICIAL_HEADER_SIZE = 184;
const WRAPPED_KEY_OFFSET = 56;
const RSA_BLOCK = 128;
const AES_BLOCK = 16;

/** The start of a blob whose body may continue in later frames. */
export interface BlobStart { requestId: number; header: Buffer; bodyLength: number; body: Buffer }

/** Any "ROBOROCK" frame on protocol 300 or 301, complete or not; null for frames without the header. */
export function decodeBlobStart(protocol: number, p: Buffer): BlobStart | null {
  if (protocol !== BLOB_PROTOCOL && protocol !== BLOB_FIRST_PART_PROTOCOL) return null;
  if (p.length < 24 || !p.subarray(0, 8).equals(MAGIC)) return null;
  const headerSize = p.readUInt16LE(16);
  const bodyLength = p.readUInt32LE(20);
  if (headerSize < 24 || headerSize > p.length) throw new RoborockProtocolError('Invalid photo frame');
  const end = Math.min(p.length, headerSize + bodyLength);
  return { requestId: p.readUInt32LE(8), header: Buffer.from(p.subarray(0, headerSize)), bodyLength, body: Buffer.from(p.subarray(headerSize, end)) };
}

// ---- Obstacle photos --------------------------------------------------------------------------

export const getPhotoParams = (publicKey: JsonValue, s: SecurityData, photoId: string, type = PHOTO_TYPE_FULL): JsonValue => ({
  security: { pub_key: publicKey, cipher_suite: 0 },
  endpoint: s.endpoint,
  nonce: s.nonce.toString('hex'),
  data_filter: { img_id: photoId, type },
});

/** Where the robot boxed the obstacle in the photo, in image pixels. */
export interface PhotoBox { left: number; top: number; right: number; bottom: number }

/**
 * The image and box in an unzipped get_photo payload: blocks of u16 type, u16 header size and u32
 * payload size, where block 3 holds the JPEG and block 2 the box (x0, y0, x1, y1).
 */
export function obstaclePhotoFromData(data: Buffer): { image: Buffer; box: PhotoBox | null } {
  let box: PhotoBox | null = null;
  let image: Buffer | null = null;
  let off = 0;
  while (off + 8 <= data.length) {
    const type = data.readUInt16LE(off);
    const headerSize = data.readUInt16LE(off + 2);
    const next = off + headerSize + data.readUInt32LE(off + 4);
    if (headerSize < 8 || next > data.length) break;
    const start = off + headerSize;
    if (type === 2 && next - start >= 8) {
      const b = { left: data.readUInt16LE(start), top: data.readUInt16LE(start + 2), right: data.readUInt16LE(start + 4), bottom: data.readUInt16LE(start + 6) };
      if (b.right > b.left && b.bottom > b.top) box = b;
    }
    if (type === 3 && !image) image = Buffer.from(data.subarray(start, next));
    off = next;
  }
  if (!image) throw new RoborockProtocolError('Photo payload has no image');
  if (!imageMime(image)) throw new RoborockProtocolError('Photo payload is not an image');
  return { image, box };
}

export function imageMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// ---- Cruise photos ----------------------------------------------------------------------------

/** get_patrol_photo {task_id, x, y, type, endpoint, security}, as the official app asks (captured 2026-11-13). */
export function getPatrolPhotoParams(
  publicKey: JsonValue, s: SecurityData, taskId: number, x: number, y: number,
  photoId: string | null, type: number, cipherSuite = CIPHER_SUITE_PLAIN, endpoint = s.endpoint,
): JsonValue {
  const out: Record<string, JsonValue> = {};
  if (taskId !== 0) out['task_id'] = taskId;
  if (x !== 0) out['x'] = x;
  if (y !== 0) out['y'] = y;
  // The official app pads a photo id with NULs to 32 characters.
  if (photoId) out['photo_id'] = photoId.padEnd(32, '\0');
  out['type'] = type;
  out['endpoint'] = endpoint;
  out['security'] = { pub_key: publicKey, cipher_suite: cipherSuite };
  return out;
}

export interface PatrolThumbnail { x: number; y: number; width: number; height: number; angle: number; png: Buffer }

/**
 * The thumbnails in an unzipped get_patrol_photo payload: after a 12-byte lead, records of u16 header
 * size, u16 x, y, width, height and angle, a u32 image length at 12, and the PNG at the header size.
 */
export function parsePatrolThumbnails(data: Buffer): PatrolThumbnail[] {
  const out: PatrolThumbnail[] = [];
  let off = 12;
  while (off < data.length - 15) {
    const headerSize = data.readUInt16LE(off);
    const length = data.readUInt32LE(off + 12);
    const start = off + headerSize;
    const end = start + length;
    if (headerSize < 16 || end > data.length) throw new RoborockProtocolError('Invalid patrol photo record');
    out.push({
      x: data.readUInt16LE(off + 2), y: data.readUInt16LE(off + 4), width: data.readUInt16LE(off + 6),
      height: data.readUInt16LE(off + 8), angle: data.readUInt16LE(off + 10), png: Buffer.from(data.subarray(start, end)),
    });
    off = end;
  }
  return out;
}

// ---- cipher_suite 1 ---------------------------------------------------------------------------

/**
 * The official app's cipher_suite 1: the request carries an RSA-1024 public key; the robot answers with a
 * 184-byte header whose bytes 56-184 are iv||AES key wrapped to that key (RSA PKCS#1 v1.5), followed by the
 * AES-CBC encrypted gzip.
 */
export interface RsaKeys { n: bigint; d: bigint; publicJson: JsonValue }

export function generateRsaKeys(): RsaKeys {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 0x10001 });
  const jwk = (privateKey as KeyObject).export({ format: 'jwk' });
  const big = (b64u: string) => BigInt(`0x${Buffer.from(b64u, 'base64url').toString('hex')}`);
  const nHex = Buffer.from(jwk.n!, 'base64url').toString('hex').replace(/^(00)+/, '');
  return { n: big(jwk.n!), d: big(jwk.d!), publicJson: { e: '10001', n: nHex } };
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** RSA PKCS#1 v1.5 decryption of one 128-byte block, done by hand: Node refuses this padding for private decryption. */
export function rsaPkcs1Decrypt(block: Buffer, keys: RsaKeys): Buffer {
  const m = modPow(BigInt(`0x${block.toString('hex')}`), keys.d, keys.n);
  const em = Buffer.from(m.toString(16).padStart(RSA_BLOCK * 2, '0'), 'hex');
  if (em[0] !== 0 || em[1] !== 2) throw new Error('Bad PKCS#1 padding');
  const sep = em.indexOf(0, 2);
  if (sep < 10) throw new Error('Bad PKCS#1 padding');
  return em.subarray(sep + 1);
}

function stripPkcs7(d: Buffer): Buffer {
  const pad = d[d.length - 1];
  if (pad === undefined || pad < 1 || pad > AES_BLOCK || pad > d.length) return d;
  for (let i = d.length - pad; i < d.length; i++) if (d[i] !== pad) return d;
  return d.subarray(0, d.length - pad);
}

function decryptWrapped(wrapped: Buffer, body: Buffer, keys: RsaKeys): Buffer {
  let material: Buffer;
  try { material = rsaPkcs1Decrypt(wrapped, keys); } catch { throw new Error("The photo's key wasn't wrapped for this app's key"); }
  if (material.length !== 2 * AES_BLOCK) throw new Error(`Unexpected photo key length ${material.length}`);
  if (body.length === 0 || body.length % AES_BLOCK !== 0) throw new Error("The photo data isn't a whole number of AES blocks");
  const d = createDecipheriv('aes-128-cbc', material.subarray(AES_BLOCK), material.subarray(0, AES_BLOCK));
  d.setAutoPadding(false);
  return gunzipSync(stripPkcs7(Buffer.concat([d.update(body), d.final()])));
}

/** Decrypts a cipher_suite 1 reply to the unzipped photo data. */
export function decryptOfficialBody(header: Buffer, body: Buffer, keys: RsaKeys): Buffer {
  if (header.length < WRAPPED_KEY_OFFSET + RSA_BLOCK) throw new Error('The photo reply header is too short');
  return decryptWrapped(header.subarray(WRAPPED_KEY_OFFSET, WRAPPED_KEY_OFFSET + RSA_BLOCK), body, keys);
}

/**
 * A reply with no "ROBOROCK" header, as the robot sent for original photos in the capture: the layouts
 * that fit its size are tried in turn; each is accepted only if the key unwraps and the result unzips.
 */
export function decryptHeaderlessBody(payload: Buffer, keys: RsaKeys): Buffer | null {
  if (payload.length < OFFICIAL_HEADER_SIZE + AES_BLOCK || (payload.length - OFFICIAL_HEADER_SIZE) % AES_BLOCK !== 0) return null;
  const tail = payload.length - RSA_BLOCK;
  for (const [keyAt, bodyStart, bodyEnd] of [[WRAPPED_KEY_OFFSET, OFFICIAL_HEADER_SIZE, payload.length], [tail, 8, tail], [tail, 0, tail - 8]] as const) {
    if (keyAt + RSA_BLOCK > payload.length) continue;
    try { return decryptWrapped(payload.subarray(keyAt, keyAt + RSA_BLOCK), payload.subarray(bodyStart, bodyEnd), keys); } catch { /* next layout */ }
  }
  return null;
}

export const gunzip = (b: Buffer) => gunzipSync(b);
