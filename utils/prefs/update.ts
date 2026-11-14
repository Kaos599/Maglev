/**
 * Update prefs (docs/NATIVE_CONTRACT.md section 27.3): persisted in the kv store, read through a hook.
 * `pending` is the downloaded update (its info and file path), kept so a restart can offer Install.
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv.ts';
import type { UpdateInfo } from '../update/check.ts';
import type { UpdateMode } from '../update/machine.ts';

export interface UpdatePrefs {
  updateMode: UpdateMode;
  /** "Check automatically", on by default. */
  updateAutoCheck: boolean;
  /** Epoch ms of the last automatic or manual check, or null. */
  lastCheckAt: number | null;
  /** A version the automatic check ignores. The manual check still shows it. */
  skippedVersion: string | null;
  pending: { info: UpdateInfo; path: string } | null;
}

export const UPDATE_MODES: readonly UpdateMode[] = ['ask', 'download', 'auto'];
const KEY = 'maglev.update.prefs.v1';

export function defaultUpdatePrefs(): UpdatePrefs {
  return { updateMode: 'download', updateAutoCheck: true, lastCheckAt: null, skippedVersion: null, pending: null };
}

function normalizeInfo(raw: unknown): UpdateInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const version = str(o.version);
  const tag = str(o.tag);
  const apkUrl = str(o.apkUrl);
  const pageUrl = str(o.pageUrl);
  const sha256 = typeof o.sha256 === 'string' && /^[0-9a-f]{64}$/.test(o.sha256) ? o.sha256 : null;
  if (!version || !tag || !apkUrl || !pageUrl || !sha256) return null;
  return {
    version,
    tag,
    notes: typeof o.notes === 'string' ? o.notes : '',
    pageUrl,
    apkUrl,
    sha256,
    size: typeof o.size === 'number' && o.size > 0 ? o.size : 0,
  };
}

/** Tolerant parse: unknown or missing fields fall back to defaults. */
export function normalizeUpdatePrefs(raw: unknown): UpdatePrefs {
  const d = defaultUpdatePrefs();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p = o.pending && typeof o.pending === 'object' ? (o.pending as Record<string, unknown>) : null;
  const info = p ? normalizeInfo(p.info) : null;
  return {
    updateMode: UPDATE_MODES.includes(o.updateMode as UpdateMode) ? (o.updateMode as UpdateMode) : d.updateMode,
    updateAutoCheck: o.updateAutoCheck !== false,
    lastCheckAt: typeof o.lastCheckAt === 'number' && Number.isFinite(o.lastCheckAt) ? o.lastCheckAt : null,
    skippedVersion: typeof o.skippedVersion === 'string' && o.skippedVersion !== '' ? o.skippedVersion : null,
    pending: info && p && typeof p.path === 'string' && p.path !== '' ? { info, path: p.path } : null,
  };
}

let cache: UpdatePrefs | null = null;
const listeners = new Set<() => void>();

export function getUpdatePrefs(): UpdatePrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: use defaults for this session.
  }
  cache = normalizeUpdatePrefs(parsed);
  return cache;
}

export function updateUpdatePrefs(change: Partial<UpdatePrefs> | ((p: UpdatePrefs) => Partial<UpdatePrefs>)): UpdatePrefs {
  const prev = getUpdatePrefs();
  const patch = typeof change === 'function' ? change(prev) : change;
  cache = normalizeUpdatePrefs({ ...prev, ...patch });
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

/** Reactive prefs plus the updater. */
export function useUpdatePrefs(): [UpdatePrefs, typeof updateUpdatePrefs] {
  const prefs = useSyncExternalStore(subscribe, getUpdatePrefs, getUpdatePrefs);
  return [prefs, updateUpdatePrefs];
}
