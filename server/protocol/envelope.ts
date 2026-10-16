import { RoborockProtocolError } from './codec.js';
import { writeJson, type JsonValue } from './json.js';

/*
 * The JSON-RPC envelope inside an RPC frame, ported from LocalRock's V1Envelope.kt:
 * request  {"dps":{"101":"{\"id\":1,\"method\":\"get_status\",\"params\":[]}"},"t":1710465536}
 * response {"dps":{"102":"{\"id\":1,\"result\":[...]}"}}
 */

export const DPS_REQUEST = '101';
export const DPS_RESPONSE = '102';

export interface V1Response {
  id: number | null;
  result: unknown;
  error: Record<string, unknown> | null;
}

export function encodeRequest(
  requestId: number,
  method: string,
  params: JsonValue,
  timestamp: number,
  extraInner: Record<string, JsonValue> = {},
): Buffer {
  const inner: Record<string, JsonValue> = { id: requestId, method, params, ...extraInner };
  const innerString = writeJson(inner);
  return Buffer.from(writeJson({ dps: { [DPS_REQUEST]: innerString }, t: timestamp }), 'utf8');
}

export function decodeResponse(payload: Buffer): V1Response {
  const outer = JSON.parse(payload.toString('utf8')) as unknown;
  if (!isObject(outer)) throw new RoborockProtocolError("V1 response is not an object");
  const dps = outer['dps'];
  if (!isObject(dps)) throw new RoborockProtocolError("V1 response missing 'dps'");
  // Prefer "102" (RPC_RESPONSE); fall back to any single key for unsolicited dps pushes.
  const innerString = dps[DPS_RESPONSE] ?? Object.values(dps)[0];
  if (typeof innerString !== 'string') throw new RoborockProtocolError('V1 response missing inner string');
  const inner = JSON.parse(innerString) as unknown;
  if (!isObject(inner)) throw new RoborockProtocolError('V1 inner response is not an object');
  const error = isObject(inner['error']) ? (inner['error'] as Record<string, unknown>) : null;
  return { id: asInt(inner['id']), result: inner['result'] ?? null, error };
}

/** Unsolicited status values keyed by dps code, or null when the payload has none. */
export function decodeDpsPush(payload: Buffer): Map<number, unknown> | null {
  let outer: unknown;
  try {
    outer = JSON.parse(payload.toString('utf8'));
  } catch {
    return null;
  }
  if (!isObject(outer) || !isObject(outer['dps'])) return null;
  const out = new Map<number, unknown>();
  for (const [k, v] of Object.entries(outer['dps'] as Record<string, unknown>)) {
    if (!/^-?\d+$/.test(k)) continue;
    out.set(Number(k), v);
  }
  return out.size > 0 ? out : null;
}

/** The robot's "still working" reply to a command sent with need_retry: result ["retry"], no error. */
export function isProvisionalRetry(r: V1Response): boolean {
  return r.error === null && Array.isArray(r.result) && r.result.length === 1 && r.result[0] === 'retry';
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An int from a JSON number or numeric string, like kotlinx's intOrNull. */
export function asInt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

export function errorCode(error: Record<string, unknown> | null | undefined): number | null {
  return error ? asInt(error['code']) : null;
}
