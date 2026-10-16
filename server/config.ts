import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Runtime configuration, from environment variables. */

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

const host = env('HOST') ?? '127.0.0.1';
const port = Number(env('PORT') ?? '8080');
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`Invalid PORT: ${env('PORT')}`);

const caFile = env('LOCALROCK_CA_FILE');

/** The project folder (where package.json is), whether running from source or from dist/. */
function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const root = projectRoot();

export const config = {
  host,
  port,
  /** Password for the web page itself. Required when HOST is not a loopback address. */
  password: env('LOCALROCK_PASSWORD') ?? null,
  /** Allow serving on the network without a password (not recommended). */
  insecureLan: env('LOCALROCK_INSECURE_LAN') === '1',
  dataDir: resolve(root, env('LOCALROCK_DATA_DIR') ?? 'data'),
  /** Extra CA certificate(s) to trust for the local server's HTTPS and MQTT TLS. */
  ca: caFile ? readFileSync(caFile) : undefined,
  /** Built web files; served when present. */
  webDir: resolve(root, env('LOCALROCK_WEB_DIR') ?? 'dist/web'),
  /** Extra host names the page may be opened under (comma separated), besides localhost and HOST. */
  allowedHosts: (env('LOCALROCK_ALLOWED_HOSTS') ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
};

export function isLoopbackHost(h: string): boolean {
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}
