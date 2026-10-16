import { aesEcbDecrypt, aesEcbEncrypt, md5 } from './crypto.js';
import { crc32 } from './crc32.js';

/*
 * Roborock V1 ("1.0") message frames, ported from LocalRock's RoborockCodec.kt and Token.kt and
 * checked against the same python-roborock golden vectors (test/protocol.test.ts).
 *
 * Frame: "1.0" | seq u32 | random u32 | timestamp u32 | protocol u16 | payloadLen u16 | payload | crc32
 * The payload is AES-128-ECB encrypted with md5(encodeTimestamp(ts) + localKey + SALT).
 */

export class RoborockProtocolError extends Error {}

export interface RoborockMessage {
  protocol: number;
  payload: Buffer;
  seq: number;
  random: number;
  timestamp: number;
  version?: string;
}

export const Protocol = {
  HELLO_REQUEST: 0,
  HELLO_RESPONSE: 1,
  PING_REQUEST: 2,
  PING_RESPONSE: 3,
  GENERAL_REQUEST: 4,
  GENERAL_RESPONSE: 5,
  RPC_REQUEST: 101,
  RPC_RESPONSE: 102,
  MAP_RESPONSE: 301,
} as const;

/** b"TXdfu$jyZ#TZHsg4" */
export const SALT = Buffer.from('TXdfu$jyZ#TZHsg4', 'latin1');

export function encodeTimestamp(timestamp: number): Buffer {
  const hex = (timestamp >>> 0).toString(16).padStart(8, '0');
  const perm = [5, 6, 3, 7, 1, 2, 0, 4];
  return Buffer.from(perm.map((i) => hex[i]).join(''), 'latin1');
}

export function deriveToken(localKey: string, timestamp: number): Buffer {
  return md5(Buffer.concat([encodeTimestamp(timestamp), Buffer.from(localKey, 'utf8'), SALT]));
}

const HEADER_LEN = 3 + 4 + 4 + 4 + 2 + 2;

export function encodeMessage(localKey: string, message: RoborockMessage, prefixed = false): Buffer {
  const version = message.version ?? '1.0';
  if (version !== '1.0') throw new Error(`Only version 1.0 is implemented (got ${version})`);
  const token = deriveToken(localKey, message.timestamp);
  const encrypted = message.payload.length === 0 ? Buffer.alloc(0) : aesEcbEncrypt(message.payload, token);
  if (encrypted.length > 0xffff) throw new RoborockProtocolError('Payload too large for one frame');
  const bodyLen = HEADER_LEN + encrypted.length;
  const totalLen = bodyLen + 4;
  const frame = Buffer.alloc(prefixed ? 4 + totalLen : totalLen);
  let off = 0;
  if (prefixed) {
    frame.writeUInt32BE(totalLen, 0);
    off = 4;
  }
  const bodyStart = off;
  frame.write('1.0', off, 'latin1'); off += 3;
  frame.writeUInt32BE(message.seq >>> 0, off); off += 4;
  frame.writeUInt32BE(message.random >>> 0, off); off += 4;
  frame.writeUInt32BE(message.timestamp >>> 0, off); off += 4;
  frame.writeUInt16BE(message.protocol & 0xffff, off); off += 2;
  frame.writeUInt16BE(encrypted.length, off); off += 2;
  encrypted.copy(frame, off); off += encrypted.length;
  frame.writeUInt32BE(crc32(frame, bodyStart, bodyLen), off);
  return frame;
}

/**
 * Decode every complete frame in `data`. MQTT messages carry one frame each and no length prefix;
 * leading bytes before a version header are skipped, as python-roborock does.
 */
export function decodeMessages(localKey: string, data: Buffer, prefixed = false): RoborockMessage[] {
  const out: RoborockMessage[] = [];
  let buf = data;
  for (;;) {
    const parsed = tryParseOne(localKey, buf, prefixed);
    if (!parsed) break;
    out.push(parsed.message);
    buf = parsed.remaining;
  }
  return out;
}

function tryParseOne(localKey: string, data: Buffer, prefixed: boolean): { message: RoborockMessage; remaining: Buffer } | null {
  if (prefixed) {
    if (data.length < 4) return null;
    const payloadAndCrcLen = data.readUInt32BE(0);
    if (payloadAndCrcLen < 23 || payloadAndCrcLen > 16 * 1024 * 1024) {
      throw new RoborockProtocolError(`Implausible message length: ${payloadAndCrcLen}`);
    }
    if (data.length < 4 + payloadAndCrcLen) return null;
    const message = parseMessage(localKey, data, 4, payloadAndCrcLen - 4);
    return { message, remaining: data.subarray(4 + payloadAndCrcLen) };
  }
  const start = findVersionHeader(data);
  if (start === null) return null;
  if (data.length - start < 19) return null;
  const payloadLen = data.readUInt16BE(start + 17);
  const bodyLen = 19 + payloadLen;
  if (data.length - start < bodyLen + 4) return null;
  const message = parseMessage(localKey, data, start, bodyLen);
  return { message, remaining: data.subarray(start + bodyLen + 4) };
}

function parseMessage(localKey: string, data: Buffer, off: number, bodyLen: number): RoborockMessage {
  const version = data.toString('latin1', off, off + 3);
  if (version !== '1.0') throw new RoborockProtocolError(`Only version 1.0 is supported (got '${version}')`);
  const seq = data.readUInt32BE(off + 3);
  const random = data.readUInt32BE(off + 7);
  const timestamp = data.readUInt32BE(off + 11);
  const protocol = data.readUInt16BE(off + 15);
  const payloadLen = data.readUInt16BE(off + 17);
  if (payloadLen !== bodyLen - 19) throw new RoborockProtocolError('Inconsistent payload length');
  const expectedCrc = data.readUInt32BE(off + bodyLen);
  if (expectedCrc !== crc32(data, off, bodyLen)) throw new RoborockProtocolError('CRC32 mismatch');
  const ct = data.subarray(off + 19, off + 19 + payloadLen);
  let payload: Buffer;
  try {
    payload = ct.length === 0 ? Buffer.alloc(0) : aesEcbDecrypt(Buffer.from(ct), deriveToken(localKey, timestamp));
  } catch (e) {
    throw new RoborockProtocolError(`Payload decrypt failed (wrong local key?): ${(e as Error).message}`);
  }
  return { protocol, payload, seq, random, timestamp, version };
}

function findVersionHeader(data: Buffer): number | null {
  for (let i = 0; i <= data.length - 3; i++) {
    const v0 = data[i]!, v1 = data[i + 1]!, v2 = data[i + 2]!;
    // "1.0" = 31 2e 30 ; "A01" / "B01" / "L01" = 41|42|4c 30 31
    if (v0 === 0x31 && v1 === 0x2e && v2 === 0x30) return i;
    if ((v0 === 0x41 || v0 === 0x42 || v0 === 0x4c) && v1 === 0x30 && v2 === 0x31) return i;
  }
  return null;
}
