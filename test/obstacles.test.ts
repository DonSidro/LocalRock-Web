import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { confidencePercent, obstacleType, parseObstacles, parsePatrolPoints } from '../shared/obstacles.js';
import {
  decodeBlobStart, decryptHeaderlessBody, decryptOfficialBody, generateRsaKeys, getPatrolPhotoParams, obstaclePhotoFromData,
  parsePatrolThumbnails, rsaPkcs1Decrypt,
} from '../server/protocol/blob.js';

/* Cases after LocalRock's MapObstaclesTest, ObstaclePhotoTest, PatrolPhotoTest and PatrolCipherTest. */

describe('obstacles', () => {
  it('reads 28-byte records with a photo id, and names the type', () => {
    const b = Buffer.alloc(56);
    b.writeUInt16LE(25200, 0); b.writeUInt16LE(24800, 2); b.writeUInt16LE(2, 4); b.writeUInt16LE(8505, 6); b.writeUInt16LE(1001, 8); b.write('OBS1', 12, 'ascii');
    b.writeUInt16LE(100, 28); b.writeUInt16LE(200, 30); b.writeUInt16LE(99, 32);
    const [a, c] = parseObstacles(b, 0, 2, 56, false);
    expect(a).toMatchObject({ x: 25200, y: 24800, type: 2, photoId: 'OBS1', ignored: false });
    expect(confidencePercent(a!)).toBe(84);
    expect(c!.photoId).toBeNull();
    expect(obstacleType(2).name).toBe('Footwear');
    expect(obstacleType(99).name).toBe('Obstacle');
    expect(parseObstacles(Buffer.alloc(8), 0, 2, 8, false).length).toBe(2);
    expect(parseObstacles(Buffer.alloc(4), 0, 0, 4, false)).toEqual([]);
  });

  it('reads cruise points with their photo ids', () => {
    const b = Buffer.alloc(70);
    b.writeUInt16LE(1000, 0); b.writeUInt16LE(2000, 2); b[4] = 1; b[5] = 2; b.write('PH1', 6, 'ascii'); b.write('PH2', 38, 'ascii');
    expect(parsePatrolPoints(b, 0, 1, 70)).toEqual([{ x: 1000, y: 2000, result: 1, photoIds: ['PH1', 'PH2'] }]);
  });
});

describe('photo frames', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const block = (type: number, data: Buffer) => { const h = Buffer.alloc(8); h.writeUInt16LE(type, 0); h.writeUInt16LE(8, 2); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data]); };

  it('finds the image and the box in a get_photo payload', () => {
    const box = Buffer.alloc(8); [10, 20, 30, 40].forEach((v, i) => box.writeUInt16LE(v, i * 2));
    const out = obstaclePhotoFromData(Buffer.concat([block(2, box), block(3, jpeg)]));
    expect(out.image.equals(jpeg)).toBe(true);
    expect(out.box).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
    expect(() => obstaclePhotoFromData(block(1, box))).toThrow();
  });

  it('reads a blob header, and tells a split start from a whole frame', () => {
    const body = Buffer.alloc(100, 7);
    const h = Buffer.alloc(24); h.write('ROBOROCK', 0, 'ascii'); h.writeUInt32LE(4242, 8); h.writeUInt16LE(24, 16); h.writeUInt32LE(100, 20);
    const part = decodeBlobStart(300, Buffer.concat([h, body.subarray(0, 40)]))!;
    expect(part.requestId).toBe(4242);
    expect(part.body.length).toBe(40);
    expect(part.bodyLength).toBe(100);
    expect(decodeBlobStart(301, Buffer.concat([h, body]))!.body.length).toBe(100);
    expect(decodeBlobStart(102, Buffer.concat([h, body]))).toBeNull();
    expect(decodeBlobStart(301, Buffer.alloc(40))).toBeNull();
  });

  it('reads cruise thumbnails and builds the official request', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const rec = Buffer.alloc(16); rec.writeUInt16LE(16, 0); rec.writeUInt16LE(5, 2); rec.writeUInt16LE(6, 4); rec.writeUInt16LE(64, 6); rec.writeUInt16LE(48, 8); rec.writeUInt16LE(90, 10); rec.writeUInt32LE(png.length, 12);
    const thumbs = parsePatrolThumbnails(Buffer.concat([Buffer.alloc(12), rec, png]));
    expect(thumbs.length).toBe(1);
    expect(thumbs[0]).toMatchObject({ x: 5, y: 6, width: 64, height: 48, angle: 90 });
    const sec = { endpoint: 'abcdefgh', nonce: Buffer.alloc(16) };
    const p = getPatrolPhotoParams({ n: 'aa' }, sec, 77, 1, 2, 'PH1', 0, 1, 'xxx') as Record<string, unknown>;
    expect(p).toMatchObject({ task_id: 77, x: 1, y: 2, type: 0, endpoint: 'xxx', security: { pub_key: { n: 'aa' }, cipher_suite: 1 } });
    expect((p['photo_id'] as string).length).toBe(32);
  });
});

describe('cipher_suite 1', () => {
  const keys = generateRsaKeys();
  const pub = keys.publicJson as { n: string; e: string };
  const rsa = createPublicKey({ key: { kty: 'RSA', n: Buffer.from(pub.n.length % 2 ? `0${pub.n}` : pub.n, 'hex').toString('base64url'), e: 'AQAB' }, format: 'jwk' });

  it('unwraps a PKCS#1 v1.5 block made with our public key', () => {
    const secret = randomBytes(32);
    expect(rsaPkcs1Decrypt(publicEncrypt({ key: rsa, padding: constants.RSA_PKCS1_PADDING }, secret), keys).equals(secret)).toBe(true);
  });

  it('decrypts a headered and a headerless reply', () => {
    const plain = Buffer.from('cruise photo data');
    const iv = randomBytes(16), key = randomBytes(16);
    const c = createCipheriv('aes-128-cbc', key, iv);
    const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
    const wrapped = publicEncrypt({ key: rsa, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([iv, key]));
    const header = Buffer.alloc(184); wrapped.copy(header, 56);
    expect(decryptOfficialBody(header, body, keys).equals(plain)).toBe(true);
    expect(decryptHeaderlessBody(Buffer.concat([header, body]), keys)!.equals(plain)).toBe(true);
    expect(decryptHeaderlessBody(Buffer.alloc(184 + 16), keys)).toBeNull();
  });
});
