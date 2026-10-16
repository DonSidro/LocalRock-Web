import { gunzipSync } from 'node:zlib';
import { RoborockProtocolError, type RoborockMessage } from './codec.js';
import { aesCbcDecrypt, md5, randomBytes } from './crypto.js';

/*
 * get_map_v1 security data and the map reply, ported from LocalRock's SecurityData.kt and
 * MapResponseDecoder.kt. The robot answers on protocol 301 with an 8-character endpoint, the
 * request id (u16 LE at 16) and AES-128-CBC(nonce, zero IV) of the gzipped map from byte 24.
 */

export interface SecurityData {
  endpoint: string;
  nonce: Buffer;
}

export function createSecurityData(rriotKey: string): SecurityData {
  const digest = md5(Buffer.from(rriotKey, 'utf8'));
  return { endpoint: digest.subarray(8, 14).toString('base64'), nonce: randomBytes(16) };
}

export interface MapResponse {
  requestId: number;
  data: Buffer;
}

/** The map, or null when the message is not for this endpoint. Throws on a malformed reply. */
export function decodeMapResponse(message: RoborockMessage, security: SecurityData): MapResponse | null {
  const payload = message.payload;
  if (payload.length < 24) throw new RoborockProtocolError(`Map response payload too short: ${payload.length}`);
  const endpoint = payload.toString('utf8', 0, 8);
  if (!endpoint.startsWith(security.endpoint)) return null;
  const requestId = payload[16]! | (payload[17]! << 8);
  const body = payload.subarray(24);
  const decrypted = aesCbcDecrypt(Buffer.from(body), security.nonce, Buffer.alloc(16));
  return { requestId, data: gunzipSync(decrypted) };
}
