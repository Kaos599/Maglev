import { normalizeUrl, type Bookmark } from '../../utils/browser/bookmarks';

/** Most bookmarks shown above the history results. */
export const MAX_BOOKMARK_SUGGESTIONS = 3;

export interface Suggestion {
  kind: 'bookmark' | 'history';
  url: string;
  title: string;
  host: string;
}

type HistoryLike = { url: string; title: string; host: string };

/**
 * Up to 3 matching bookmarks first, then the history results, minus any address already shown as a bookmark
 * (compared by the bookmark store's normalised address).
 */
export function mergeSuggestions(bookmarks: readonly Bookmark[], history: readonly HistoryLike[]): Suggestion[] {
  const top = bookmarks.slice(0, MAX_BOOKMARK_SUGGESTIONS);
  const seen = new Set(top.map((b) => normalizeUrl(b.url)));
  const rows: Suggestion[] = top.map((b) => ({ kind: 'bookmark', url: b.url, title: b.title, host: b.host }));
  for (const h of history) {
    if (seen.has(normalizeUrl(h.url))) continue;
    rows.push({ kind: 'history', url: h.url, title: h.title, host: h.host });
  }
  return rows;
}
