import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Starts the simulator and a LocalRock Web server with an empty data folder, runs a check script
 * against them, then stops both.
 *   npx tsx scripts/with-sim.ts scripts/e2e-api.ts
 *   npx tsx scripts/with-sim.ts scripts/screens.ts        (needs "npm run build" first)
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const port = process.env['PORT'] ?? '8099';
const base = `http://127.0.0.1:${port}`;
const script = process.argv[2];
if (!script) {
  console.error('usage: tsx scripts/with-sim.ts <script>');
  process.exit(2);
}
const dataDir = mkdtempSync(join(tmpdir(), 'lrw-data-'));
const children: ChildProcess[] = [];

function start(name: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d: Buffer) => { if (process.env['VERBOSE']) process.stdout.write(`[${name}] ${d}`); });
  child.stderr!.on('data', (d: Buffer) => process.stderr.write(`[${name}] ${d}`));
  children.push(child);
  return child;
}

async function waitFor(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

function stopAll(): void {
  for (const c of children) if (c.exitCode === null) c.kill();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function main(): Promise<number> {
  start('sim', [tsx, 'sim/index.ts']);
  const useBuild = process.env['USE_BUILD'] === '1';
  start('server', useBuild ? ['dist/server/server/index.js'] : [tsx, 'server/index.ts'], { PORT: port, LOCALROCK_DATA_DIR: dataDir });
  await waitFor(`${base}/api/state`, 30_000);
  await new Promise((r) => setTimeout(r, 1_500));
  const check = start('check', [tsx, script!], { BASE: base });
  check.stdout!.removeAllListeners('data');
  check.stdout!.on('data', (d: Buffer) => process.stdout.write(d));
  return new Promise((resolve) => check.on('exit', (code) => resolve(code ?? 1)));
}

main().then((code) => { stopAll(); process.exit(code); }, (e) => { console.error(e); stopAll(); process.exit(1); });
process.on('SIGINT', () => { stopAll(); process.exit(130); });
