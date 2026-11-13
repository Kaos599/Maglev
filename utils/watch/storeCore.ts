// Watch list persistence with an injected storage, so it runs in Node tests. The app binds expo-sqlite in store.ts.
import { addWatch, normalizeWatches, type AddResult, type Watch, type WatchInput } from './logic.ts';

export const WATCH_KEY = 'maglev.watch.v1';

export interface SyncStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

export interface WatchStore {
  list(): Watch[];
  save(list: readonly Watch[]): void;
  add(input: WatchInput, now?: number): AddResult;
  update(id: string, patch: Partial<Watch>): Watch[];
  remove(id: string): Watch[];
}

export function createWatchStore(storage: SyncStorage, key = WATCH_KEY): WatchStore {
  const read = (): Watch[] => {
    try {
      const raw = storage.getItemSync(key);
      return raw ? normalizeWatches(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  };
  const write = (list: readonly Watch[]): void => {
    try {
      storage.setItemSync(key, JSON.stringify(list));
    } catch {
      // Storage unavailable: the change lasts until the app closes.
    }
  };
  return {
    list: read,
    save: write,
    add(input, now = Date.now()) {
      const r = addWatch(read(), input, now);
      if (r.ok) write(r.list);
      return r;
    },
    update(id, patch) {
      const next = read().map((w) => (w.id === id ? { ...w, ...patch, id: w.id } : w));
      write(next);
      return next;
    },
    remove(id) {
      const next = read().filter((w) => w.id !== id);
      write(next);
      return next;
    },
  };
}
