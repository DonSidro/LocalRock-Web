/* HTTP calls to the LocalRock Web server. Every POST is JSON, which the server requires. */

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  let body: { ok?: boolean; result?: T; error?: string } | null = null;
  try {
    body = (await res.json()) as { ok?: boolean; result?: T; error?: string };
  } catch {
    // fall through
  }
  if (!res.ok || !body || body.ok === false) {
    if (res.status === 401) window.dispatchEvent(new Event('lrw-auth-required'));
    throw new ApiError(body?.error ?? `Request failed (HTTP ${res.status})`, res.status);
  }
  return body.result as T;
}

export async function get<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { credentials: 'same-origin' }));
}

export async function post<T = null>(path: string, body: unknown = {}): Promise<T> {
  return handle<T>(await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** A robot action by name; see server/vacuumCalls.ts for the list. */
export function call<T = null>(duid: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return post<T>(`/api/vacuums/${encodeURIComponent(duid)}/call`, { name, args });
}
