/**
 * Stats prefs (docs/NATIVE_CONTRACT.md section 34.2), kept on the phone in the kv store.
 * `keepStats` off: nothing is recorded, what exists stays until Reset. `mobileLimitMb`: monthly mobile-data limit, null = off.
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from '../prefs/kv.ts';

export interface StatsPrefs {
  keepStats: boolean;
  mobileLimitMb: number | null;
}

const STATS_PREFS_KEY = 'maglev.stats.prefs.v1';
const defaultStatsPrefs = (): StatsPrefs => ({ keepStats: true, mobileLimitMb: null });

/** Tolerant parse: unknown or missing fields fall back to defaults. */
export function normalizeStatsPrefs(raw: unknown): StatsPrefs {
  const d = defaultStatsPrefs();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mb = typeof o.mobileLimitMb === 'number' && Number.isFinite(o.mobileLimitMb) && o.mobileLimitMb >= 1 ? Math.floor(o.mobileLimitMb) : null;
  return { keepStats: typeof o.keepStats === 'boolean' ? o.keepStats : d.keepStats, mobileLimitMb: mb };
}

let cache: StatsPrefs | null = null;
const listeners = new Set<() => void>();

export function getStatsPrefs(): StatsPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(STATS_PREFS_KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: defaults for this session.
  }
  cache = normalizeStatsPrefs(parsed);
  return cache;
}

export function setStatsPrefs(next: Partial<StatsPrefs>): StatsPrefs {
  cache = normalizeStatsPrefs({ ...getStatsPrefs(), ...next });
  try {
    kvSet(STATS_PREFS_KEY, JSON.stringify(cache));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
  return cache;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Reactive stats prefs. */
export function useStatsPrefs(): StatsPrefs {
  return useSyncExternalStore(subscribe, getStatsPrefs, getStatsPrefs);
}
