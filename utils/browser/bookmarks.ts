/**
 * Browser bookmarks, persisted in the kv store (UI only: never sent to the engine) and read through a hook.
 * Bookmarks are in a backup, because they are the user's own choices and should survive a reinstall or a new
 * phone; restore merges them into what is already here. Browsing history is not in a backup. The pure functions work on arrays so tests run them
 * directly; the store functions below wrap them.
 */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from '../prefs/kv.ts';

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  host: string;
  addedAt: number;
}

export const BOOKMARKS_KEY = 'maglev.browser.bookmarks.v1';
export const BOOKMARK_CAP = 500;
const TITLE_MAX = 200;

/** The host of an http(s) link without credentials or port, lower case, or ''. */
function hostFrom(url: string): string {
  const m = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec((url ?? '').trim());
  return m ? m[1].toLowerCase() : '';
}

/**
 * One key per page: scheme and host lower case, fragment dropped, a bare trailing slash dropped. Query strings
 * stay, because they often pick the page. Anything that isn't http(s) gives ''.
 */
export function normalizeUrl(url: string): string {
  const t = (url ?? '').trim();
  const m = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(t);
  if (!m || !hostFrom(t)) return '';
  const path = m[3] === '/' ? '' : m[3];
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${path}${m[4] ?? ''}`;
}

const cleanTitle = (title: string, fallback: string) => ((title ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || fallback);

/** Reads whatever was stored and keeps only well-formed rows, in stored order. Corrupt JSON gives []. */
export function parseBookmarks(raw: string | null | undefined): Bookmark[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: Bookmark[] = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || !o.id || typeof o.url !== 'string') continue;
    const key = normalizeUrl(o.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const host = hostFrom(o.url);
    out.push({
      id: o.id,
      url: o.url,
      title: cleanTitle(typeof o.title === 'string' ? o.title : '', host),
      host,
      addedAt: typeof o.addedAt === 'number' && Number.isFinite(o.addedAt) ? o.addedAt : 0,
    });
    if (out.length >= BOOKMARK_CAP) break;
  }
  return out;
}

export type AddResult = { list: Bookmark[]; added: Bookmark | null; reason: 'added' | 'exists' | 'invalid' | 'full' };

/** Adds a page at the end of the list. A page already saved (same normalised address) or a non-web address is refused. */
export function addTo(list: readonly Bookmark[], url: string, title: string, now: number, id: string): AddResult {
  const key = normalizeUrl(url);
  if (!key) return { list: [...list], added: null, reason: 'invalid' };
  if (list.some((b) => normalizeUrl(b.url) === key)) return { list: [...list], added: null, reason: 'exists' };
  if (list.length >= BOOKMARK_CAP) return { list: [...list], added: null, reason: 'full' };
  const host = hostFrom(url);
  const added: Bookmark = { id, url: url.trim(), title: cleanTitle(title, host), host, addedAt: now };
  return { list: [...list, added], added, reason: 'added' };
}

export const removeFrom = (list: readonly Bookmark[], id: string): Bookmark[] => list.filter((b) => b.id !== id);

/** A blank title falls back to the host, so a row is never empty. */
export function renameIn(list: readonly Bookmark[], id: string, title: string): Bookmark[] {
  return list.map((b) => (b.id === id ? { ...b, title: cleanTitle(title, b.host) } : b));
}

/** Moves one bookmark to `toIndex` (clamped). An unknown id changes nothing. */
export function moveIn(list: readonly Bookmark[], id: string, toIndex: number): Bookmark[] {
  const from = list.findIndex((b) => b.id === id);
  if (from < 0) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, item);
  return next;
}

/** Puts a removed bookmark back where it was (Undo). Skipped when that page was saved again meanwhile. */
export function restoreIn(list: readonly Bookmark[], b: Bookmark, index: number): Bookmark[] {
  const key = normalizeUrl(b.url);
  if (list.some((x) => x.id === b.id || normalizeUrl(x.url) === key) || list.length >= BOOKMARK_CAP) return [...list];
  const next = [...list];
  next.splice(Math.max(0, Math.min(next.length, index)), 0, b);
  return next;
}

/** Bookmarks whose title, host or address contains the query (case-insensitive, trimmed), in stored order. */
export function filterBookmarks(list: readonly Bookmark[], query: string): Bookmark[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return [...list];
  return list.filter((b) => b.title.toLowerCase().includes(q) || b.host.includes(q) || b.url.toLowerCase().includes(q));
}

/**
 * Restore: keeps `existing` as it is, in order, then appends the incoming rows whose address isn't already there,
 * up to BOOKMARK_CAP. Incoming rows go through parseBookmarks, so corrupt ones are dropped. A row whose id is
 * taken gets a new id. Importing a list into the phone that wrote it adds nothing.
 */
export function mergeBookmarks(existing: readonly Bookmark[], incoming: unknown): Bookmark[] {
  const out = [...existing];
  if (!Array.isArray(incoming)) return out;
  const keys = new Set(out.map((b) => normalizeUrl(b.url)));
  const ids = new Set(out.map((b) => b.id));
  for (const b of parseBookmarks(JSON.stringify(incoming))) {
    if (out.length >= BOOKMARK_CAP) break;
    const key = normalizeUrl(b.url);
    if (keys.has(key)) continue;
    keys.add(key);
    let id = b.id;
    for (let n = 1; ids.has(id); n++) id = `${b.id}-i${n}`;
    ids.add(id);
    out.push(id === b.id ? b : { ...b, id });
  }
  return out;
}

export const isBookmarkedIn = (list: readonly Bookmark[], url: string): boolean => {
  const key = normalizeUrl(url);
  return key !== '' && list.some((b) => normalizeUrl(b.url) === key);
};

export const findBookmark = (list: readonly Bookmark[], url: string): Bookmark | null => {
  const key = normalizeUrl(url);
  return (key && list.find((b) => normalizeUrl(b.url) === key)) || null;
};

// ---- store ----

let cache: Bookmark[] | null = null;
let counter = 0;
const listeners = new Set<() => void>();

export function listBookmarks(): Bookmark[] {
  if (cache) return cache;
  let raw: string | null = null;
  try {
    raw = kvGet(BOOKMARKS_KEY);
  } catch {
    // Unreadable: start empty for this session.
  }
  cache = parseBookmarks(raw);
  return cache;
}

function commit(next: Bookmark[]): void {
  cache = next;
  try {
    kvSet(BOOKMARKS_KEY, JSON.stringify(next));
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
}

const newId = (now: number) => `bm-${now.toString(36)}-${(counter++).toString(36)}`;

export function addBookmark(url: string, title: string, now: number = Date.now()): AddResult {
  const r = addTo(listBookmarks(), url, title, now, newId(now));
  if (r.added) commit(r.list);
  return r;
}

/** Removes one and returns it with its position, for Undo. Null when the id is unknown. */
export function removeBookmark(id: string): { bookmark: Bookmark; index: number } | null {
  const list = listBookmarks();
  const index = list.findIndex((b) => b.id === id);
  if (index < 0) return null;
  commit(removeFrom(list, id));
  return { bookmark: list[index], index };
}

export function restoreBookmark(b: Bookmark, index: number): void {
  const before = listBookmarks();
  const next = restoreIn(before, b, index);
  if (next.length !== before.length) commit(next);
}

export function renameBookmark(id: string, title: string): void {
  commit(renameIn(listBookmarks(), id, title));
}

export function moveBookmark(id: string, toIndex: number): void {
  commit(moveIn(listBookmarks(), id, toIndex));
}

export const isBookmarked = (url: string): boolean => isBookmarkedIn(listBookmarks(), url);

/** Removes a page by address (the page menu's "Remove bookmark"). Returns the removal for Undo. */
export function removeBookmarkByUrl(url: string): { bookmark: Bookmark; index: number } | null {
  const b = findBookmark(listBookmarks(), url);
  return b ? removeBookmark(b.id) : null;
}

/** Merges bookmarks from a backup into the list. Returns how many were added; screens refresh through the usual listeners. */
export function importBookmarks(incoming: unknown): number {
  const before = listBookmarks();
  const next = mergeBookmarks(before, incoming);
  if (next.length === before.length) return 0;
  commit(next);
  return next.length - before.length;
}

export function subscribeBookmarks(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useBookmarks(): Bookmark[] {
  return useSyncExternalStore(subscribeBookmarks, listBookmarks, listBookmarks);
}

/** Test hook: forget the in-memory copy so the next read goes to the kv store. */
export function resetBookmarksCache(): void {
  cache = null;
}
