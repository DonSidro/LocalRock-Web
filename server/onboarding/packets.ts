import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { aesEcbEncrypt } from '../protocol/crypto.js';
import { crc32 } from '../protocol/crc32.js';

/*
 * Wi-Fi pairing packets (UDP to the robot's hotspot), ported from LocalRock's CfgWifiFrame.kt,
 * OnboardingPackets.kt, HelloResponse.kt, TzMapping.kt and Rsa.android.kt, and checked against the
 * same python-generated vectors.
 *
 * Frame: "1.0" | 00 00 00 01 | cmd u16 | len u16 | payload | crc32 (all big-endian).
 */

export const CFG_WIFI_PRE_KEY = '6433df70f5a3a42e';
export const CFG_WIFI_UID = '1234567890';
export const CMD_HELLO = 16;
export const CMD_WIFI_CONFIG = 1;
export const VACUUM_PAIRING_HOST = '192.168.8.1';
export const VACUUM_PAIRING_PORT = 55559;

const HEADER_SIZE = 11;

export function buildFrame(commandId: number, payload: Buffer): Buffer {
  if (commandId < 0 || commandId > 0xffff) throw new Error(`command id out of range: ${commandId}`);
  if (payload.length > 0xffff) throw new Error(`payload too large: ${payload.length}`);
  const out = Buffer.alloc(HEADER_SIZE + payload.length + 4);
  out.write('1.0', 0, 'latin1');
  out.writeUInt32BE(1, 3);
  out.writeUInt16BE(commandId, 7);
  out.writeUInt16BE(payload.length, 9);
  payload.copy(out, HEADER_SIZE);
  out.writeUInt32BE(crc32(out, 0, HEADER_SIZE + payload.length), out.length - 4);
  return out;
}

export function parseFrame(packet: Buffer): { commandId: number; payload: Buffer } {
  if (packet.length < HEADER_SIZE + 4) throw new Error(`frame too short: ${packet.length}`);
  if (packet.toString('latin1', 0, 3) !== '1.0') throw new Error('bad magic');
  if (packet.readUInt32BE(3) !== 1) throw new Error('unexpected version bytes');
  const commandId = packet.readUInt16BE(7);
  const len = packet.readUInt16BE(9);
  if (HEADER_SIZE + len + 4 !== packet.length) throw new Error(`payload length mismatch: header says ${len}, packet=${packet.length}`);
  if (crc32(packet, 0, HEADER_SIZE + len) !== packet.readUInt32BE(packet.length - 4)) throw new Error('CRC32 mismatch');
  return { commandId, payload: packet.subarray(HEADER_SIZE, HEADER_SIZE + len) };
}

/** RSA-1024 key pair for the hello exchange. PKCS#1 v1.5 decryption is done here with BigInt. */
export class RsaKeyPair {
  private readonly n: bigint;
  private readonly d: bigint;
  private readonly blockSize: number;
  readonly publicKeyPem: string;

  constructor(privateKey: KeyObject) {
    const jwk = privateKey.export({ format: 'jwk' });
    if (!jwk.n || !jwk.d) throw new Error('Not an RSA private key');
    const nBytes = Buffer.from(jwk.n, 'base64url');
    this.n = BigInt(`0x${nBytes.toString('hex')}`);
    this.d = BigInt(`0x${Buffer.from(jwk.d, 'base64url').toString('hex')}`);
    this.blockSize = Math.ceil(this.n.toString(2).length / 8);
    const pem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    this.publicKeyPem = pem.replace(/\r/g, '').trimEnd();
  }

  static generate(): RsaKeyPair {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 65537 });
    return new RsaKeyPair(privateKey);
  }

  static fromPem(pem: string): RsaKeyPair {
    return new RsaKeyPair(createPrivateKey(pem));
  }

  decryptPkcs1V15Blocks(ciphertext: Buffer): Buffer {
    if (ciphertext.length % this.blockSize !== 0) {
      throw new Error(`ciphertext size ${ciphertext.length} is not a multiple of block size ${this.blockSize}`);
    }
    const out: Buffer[] = [];
    for (let off = 0; off < ciphertext.length; off += this.blockSize) {
      out.push(this.decryptBlock(ciphertext.subarray(off, off + this.blockSize), off / this.blockSize));
    }
    return Buffer.concat(out);
  }

  private decryptBlock(block: Buffer, index: number): Buffer {
    const c = BigInt(`0x${block.toString('hex')}`);
    if (c >= this.n) throw new Error(`RSA block ${index} is out of range`);
    const m = modPow(c, this.d, this.n);
    const em = Buffer.from(m.toString(16).padStart(this.blockSize * 2, '0'), 'hex');
    // EM = 00 || 02 || PS (>= 8 non-zero bytes) || 00 || M
    if (em[0] !== 0x00 || em[1] !== 0x02) throw new Error(`RSA PKCS#1 v1.5 decrypt failed at block ${index}`);
    const sep = em.indexOf(0x00, 2);
    if (sep < 10) throw new Error(`RSA PKCS#1 v1.5 decrypt failed at block ${index}`);
    return em.subarray(sep + 1);
  }
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

export function buildHelloPacket(publicKeyPem: string, preKey = CFG_WIFI_PRE_KEY): Buffer {
  const body = JSON.stringify({ id: 1, method: 'hello', params: { app_ver: 1, key: publicKeyPem } });
  return buildFrame(CMD_HELLO, aesEcbEncrypt(Buffer.from(body, 'utf8'), Buffer.from(preKey, 'latin1')));
}

