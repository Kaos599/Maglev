/**
 * Link download prefs: how many parts (connections) a plain-file link download uses.
 * The engine accepts 1 to 8 and falls back to 1 when a server does not support ranges.
 * Persisted in the kv store and read through a hook, like utils/prefs/lists.ts.
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv.ts';

export const PART_CHOICES = [1, 2, 4, 8] as const;
export type DownloadParts = (typeof PART_CHOICES)[number];

export const DEFAULT_DOWNLOAD_PARTS: DownloadParts = 4;

export interface LinkDownloadPrefs {
  /** Parts per link download: 1, 2, 4 or 8. */
  downloadParts: DownloadParts;
}

const KEY = 'maglev.linkDownloads.prefs.v1';

/** Anything that is not one of the allowed counts becomes the default. */
export function normalizeDownloadParts(raw: unknown): DownloadParts {
  return (PART_CHOICES as readonly unknown[]).includes(raw) ? (raw as DownloadParts) : DEFAULT_DOWNLOAD_PARTS;
}

/** Tolerant parse: unknown or missing fields fall back to defaults. */
function normalizeLinkDownloadPrefs(raw: unknown): LinkDownloadPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { downloadParts: normalizeDownloadParts(o.downloadParts) };
}

let cache: LinkDownloadPrefs | null = null;
const listeners = new Set<() => void>();

export function getLinkDownloadPrefs(): LinkDownloadPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: use defaults for this session.
  }
  cache = normalizeLinkDownloadPrefs(parsed);
  return cache;
}

export function updateLinkDownloadPrefs(
  change: Partial<LinkDownloadPrefs> | ((p: LinkDownloadPrefs) => Partial<LinkDownloadPrefs>),
): LinkDownloadPrefs {
  const prev = getLinkDownloadPrefs();
  const patch = typeof change === 'function' ? change(prev) : change;
  cache = normalizeLinkDownloadPrefs({ ...prev, ...patch });
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
export function useLinkDownloadPrefs(): [LinkDownloadPrefs, typeof updateLinkDownloadPrefs] {
  const prefs = useSyncExternalStore(subscribe, getLinkDownloadPrefs, getLinkDownloadPrefs);
  return [prefs, updateLinkDownloadPrefs];
}
