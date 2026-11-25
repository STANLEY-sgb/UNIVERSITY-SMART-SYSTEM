import { useCallback, useEffect, useRef, useState } from 'react';
import { BASE_URL, api } from './api';

export interface Loaded<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** GET a path and keep it fresh. `pollMs` re-fetches quietly (no loading flash) for live dashboards. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const first = useRef(true);

  useEffect(() => { first.current = true; setData(null); }, [path]);
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    const run = () => {
      if (first.current) setLoading(true);
      api<T>('GET', path)
        .then((d) => { if (alive) { setData(d); setError(null); } })
        .catch((e) => { if (alive) setError((e as Error).message); })
        .finally(() => { if (alive) { setLoading(false); first.current = false; } });
    };
    run();
    const id = opts.pollMs ? window.setInterval(run, opts.pollMs) : undefined;
    return () => { alive = false; if (id) clearInterval(id); };
  }, [path, tick, opts.pollMs]);

  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

export interface Paged<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }

export const fmt = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

export type LiveState = 'connecting' | 'live' | 'reconnecting';

/**
 * Subscribes to the server's event stream (cookies authenticate it) and calls `onEvent` at most once a second after
 * a decision or alert. EventSource reconnects by itself; the caller keeps a slow poll as a safety net.
 */
export function useLiveEvents(onEvent: () => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`${BASE_URL}/api/v1/events`, { withCredentials: true });
    let timer = 0;
    const fire = () => { if (timer) return; timer = window.setTimeout(() => { timer = 0; cb.current(); }, 400); };
    es.onopen = () => setState('live');
    es.onerror = () => setState('reconnecting');
    es.addEventListener('decision', fire);
    es.addEventListener('alert', fire);
    return () => { es.close(); window.clearTimeout(timer); };
  }, []);
  return state;
}
