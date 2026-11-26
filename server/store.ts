import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomHex } from './protocol/crypto.js';
import { log } from './log.js';
import type { UserData } from './net/serverApi.js';

/*
 * Settings kept between runs, in <dataDir>/settings.json (written with owner-only permissions where
 * the OS supports it). Holds the same things the app keeps in its preferences: the server address,
 * the login session and the login code for silent re-login, the admin password, per-robot camera
 * PINs and default cleaning orders.
 */

export interface NotifySettings {
  enabled: boolean;
  errors: boolean;
  finished: boolean;
  dock: boolean;
}

export interface StoredSettings {
  installId: string;
  serverBaseUrl: string | null;
  allowSelfSigned: boolean;
  userData: UserData | null;
  loginEmail: string | null;
  loginCode: string | null;
  adminPassword: string | null;
  notify: NotifySettings;
  cleanOrders: Record<string, number[]>;
}

function defaults(): StoredSettings {
  return {
    installId: randomHex(4),
    serverBaseUrl: null,
    allowSelfSigned: false,
    userData: null,
    loginEmail: null,
    loginCode: null,
    adminPassword: null,
    notify: { enabled: false, errors: true, finished: true, dock: true },
    cleanOrders: {},
  };
}

export class Store {
  private readonly file: string;
  private data: StoredSettings;

  constructor(private readonly dir: string) {
    this.file = join(dir, 'settings.json');
    mkdirSync(dir, { recursive: true });
    this.data = this.load();
    try {
      this.save();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        const uid = typeof process.getuid === 'function' ? ` (running as user ${process.getuid()})` : '';
        throw new Error(`Can't write to the data folder ${dir}${uid}. Make it writable for this user; in Docker, set PUID and PGID to the folder's owner.`);
      }
      throw e;
    }
  }

  private load(): StoredSettings {
    const base = defaults();
    if (!existsSync(this.file)) return base;
    try {
      // Camera PINs were kept here before 1.5.0; like the app, the live view now keeps them in memory only, so old ones are dropped.
      const { cameraPins: _dropped, ...parsed } = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<StoredSettings> & { cameraPins?: unknown };
      return {
        ...base,
        ...parsed,
        notify: { ...base.notify, ...(parsed.notify ?? {}) },
        cleanOrders: parsed.cleanOrders ?? {},
      };
    } catch (e) {
      log.error(`Could not read ${this.file}, starting with empty settings: ${(e as Error).message}`);
      return base;
    }
  }

  get(): Readonly<StoredSettings> {
    return this.data;
  }

  update(change: (s: StoredSettings) => void): void {
    change(this.data);
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get dataDir(): string {
    return this.dir;
  }

  cleanOrder(duid: string, mapFlag: number): number[] {
    return this.data.cleanOrders[`${duid}_${mapFlag}`] ?? [];
  }

  setCleanOrder(duid: string, mapFlag: number, order: number[]): void {
    this.update((s) => {
      const key = `${duid}_${mapFlag}`;
      if (order.length === 0) delete s.cleanOrders[key];
      else s.cleanOrders[key] = order;
    });
  }
}
