/**
 * Sizes for the files the browser finds. Runs in JS, no native change (docs/NATIVE_CONTRACT.md 24.3 leaves
 * `size` null when the page gave none). Direct files: HEAD, then a one-byte ranged GET. Streams: the engine's
 * probeStream gives an estimate. Anything unknown stays null and the UI shows an em dash.
 */
import type { StreamVariant } from '../modules/maglev-engine/src/MaglevEngine.types';

/** How long one size request may take before it counts as unknown. */
export const PROBE_TIMEOUT_MS = 6000;
/** How many size requests run at once. */
export const PROBE_CONCURRENCY = 3;
const CACHE_LIMIT = 600;

/** Only http(s) to a public host. A page must not make the app poke at the user's own network. */
export function isProbeable(url: string): boolean {
  const m = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec(url);
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (host.startsWith('[')) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')) return false;
  const ip = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (ip) {
    const a = Number(ip[1]);
    const b = Number(ip[2]);
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return !!host.includes('.') || !!ip;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}>;

const positive = (v: string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Content-Length from a HEAD request, else the total in Content-Range of a `bytes=0-0` GET. Null when unknown. */
export async function fetchContentLength(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<number | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    try {
      const head = await fetchImpl(url, { method: 'HEAD', headers, signal: ctl.signal });
      if (head.ok) {
        const n = positive(head.headers.get('content-length'));
        if (n != null) return n;
      }
    } catch {
      if (ctl.signal.aborted) return null;
    }
    const res = await fetchImpl(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, signal: ctl.signal });
    if (res.status === 206) return positive(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    // A 200 ignored the range: its Content-Length is the whole file.
    return res.ok ? positive(res.headers.get('content-length')) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/** The biggest quality's estimated size and height from a stream probe, or null when the manifest has no estimate. */
export function streamEstimate(variants: readonly Pick<StreamVariant, 'estBytes' | 'height'>[]): { bytes: number; height: number | null } | null {
  let best: { bytes: number; height: number | null } | null = null;
  for (const v of variants) {
    if (v.estBytes == null || !(v.estBytes > 0)) continue;
    if (!best || v.estBytes > best.bytes) best = { bytes: v.estBytes, height: v.height ?? null };
  }
  return best;
}

export interface SizeProber {
  /** Runs `task` for `key` once: later calls share its answer, cached for good (an unknown answer too). */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** The cached answer, or undefined when `run` has not finished for this key. */
  peek<T>(key: string): T | undefined;
}

/** Limits how many size tasks run at once, gives up on slow ones, and remembers answers per key. */
export function createSizeProber({ concurrency = PROBE_CONCURRENCY, timeoutMs = PROBE_TIMEOUT_MS * 2 }: { concurrency?: number; timeoutMs?: number } = {}): SizeProber {
  const cache = new Map<string, unknown>();
  const inflight = new Map<string, Promise<unknown>>();
  const waiting: (() => void)[] = [];
  let active = 0;

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < concurrency) {
        active++;
        resolve();
      } else waiting.push(() => { active++; resolve(); });
    });
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  return {
    peek: <T,>(key: string) => cache.get(key) as T | undefined,
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      if (cache.has(key)) return Promise.resolve(cache.get(key) as T);
      const open = inflight.get(key);
      if (open) return open as Promise<T>;
      const p = (async () => {
        await acquire();
        try {
          const value = await Promise.race([task(), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
          cache.set(key, value);
          return value as T;
        } catch {
          cache.set(key, null);
          return null as T;
        } finally {
          release();
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
  };
}
