import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/** AES-128-ECB with PKCS#7 padding. An empty input stays empty, as in the app. */
export function aesEcbEncrypt(plaintext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
  if (plaintext.length === 0) return Buffer.alloc(0);
  const c = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

export function aesEcbDecrypt(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
  if (ciphertext.length === 0) return Buffer.alloc(0);
  if (ciphertext.length % 16 !== 0) throw new Error('AES-ECB ciphertext must be a multiple of 16 bytes');
  const d = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

/** AES-128-CBC with PKCS#7 padding. */
export function aesCbcEncrypt(plaintext: Buffer, key: Buffer, iv: Buffer): Buffer {
  const c = createCipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([c.update(plaintext), c.final()]);
}

export function aesCbcDecrypt(ciphertext: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (ciphertext.length % 16 !== 0) throw new Error('AES-CBC ciphertext must be a multiple of 16 bytes');
  const d = createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(ciphertext), d.final()]);
}

export function md5(data: Buffer | string): Buffer {
  return createHash('md5').update(data).digest();
}

export function md5Hex(data: Buffer | string): string {
  return createHash('md5').update(data).digest('hex');
}

export function hmacSha256(key: Buffer | string, data: Buffer | string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export { randomBytes };
