// The watch list for the app: expo-sqlite kv-store, a live hook, and the sync to the background job.
import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createWatchStore } from './storeCore';
import { cancelWatchNotification } from './native';
import { sameWatch, type AddResult, type Watch, type WatchInput } from './logic';

const core = createWatchStore(Storage);

let cache: Watch[] | null = null;
const listeners = new Set<() => void>();
/** Set by task.ts so this file does not import the background task (and the whole search stack) at startup. */
let afterChange: ((list: Watch[]) => void) | null = null;

export function onWatchesChanged(fn: (list: Watch[]) => void): void {
  afterChange = fn;
}

function commit(next: Watch[]): Watch[] {
  cache = next;
  listeners.forEach((l) => l());
  try {
    afterChange?.(next);
  } catch {
    // The job is re-synced at the next app start.
  }
  return next;
}

export function getWatches(): Watch[] {
  if (!cache) cache = core.list();
  return cache;
}

/** The background job writes from another JS context: call this when the app comes to the front. */
export function refreshWatches(): void {
  cache = core.list();
  listeners.forEach((l) => l());
}

export function addWatchToStore(input: WatchInput): AddResult {
  const r = core.add(input);
  if (r.ok) commit(core.list());
  return r;
}

export function updateWatchInStore(id: string, patch: Partial<Watch>): void {
  commit(core.update(id, patch));
}

export function removeWatchFromStore(id: string): void {
  cancelWatchNotification(id);
  commit(core.remove(id));
}

/** What the Assistant's runner needs (ToolRunnerDeps.watch). */
export const watchApi = {
  count: () => core.list().length,
  has: (query: string, category: string) => core.list().some((w) => sameWatch(w, { query, category })),
  add: (input: WatchInput): { ok: true } | { ok: false; error: string } => {
    const r = addWatchToStore(input);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useWatches(): Watch[] {
  return useSyncExternalStore(subscribe, getWatches, getWatches);
}
