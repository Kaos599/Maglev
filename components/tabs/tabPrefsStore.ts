/** Tab prefs, persisted in the kv store (UI only: never sent to the engine) and read through a hook. */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from '../../utils/prefs/kv.ts';
import { defaultTabPrefs, normalizeTabPrefs, type TabPrefs } from './tabPrefs.ts';

const KEY = 'maglev.tabs.prefs.v1';

let cache: TabPrefs | null = null;
const listeners = new Set<() => void>();

export function getTabPrefs(): TabPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: use defaults for this session.
  }
  cache = parsed ? normalizeTabPrefs(parsed) : defaultTabPrefs();
  return cache;
}

export function setTabPrefs(next: TabPrefs | ((prev: TabPrefs) => TabPrefs)): void {
  const value = normalizeTabPrefs(typeof next === 'function' ? next(getTabPrefs()) : next);
  cache = value;
  try {
    kvSet(KEY, JSON.stringify(value));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTabPrefs(): TabPrefs {
  return useSyncExternalStore(subscribe, getTabPrefs, getTabPrefs);
}
