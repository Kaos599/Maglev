/**
 * Star prompt prefs (docs/NATIVE_CONTRACT.md section 33): counts and answers, kept on the phone in the kv store.
 */
import { kvGet, kvSet } from './kv.ts';
import { defaultStarState, withFirstSeen, type StarState } from '../star.ts';

const KEY = 'maglev.star.prefs.v1';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Tolerant parse: unknown or missing fields fall back to defaults. */
export function normalizeStarState(raw: unknown): StarState {
  const d = defaultStarState();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    firstSeenAt: num(o.firstSeenAt),
    completedCount: Math.floor(num(o.completedCount) ?? d.completedCount),
    lastDismissedAt: num(o.lastDismissedAt),
    dismissCount: Math.floor(num(o.dismissCount) ?? d.dismissCount),
    starred: o.starred === true,
    never: o.never === true,
  };
}

let cache: StarState | null = null;

export function getStarState(): StarState {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: use defaults for this session.
  }
  cache = normalizeStarState(parsed);
  return cache;
}

export function setStarState(next: StarState): StarState {
  cache = normalizeStarState(next);
  try {
    kvSet(KEY, JSON.stringify(cache));
  } catch {
    // Kept in memory only.
  }
  return cache;
}

/** Apply a pure reducer to the stored state and save the result. */
export function updateStarState(fn: (s: StarState) => StarState): StarState {
  return setStarState(fn(getStarState()));
}

/** Stamp the first run of this code (once). */
export function ensureFirstSeen(now: number = Date.now()): StarState {
  const s = getStarState();
  return s.firstSeenAt == null ? setStarState(withFirstSeen(s, now)) : s;
}
