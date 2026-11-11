/**
 * Transfers list preferences (sort key + direction).
 * Uses expo-sqlite/kv-store's synchronous API; falls back to memory when the
 * native module is missing (Node tests, Expo Go without it, web).
 */
export type SortKey = 'name' | 'progress' | 'downSpeed' | 'upSpeed' | 'eta' | 'size' | 'added' | 'ratio';
export type SortDir = 'asc' | 'desc';
export interface TransferSort {
  key: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: TransferSort = { key: 'added', dir: 'desc' };
export const SORT_KEYS: readonly SortKey[] = ['name', 'progress', 'downSpeed', 'upSpeed', 'eta', 'size', 'added', 'ratio'];

const STORAGE_KEY = 'maglev.transfers.sort';

interface SyncKv {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

let memory: string | null = null;
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

export function loadTransferSort(): TransferSort {
  let raw: string | null = memory;
  try {
    const store = getKv();
    if (store) raw = store.getItemSync(STORAGE_KEY);
  } catch {
    raw = memory;
  }
  if (!raw) return DEFAULT_SORT;
  try {
    const parsed = JSON.parse(raw) as Partial<TransferSort>;
    const key = SORT_KEYS.find((k) => k === parsed.key);
    const dir = parsed.dir === 'asc' || parsed.dir === 'desc' ? parsed.dir : undefined;
    return key && dir ? { key, dir } : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
  }
}

export function saveTransferSort(sort: TransferSort): void {
  const raw = JSON.stringify(sort);
  memory = raw;
  try {
    getKv()?.setItemSync(STORAGE_KEY, raw);
  } catch {
    // memory copy already holds it
  }
}
