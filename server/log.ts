/* Plain console logging with a timestamp. Secrets (keys, passwords, tokens) are never passed here. */

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

const debugEnabled = process.env['LOCALROCK_DEBUG'] === '1';

export const log = {
  debug(msg: string): void {
    if (debugEnabled) console.log(`${stamp()} [debug] ${msg}`);
  },
  info(msg: string): void {
    console.log(`${stamp()} [info] ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`${stamp()} [warn] ${msg}`);
  },
  error(msg: string): void {
    console.error(`${stamp()} [error] ${msg}`);
  },
};
