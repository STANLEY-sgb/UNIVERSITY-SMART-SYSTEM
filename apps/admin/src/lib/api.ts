/**
 * Cookie-session API client for browsers: HttpOnly cookies carry the tokens (never readable by this script),
 * and unsafe requests echo the double-submit CSRF cookie in X-CSRF-Token.
 */
export const BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('kiu_csrf='))?.split('=')[1] ?? '';

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  const unsafe = method !== 'GET';
  return fetch(`${BASE_URL}/api/v1${path}`, {
    method, credentials: 'include',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(unsafe ? { 'X-CSRF-Token': csrf() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= raw('POST', '/auth/refresh', {}).then((r) => r.ok).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  // Access tokens are short-lived: transparently rotate once on an expired/invalid token.
  if (res.status === 401 && !path.startsWith('/auth/') && (await refresh())) res = await raw(method, path, body);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.code ?? 'ERROR', json?.message ?? `Request failed (${res.status})`, json?.details);
  return json as T;
}

/** Download a file from an authenticated GET endpoint (cookies carry the session) and hand it to the browser. */
export async function download(path: string, fallbackName: string): Promise<void> {
  let res = await raw('GET', path);
  if (res.status === 401 && (await refresh())) res = await raw('GET', path);
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new ApiError(res.status, j?.code ?? 'ERROR', j?.message ?? `Download failed (${res.status})`);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
