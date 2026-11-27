/**
 * Transfers list preferences (sort key + direction, name lines).
 * Uses expo-sqlite/kv-store's synchronous API; falls back to memory when the
 * native module is missing (Node tests, Expo Go without it, web).
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv.ts';

export type SortKey = 'name' | 'progress' | 'downSpeed' | 'upSpeed' | 'eta' | 'size' | 'added' | 'recent' | 'ratio';
export type SortDir = 'asc' | 'desc';
export interface TransferSort {
  key: SortKey;
  dir: SortDir;
}

const DEFAULT_SORT: TransferSort = { key: 'recent', dir: 'desc' };
export const SORT_KEYS: readonly SortKey[] = ['name', 'progress', 'downSpeed', 'upSpeed', 'eta', 'size', 'added', 'recent', 'ratio'];

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

// ---- Name lines on the Transfers cards ----

/**
 * Lines a card's name can use before it ends in "…". 0 is the whole name. UI only: the engine never sees it.
 * The default, 2, is what the cards showed before the setting existed.
 */
export type NameLines = 0 | 1 | 2 | 3;
export const DEFAULT_NAME_LINES: NameLines = 2;
const NAME_LINES_KEY = 'maglev.transfers.nameLines.v1';

/** A stored value that is not 0, 1, 2 or 3 (an old build, a hand-edited store) falls back to the default. */
export function normalizeNameLines(raw: unknown): NameLines {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : DEFAULT_NAME_LINES;
}

let nameLines: NameLines | null = null;
const nameLineListeners = new Set<() => void>();

export function getTransferNameLines(): NameLines {
  if (nameLines === null) nameLines = normalizeNameLines(kvGet(NAME_LINES_KEY));
  return nameLines;
}

export function setTransferNameLines(next: NameLines): NameLines {
  nameLines = normalizeNameLines(next);
  kvSet(NAME_LINES_KEY, String(nameLines));
  nameLineListeners.forEach((l) => l());
  return nameLines;
}

function subscribeNameLines(l: () => void): () => void {
  nameLineListeners.add(l);
  return () => {
    nameLineListeners.delete(l);
  };
}

/** The live value plus its setter; every card and the Appearance row share it, so a change applies at once. */
export function useTransferNameLines(): [NameLines, typeof setTransferNameLines] {
  const value = useSyncExternalStore(subscribeNameLines, getTransferNameLines, getTransferNameLines);
  return [value, setTransferNameLines];
}
