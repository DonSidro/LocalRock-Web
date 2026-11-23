/** Run async work one at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class Aborted extends Error {
  constructor() {
    super('Stopped');
  }
}

/** Wait `ms`, or reject with Aborted as soon as `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** First object of a result that is either an object or a list starting with one. */
export function firstObject(result: unknown): Record<string, unknown> | null {
  if (Array.isArray(result)) {
    const f = result[0];
    return typeof f === 'object' && f !== null && !Array.isArray(f) ? (f as Record<string, unknown>) : null;
  }
  return typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null;
}

/** An int from a result that is a number, a numeric string, or a list starting with one. */
export function firstInt(result: unknown): number | null {
  const v = Array.isArray(result) ? result[0] : result;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * A number out of a command answer, whatever shape the firmware used: `45`, `[45]`, `{"key": 45}`
 * or `[{"key": 45}]`. `key` names the field when the answer is an object. Any other shape is null.
 */
export function answerInt(result: unknown, key: string | null = null): number | null {
  if (Array.isArray(result)) return result.length ? answerInt(result[0], key) : null;
  if (result !== null && typeof result === 'object') {
    return key === null ? null : answerInt((result as Record<string, unknown>)[key], null);
  }
  return firstInt(result);
}

export function intField(o: Record<string, unknown> | null, key: string): number | null {
  if (!o) return null;
  const v = o[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}
