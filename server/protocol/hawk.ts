import { hmacSha256, md5Hex, randomHex } from './crypto.js';

/*
 * Hawk request signing as local_roborock_server verifies it (ported from LocalRock's Hawk.kt and
 * HawkAuthPlugin.kt, checked against the same reference vectors).
 *
 * mac = base64(HMAC-SHA256(rriot.h, "u:s:nonce:ts:md5(path):md5(query):md5(form)"))
 * where query and form are the sorted, unencoded k=v pairs joined with '&' (empty when absent).
 */

export interface HawkCreds {
  /** rriot.u */
  id: string;
  /** rriot.s */
  session: string;
  /** rriot.h */
  key: string;
}

export function formEncodeForHash(pairs: Record<string, string>): string {
  return Object.keys(pairs)
    .sort()
    .map((k) => `${k}=${pairs[k]}`)
    .join('&');
}

export function hawkMac(
  creds: HawkCreds,
  path: string,
  ts: number,
  nonce: string,
  query: Record<string, string> = {},
  form: Record<string, string> | null = null,
): string {
  const pathHash = md5Hex(Buffer.from(path, 'utf8'));
  const queryHash = Object.keys(query).length === 0 ? '' : md5Hex(Buffer.from(formEncodeForHash(query), 'utf8'));
  const bodyHash = form === null ? '' : md5Hex(Buffer.from(formEncodeForHash(form), 'utf8'));
  const prestr = `${creds.id}:${creds.session}:${nonce}:${ts}:${pathHash}:${queryHash}:${bodyHash}`;
  return hmacSha256(Buffer.from(creds.key, 'utf8'), Buffer.from(prestr, 'utf8')).toString('base64');
}

export function hawkAuthorizationHeader(
  creds: HawkCreds,
  path: string,
  ts: number,
  nonce: string,
  query: Record<string, string> = {},
  form: Record<string, string> | null = null,
): string {
  const mac = hawkMac(creds, path, ts, nonce, query, form);
  return `Hawk id="${creds.id}",s="${creds.session}",ts="${ts}",nonce="${nonce}",mac="${mac}"`;
}

export function newHawkNonce(): string {
  return randomHex(8);
}

const PUBLIC_EXACT_PATHS = new Set(['/nc/prepare', '/region', '/time', '/location']);

/** Paths the server serves without Hawk: everything under /api/ and a few onboarding paths. */
export function isHawkPublicPath(path: string): boolean {
  const p = path.replace(/\/+$/, '');
  return PUBLIC_EXACT_PATHS.has(p) || p.startsWith('/api/');
}
