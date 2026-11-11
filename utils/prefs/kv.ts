/**
 * Small synchronous string store over expo-sqlite/kv-store.
 * Falls back to memory when the native module is missing (Node tests, web).
 */
interface SyncKv {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

const memory = new Map<string, string>();
let kv: SyncKv | null | undefined;

function getKv(): SyncKv | null {
  if (kv !== undefined) return kv;
  try {
    const mod = require('expo-sqlite/kv-store');
    const candidate = mod?.default ?? mod?.Storage ?? mod;
    if (candidate && typeof candidate.getItemSync === 'function' && typeof candidate.setItemSync === 'function') {
      candidate.getItemSync('__probe__');
      kv = candidate as SyncKv;
      return kv;
    }
  } catch {
    // fall through to memory
  }
  kv = null;
  return kv;
}

export function kvGet(key: string): string | null {
  try {
    const store = getKv();
    if (store) return store.getItemSync(key);
  } catch {
    // use the memory copy
  }
  return memory.get(key) ?? null;
}

export function kvSet(key: string, value: string): void {
  memory.set(key, value);
  try {
    getKv()?.setItemSync(key, value);
  } catch {
    // memory copy already holds it
  }
}
