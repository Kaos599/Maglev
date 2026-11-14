import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import * as SecureStore from 'expo-secure-store';
import type { Category } from '../search/types';
import { PROVIDERS } from '../search/aggregate.ts';
import { clearAllClearances, hydrateClearances, listClearances, onClearancesChange } from '../search/clearance.ts';
import type { Clearance } from '../search/clearance.ts';

/** Contract: docs/SEARCH_CONTRACT.md section 5. */
export interface TorznabConfig {
  /** Bare uuid. The provider id used in `enabled` / `useFor` is `torznab:<id>`. */
  id: string;
  name: string;
  url: string;
  categories: Category[];
}

export interface SearchPrefs {
  enabled: string[];
  useFor: Record<string, Category[]>;
  mirrorOverride: Record<string, string>;
  adult: boolean;
  /** Mark results whose every source is known for fake or harmful uploads. */
  warnUnsafe: boolean;
  waitSeconds: 5 | 8 | 15;
  limit: 25 | 50 | 100;
  hideDead: boolean;
  /** Lines of a result name before the ellipsis. 0 shows the full name. UI only; never reaches the engine. */
  resultNameLines: 0 | 1 | 2 | 3;
  sort: 'seeders' | 'newest' | 'size' | 'name';
  lastCategory: Category;
  recents: string[];
  torznab: TorznabConfig[];
  /** Hosts the user passed a Cloudflare check on (SEARCH_CONTRACT section 8). Cookies live in the WebView jar, never here. */
  clearances: Clearance[];
  /** Sources that last answered with a Cloudflare check; they need the user to open the site once. */
  needsCheck: string[];
  /** When the user last closed the "needs a quick check" line (ms since epoch, 0 = never). */
  fixHintDismissedAt: number;
}

const KEY = 'maglev.search.prefs.v2';
const LEGACY_RECENTS_KEY = 'maglev.search.recents.v1';
const MAX_RECENTS = 8;

const CATEGORIES: readonly Category[] = ['all', 'movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other', 'adult'];
const SORTS = ['seeders', 'newest', 'size', 'name'] as const;

function defaultEnabled(): string[] {
  return PROVIDERS.filter((p) => p.enabledByDefault).map((p) => p.id);
}

