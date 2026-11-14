/**
 * Browser prefs (docs/NATIVE_CONTRACT.md section 24.6): persisted in the kv store, read through a hook.
 * The pure URL helpers live in utils/browserUrl.ts and are re-exported here.
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv.ts';
import { SEARCH_ENGINES, type SearchEngine } from '../browserUrl.ts';

export { toBrowserUrl, SEARCH_ENGINES } from '../browserUrl.ts';
export type { SearchEngine, BrowserTarget } from '../browserUrl.ts';

/** The upstream address of the bundled list (its header says where it came from). */
export const DEFAULT_BLOCKLIST_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts';

export interface BrowserPrefs {
  adBlock: boolean;
  /** Sites the user allowed ads on, without `www.`. */
  allowAdsHosts: string[];
  /** https addresses of block lists. */
  blocklistUrls: string[];
  desktopMode: boolean;
  /** Hide video and audio under 1 MB and images under 50 KB in the found-files list. */
  hideSmallFiles: boolean;
  searchEngine: SearchEngine;
  /** Keep a history of the pages opened in the browser (section 24.9). */
  saveHistory: boolean;
  /** Offer history matches under the address bar. */
  suggestFromHistory: boolean;
  /** Empty the history when Maglev closes, and again on the next start. */
  clearHistoryOnClose: boolean;
  /** What to do with pop-ups and redirects the user didn't tap for (section 24.10). */
  popupPolicy: PopupPolicy;
  /** Sites allowed to open pop-ups and redirects, without `www.`. */
  popupAllowHosts: string[];
}

export type PopupPolicy = 'ask' | 'block' | 'allow';
const POPUP_POLICIES: readonly PopupPolicy[] = ['ask', 'block', 'allow'];

const KEY = 'maglev.browser.prefs.v1';

export function defaultBrowserPrefs(): BrowserPrefs {
  return {
    adBlock: true,
    allowAdsHosts: [],
    blocklistUrls: [DEFAULT_BLOCKLIST_URL],
    desktopMode: false,
    hideSmallFiles: true,
    searchEngine: 'duckduckgo',
    saveHistory: true,
    suggestFromHistory: true,
    clearHistoryOnClose: false,
    popupPolicy: 'ask',
    popupAllowHosts: [],
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

/** Tolerant parse: unknown or missing fields fall back to defaults. */
export function normalizeBrowserPrefs(raw: unknown): BrowserPrefs {
  const d = defaultBrowserPrefs();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const urls = strings(o.blocklistUrls).filter((u) => /^https:\/\/\S+$/i.test(u));
  return {
    adBlock: o.adBlock !== false,
    allowAdsHosts: [...new Set(strings(o.allowAdsHosts).map((h) => h.toLowerCase()))],
    blocklistUrls: urls.length ? urls : d.blocklistUrls,
    desktopMode: o.desktopMode === true,
    hideSmallFiles: o.hideSmallFiles !== false,
    searchEngine: (SEARCH_ENGINES as readonly unknown[]).includes(o.searchEngine) ? (o.searchEngine as SearchEngine) : d.searchEngine,
    saveHistory: o.saveHistory !== false,
    suggestFromHistory: o.suggestFromHistory !== false,
    clearHistoryOnClose: o.clearHistoryOnClose === true,
    popupPolicy: POPUP_POLICIES.includes(o.popupPolicy as PopupPolicy) ? (o.popupPolicy as PopupPolicy) : 'ask',
    popupAllowHosts: [...new Set(strings(o.popupAllowHosts).map((h) => h.toLowerCase()))],
  };
}

let cache: BrowserPrefs | null = null;
const listeners = new Set<() => void>();

export function getBrowserPrefs(): BrowserPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  try {
    const raw = kvGet(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    // Unreadable: use defaults for this session.
  }
  cache = normalizeBrowserPrefs(parsed);
  return cache;
}

export function updateBrowserPrefs(change: Partial<BrowserPrefs> | ((p: BrowserPrefs) => Partial<BrowserPrefs>)): BrowserPrefs {
  const prev = getBrowserPrefs();
  const patch = typeof change === 'function' ? change(prev) : change;
  cache = normalizeBrowserPrefs({ ...prev, ...patch });
  try {
    kvSet(KEY, JSON.stringify(cache));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
  return cache;
}

/** Called after every change to the browser prefs. */
export function subscribeBrowserPrefs(l: () => void): () => void {
  return subscribe(l);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Reactive prefs plus the updater. */
export function useBrowserPrefs(): [BrowserPrefs, typeof updateBrowserPrefs] {
  const prefs = useSyncExternalStore(subscribe, getBrowserPrefs, getBrowserPrefs);
  return [prefs, updateBrowserPrefs];
}