export interface WifiConfigBody {
  ssid: string;
  password: string;
  /** Server host the vacuum phones home to, host only with a trailing '/'. */
  serverStack: string;
  timezone: string;
  posixTz: string;
  countryDomain: string;
  tokenS: string;
  tokenT: string;
  uid?: string;
}

export function buildWifiConfigPacket(sessionKey: string, body: WifiConfigBody): Buffer {
  if (sessionKey.length !== 16) throw new Error('session key must be 16 ASCII chars');
  const json = JSON.stringify({
    u: body.uid ?? CFG_WIFI_UID,
    ssid: body.ssid,
    token: { r: body.serverStack, tz: body.timezone, s: body.tokenS, cst: body.posixTz, t: body.tokenT },
    passwd: body.password,
    country_domain: body.countryDomain,
  });
  return buildFrame(CMD_WIFI_CONFIG, aesEcbEncrypt(Buffer.from(json, 'utf8'), Buffer.from(sessionKey, 'latin1')));
}

/** The 16-character session key from the robot's hello reply. */
export function parseHelloResponse(packet: Buffer, keyPair: RsaKeyPair): string {
  const frame = parseFrame(packet);
  const plaintext = keyPair.decryptPkcs1V15Blocks(frame.payload).toString('utf8');
  let outer: unknown;
  try {
    outer = JSON.parse(plaintext);
  } catch (e) {
    throw new Error(`hello response is not valid JSON: ${(e as Error).message}`);
  }
  const params = (outer as { params?: { key?: unknown } }).params;
  if (!params) throw new Error("hello response missing 'params'");
  const key = params.key;
  if (typeof key !== 'string') throw new Error("hello response missing 'params.key'");
  if (key.length !== 16) throw new Error(`hello response session key is ${key.length} chars (expected 16)`);
  return key;
}

const IANA_TO_POSIX: Record<string, string> = {
  'America/New_York': 'EST5EDT,M3.2.0,M11.1.0',
  'America/Chicago': 'CST6CDT,M3.2.0,M11.1.0',
  'America/Denver': 'MST7MDT,M3.2.0,M11.1.0',
  'America/Los_Angeles': 'PST8PDT,M3.2.0,M11.1.0',
  'America/Phoenix': 'MST7',
  'America/Anchorage': 'AKST9AKDT,M3.2.0,M11.1.0',
  'Pacific/Honolulu': 'HST10',
  'America/Toronto': 'EST5EDT,M3.2.0,M11.1.0',
  'America/Vancouver': 'PST8PDT,M3.2.0,M11.1.0',
  'America/Winnipeg': 'CST6CDT,M3.2.0,M11.1.0',
  'America/Edmonton': 'MST7MDT,M3.2.0,M11.1.0',
  'Europe/London': 'GMT0BST,M3.5.0/1,M10.5.0',
  'Europe/Berlin': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Paris': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Europe/Amsterdam': 'CET-1CEST,M3.5.0,M10.5.0/3',
  'Asia/Shanghai': 'CST-8',
  'Asia/Tokyo': 'JST-9',
  'Asia/Kolkata': 'IST-5:30',
  'Australia/Sydney': 'AEST-10AEDT,M10.1.0,M4.1.0/3',
  'Australia/Melbourne': 'AEST-10AEDT,M10.1.0,M4.1.0/3',
  'Australia/Perth': 'AWST-8',
};

const IANA_TO_COUNTRY: Record<string, string> = {
  'America/New_York': 'us', 'America/Chicago': 'us', 'America/Denver': 'us', 'America/Los_Angeles': 'us',
  'America/Phoenix': 'us', 'America/Anchorage': 'us', 'Pacific/Honolulu': 'us', 'America/Toronto': 'us',
  'America/Vancouver': 'us', 'America/Winnipeg': 'us', 'America/Edmonton': 'us', 'Europe/London': 'gb',
  'Europe/Berlin': 'de', 'Europe/Paris': 'fr', 'Europe/Amsterdam': 'nl', 'Asia/Shanghai': 'cn',
  'Asia/Tokyo': 'jp', 'Asia/Kolkata': 'in', 'Australia/Sydney': 'au', 'Australia/Melbourne': 'au', 'Australia/Perth': 'au',
};

export const DEFAULT_IANA_TZ = 'America/New_York';
export const SUPPORTED_TIMEZONES = Object.keys(IANA_TO_POSIX);
export const posixTzFromIana = (iana: string) => IANA_TO_POSIX[iana.trim()] ?? 'EST5EDT,M3.2.0,M11.1.0';
export const countryDomainFromIana = (iana: string) => IANA_TO_COUNTRY[iana.trim()] ?? 'us';

/** Host of the server address with a trailing '/', minus a leading "api-". */
export function sanitizeStackServer(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('Server URL is required');
  const afterScheme = trimmed.includes('://') ? trimmed.substring(trimmed.indexOf('://') + 3) : trimmed;
  let host = afterScheme.split('/')[0]!.split('?')[0]!.split('#')[0]!;
  if (!host) throw new Error(`Server URL has no host: ${baseUrl}`);
  if (host.toLowerCase().startsWith('api-')) host = host.substring(4);
  return `${host}/`;
}