function defaults(): SearchPrefs {
  return {
    enabled: defaultEnabled(),
    useFor: {},
    mirrorOverride: {},
    adult: false,
    warnUnsafe: true,
    waitSeconds: 8,
    limit: 50,
    hideDead: true,
    resultNameLines: 2,
    sort: 'seeders',
    lastCategory: 'all',
    recents: [],
    torznab: [],
    clearances: [],
    needsCheck: [],
    fixHintDismissedAt: 0,
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function categories(v: unknown): Category[] {
  return strings(v).filter((c): c is Category => (CATEGORIES as readonly string[]).includes(c));
}

function recordOf<T>(v: unknown, pick: (x: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const picked = pick(x);
      if (picked !== null) out[k] = picked;
    }
  }
  return out;
}

/** Tolerant parse: unknown or missing fields fall back to defaults. `enabled` missing means "seed from defaults". */
export function normalizeSearchPrefs(raw: unknown, legacyRecents: string[]): SearchPrefs {
  const d = defaults();
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const recents = (Array.isArray(o.recents) ? strings(o.recents) : legacyRecents).slice(0, MAX_RECENTS);
  const torznab: TorznabConfig[] = Array.isArray(o.torznab)
    ? (o.torznab as unknown[]).flatMap((t) => {
        const x = t as Partial<TorznabConfig> | null;
        if (!x || typeof x.id !== 'string' || typeof x.name !== 'string' || typeof x.url !== 'string') return [];
        return [{ id: x.id, name: x.name, url: x.url, categories: categories(x.categories) }];
      })
    : [];
  const clearances: Clearance[] = Array.isArray(o.clearances)
    ? (o.clearances as unknown[]).flatMap((c) => {
        const x = c as Partial<Clearance> | null;
        if (!x || typeof x.host !== 'string' || !x.host || typeof x.userAgent !== 'string' || !x.userAgent) return [];
        return [{ host: x.host.toLowerCase(), userAgent: x.userAgent, at: typeof x.at === 'number' ? x.at : 0 }];
      })
    : [];
  return {
    enabled: Array.isArray(o.enabled) ? strings(o.enabled) : d.enabled,
    useFor: recordOf(o.useFor, (x) => (Array.isArray(x) ? categories(x) : null)),
    mirrorOverride: recordOf(o.mirrorOverride, (x) => (typeof x === 'string' && x ? x : null)),
    adult: o.adult === true,
    warnUnsafe: o.warnUnsafe !== false,
    waitSeconds: o.waitSeconds === 5 || o.waitSeconds === 15 ? o.waitSeconds : 8,
    limit: o.limit === 25 || o.limit === 100 ? o.limit : 50,
    hideDead: o.hideDead !== false,
    resultNameLines: o.resultNameLines === 0 || o.resultNameLines === 1 || o.resultNameLines === 3 ? o.resultNameLines : 2,
    sort: (SORTS as readonly unknown[]).includes(o.sort) ? (o.sort as SearchPrefs['sort']) : d.sort,
    lastCategory: (CATEGORIES as readonly unknown[]).includes(o.lastCategory) ? (o.lastCategory as Category) : 'all',
    recents,
    torznab,
    clearances,
    needsCheck: [...new Set(strings(o.needsCheck))],
    fixHintDismissedAt: typeof o.fixHintDismissedAt === 'number' && Number.isFinite(o.fixHintDismissedAt) && o.fixHintDismissedAt > 0 ? o.fixHintDismissedAt : 0,
  };
}

function readLegacyRecents(): string[] {
  try {
    const raw = Storage.getItemSync(LEGACY_RECENTS_KEY);
    if (raw) return strings(JSON.parse(raw)).slice(0, MAX_RECENTS);
  } catch {
    // Legacy store unreadable: start with no recents.
  }
  return [];
}

let cache: SearchPrefs | null = null;
const listeners = new Set<() => void>();

function load(): SearchPrefs {
  if (cache) return cache;
  let parsed: unknown = null;
  let found = false;
  try {
    const raw = Storage.getItemSync(KEY);
    if (raw) {
      parsed = JSON.parse(raw);
      found = true;
    }
  } catch {
    // Storage unavailable: use defaults for this session.
  }
  cache = normalizeSearchPrefs(parsed, found ? [] : readLegacyRecents());
  if (!found) persist(cache);
  hydrateClearances(cache.clearances);
  return cache;
}

// The HTTP layer drops a clearance when the host challenges again, and the solver adds one: mirror both into prefs.
onClearancesChange(() => {
  if (cache) updateSearchPrefs({ clearances: listClearances() });
});

/**
 * Forgets every cleared host (prefs and in-memory table). Returns the hosts so the caller can expire
 * their cookies in the WebView jar.
 */
export function clearSiteChecks(): Clearance[] {
  const had = clearAllClearances();
  updateSearchPrefs({ clearances: [] });
  return had;
}

function persist(p: SearchPrefs): void {
  try {
    Storage.setItemSync(KEY, JSON.stringify(p));
  } catch {
    // Kept in memory only.
  }
}

/** Current prefs (synchronous). */
export function getSearchPrefs(): SearchPrefs {
  return load();
}

/**
 * Applies a change and notifies subscribers.
 * Turning `adult` off also disables every nsfw provider (TorrentSearch's model) and drops the adult category.
 */
export function updateSearchPrefs(change: Partial<SearchPrefs> | ((p: SearchPrefs) => Partial<SearchPrefs>)): SearchPrefs {
  const prev = load();
  const patch = typeof change === 'function' ? change(prev) : change;
  let next: SearchPrefs = { ...prev, ...patch };
  if (prev.adult && !next.adult) {
    const nsfw = new Set(PROVIDERS.filter((p) => p.nsfw).map((p) => p.id));
    next = {
      ...next,
      enabled: next.enabled.filter((id) => !nsfw.has(id)),
      lastCategory: next.lastCategory === 'adult' ? 'all' : next.lastCategory,
    };
  }
  cache = next;
  persist(next);
  listeners.forEach((l) => l());
  return next;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Reactive prefs plus the updater. */
export function useSearchPrefs(): [SearchPrefs, typeof updateSearchPrefs] {
  const prefs = useSyncExternalStore(subscribe, getSearchPrefs, getSearchPrefs);
  return [prefs, updateSearchPrefs];
}

// ---- Recents (existing behaviour, now inside the prefs record) ----

/** Last searches, newest first (max 8). */
export function getRecentSearches(): string[] {
  return load().recents;
}

/** Adds a query to the front, de-duplicating case-insensitively. Returns the new list. */
export function addRecentSearch(query: string): string[] {
  const q = query.trim();
  const current = load().recents;
  if (!q) return current;
  const recents = [q, ...current.filter((r) => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENTS);
  return updateSearchPrefs({ recents }).recents;
}

/** Removes one recent search (case-insensitive). Returns the new list. */
export function removeRecentSearch(query: string): string[] {
  const q = query.trim().toLowerCase();
  return updateSearchPrefs({ recents: load().recents.filter((r) => r.toLowerCase() !== q) }).recents;
}

export function clearRecentSearches(): string[] {
  return updateSearchPrefs({ recents: [] }).recents;
}

// ---- Torznab API keys (expo-secure-store) ----

/** SecureStore keys allow only [A-Za-z0-9._-], so the contract's `torznab:<id>` is stored as `torznab.<id>`. */
export function torznabKeyName(id: string): string {
  return `torznab.${id.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export async function getTorznabApiKey(id: string): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(torznabKeyName(id))) ?? '';
  } catch {
    return '';
  }
}

export async function setTorznabApiKey(id: string, apiKey: string): Promise<void> {
  await SecureStore.setItemAsync(torznabKeyName(id), apiKey);
}

export async function deleteTorznabApiKey(id: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(torznabKeyName(id));
  } catch {
    // Nothing stored.
  }
}
