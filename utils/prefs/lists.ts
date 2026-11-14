/**
 * List prefs (docs/NATIVE_CONTRACT.md section 31.1): persisted in the kv store, read through a hook.
 * `sourcesFile` is the last verified file that was applied, `appliedSerial` its serial (0 = built-in defaults).
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv.ts';
import { DEFAULT_BLOCKLIST_URL } from './browser.ts';
import { validateFile, type SourcesFile } from '../lists/schema.ts';

export interface ListPrefs {
  sourcesFile: SourcesFile | null;
  /** Serial of `sourcesFile`; 0 for the built-in defaults. */
  appliedSerial: number;
  /** Epoch ms of the last automatic or manual check, or null. */
  lastListCheckAt: number | null;
  /** "Update lists automatically", on by default. */
  listsAutoCheck: boolean;
  /** The default ad block list addresses now in force: the previous default the user's own list is compared with. */
  blocklistDefault: string[];
}

const KEY = 'maglev.lists.prefs.v1';

export function defaultListPrefs(): ListPrefs {
  return { sourcesFile: null, appliedSerial: 0, lastListCheckAt: null, listsAutoCheck: true, blocklistDefault: [DEFAULT_BLOCKLIST_URL] };
}

/** Tolerant parse: unknown or missing fields fall back to defaults. */
export function normalizeListPrefs(raw: unknown): ListPrefs {
  const d = defaultListPrefs();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const checked = o.sourcesFile ? validateFile(o.sourcesFile) : null;
  const file = checked && checked.ok ? checked.file : null;
  const urls = Array.isArray(o.blocklistDefault) ? o.blocklistDefault.filter((u): u is string => typeof u === 'string' && /^https:\/\/\S+$/i.test(u)) : [];
  return {
    sourcesFile: file,
    appliedSerial: file ? file.serial : 0,
    lastListCheckAt: typeof o.lastListCheckAt === 'number' && Number.isFinite(o.lastListCheckAt) ? o.lastListCheckAt : null,
    listsAutoCheck: o.listsAutoCheck !== false,
    blocklistDefault: urls.length ? urls : d.blocklistDefault,
  };
}

let cache: ListPrefs | null = null;
const listeners = new Set<() => void>();

export function getListPrefs(): ListPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: use defaults for this session.
  }
  cache = normalizeListPrefs(parsed);
  return cache;
}

export function updateListPrefs(change: Partial<ListPrefs> | ((p: ListPrefs) => Partial<ListPrefs>)): ListPrefs {
  const prev = getListPrefs();
  const patch = typeof change === 'function' ? change(prev) : change;
  cache = normalizeListPrefs({ ...prev, ...patch });
  try {
    kvSet(KEY, JSON.stringify(cache));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
  return cache;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The ad block list addresses a fresh install would use right now: the file's, else the built-in one. */
export function getDefaultBlocklistUrls(): string[] {
  return getListPrefs().blocklistDefault.slice();
}

/** Reactive prefs plus the updater. */
export function useListPrefs(): [ListPrefs, typeof updateListPrefs] {
  const prefs = useSyncExternalStore(subscribe, getListPrefs, getListPrefs);
  return [prefs, updateListPrefs];
}
