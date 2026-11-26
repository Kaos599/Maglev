/**
 * The blocked pop-ups log. One kv blob, separate from the browser prefs and left
 * out of backups (utils/backup/format.ts exports only the keys it lists). Pure functions here; `loadPopupLog` and
 * `savePopupLog` are the only parts that touch the kv store. Nothing is recorded in Private browsing.
 */
import { kvGet, kvSet } from '../prefs/kv.ts';
import { normalizeSiteHost } from './popups.ts';

export const POPUP_LOG_KEY = 'maglev.browser.popupLog.v1';
/** Newest items kept per site. */
export const POPUP_LOG_ITEMS_PER_SITE = 20;
/** Sites kept; the one with the oldest `last` goes first. */
export const POPUP_LOG_MAX_SITES = 500;
/** Items older than this are dropped on load and on every write. */
export const POPUP_LOG_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export type PopupLogItem = { url: string; kind: string; at: number };
export type PopupLogSite = { blocked: number; last: number; items: PopupLogItem[] };
/** Keyed by the page's site host in normalised form (see normalizeSiteHost). */
export type PopupLog = Record<string, PopupLogSite>;

export type PopupLogEntry = { sourceUrl: string; url: string; kind: string; at: number };

/** Drops items older than 90 days (relative to `now`), then sites with no items left, then the oldest sites over the cap. */
export function prunePopupLog(log: PopupLog, now: number): PopupLog {
  const cutoff = now - POPUP_LOG_MAX_AGE_MS;
  const kept: [string, PopupLogSite][] = [];
  for (const [host, site] of Object.entries(log)) {
    const items = site.items.filter((i) => i.at >= cutoff).slice(0, POPUP_LOG_ITEMS_PER_SITE);
    if (items.length === 0) continue;
    kept.push([host, { blocked: site.blocked, last: Math.max(...items.map((i) => i.at)), items }]);
  }
  kept.sort((a, b) => b[1].last - a[1].last);
  return Object.fromEntries(kept.slice(0, POPUP_LOG_MAX_SITES));
}

/** Tolerant parse of the stored blob: bad fields are dropped, never thrown. */
export function parsePopupLog(raw: unknown, now: number): PopupLog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PopupLog = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const host = normalizeSiteHost(key);
    if (!host || !value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const items: PopupLogItem[] = Array.isArray(v.items)
      ? v.items
          .filter((i): i is PopupLogItem => !!i && typeof i === 'object' && typeof (i as PopupLogItem).url === 'string' && typeof (i as PopupLogItem).kind === 'string' && Number.isFinite((i as PopupLogItem).at))
          .map((i) => ({ url: i.url, kind: i.kind, at: i.at }))
      : [];
    const blocked = typeof v.blocked === 'number' && Number.isFinite(v.blocked) && v.blocked >= 0 ? Math.floor(v.blocked) : 0;
    const last = typeof v.last === 'number' && Number.isFinite(v.last) ? v.last : 0;
    out[host] = mergeSite(out[host], { blocked, last, items: items.sort((a, b) => b.at - a.at) });
  }
  return prunePopupLog(out, now);
}

/** Two entries for one host (for example `m.site.com` and `site.com`) become one. */
function mergeSite(a: PopupLogSite | undefined, b: PopupLogSite): PopupLogSite {
  if (!a) return b;
  return { blocked: a.blocked + b.blocked, last: Math.max(a.last, b.last), items: [...a.items, ...b.items].sort((x, y) => y.at - x.at) };
}

/**
 * Records one blocked pop-up. A no-op in Private browsing (returns the same log). `now` is the prune time; it defaults
 * to the entry's time.
 */
export function recordPopupBlock(log: PopupLog, entry: PopupLogEntry, opts: { privateMode: boolean; now?: number }): PopupLog {
  if (opts.privateMode) return log;
  const host = normalizeSiteHost(entry.sourceUrl);
  if (!host) return log;
  const cur = log[host] ?? { blocked: 0, last: 0, items: [] };
  const item: PopupLogItem = { url: entry.url, kind: entry.kind, at: entry.at };
  const site: PopupLogSite = {
    blocked: cur.blocked + 1,
    last: Math.max(cur.last, entry.at),
    items: [item, ...cur.items].sort((a, b) => b.at - a.at).slice(0, POPUP_LOG_ITEMS_PER_SITE),
  };
  return prunePopupLog({ ...log, [host]: site }, opts.now ?? entry.at);
}

/** Clear log for one site: the site and its links go, the block and allow lists are not touched. */
export function clearPopupSite(log: PopupLog, host: string): PopupLog {
  const h = normalizeSiteHost(host);
  const { [h]: _gone, ...rest } = log;
  return rest;
}

/** One row of the Blocked pop-ups list. `listed` is true when the site is in the block list. */
export type BlockedSiteRow = { host: string; blocked: number; last: number | null; listed: boolean };

/**
 * The sites for the Blocked pop-ups list: every host in the block list or the log, newest first. A listed site with no
 * log yet has `last: null` and sorts after the sites with a time (by host).
 */
export function blockedSiteRows(blockHosts: readonly string[], log: PopupLog): BlockedSiteRow[] {
  const listed = new Set(blockHosts.map(normalizeSiteHost).filter(Boolean));
  const hosts = new Set<string>([...listed, ...Object.keys(log)]);
  const rows: BlockedSiteRow[] = [...hosts].map((host) => {
    const site = log[host];
    return { host, blocked: site?.blocked ?? 0, last: site ? site.last : null, listed: listed.has(host) };
  });
  return rows.sort((a, b) => (b.last ?? -Infinity) - (a.last ?? -Infinity) || a.host.localeCompare(b.host));
}

/** Loads the log from the kv store, pruned. Unreadable data gives an empty log. */
export function loadPopupLog(now: number = Date.now()): PopupLog {
  try {
    const raw = kvGet(POPUP_LOG_KEY);
    return parsePopupLog(raw ? JSON.parse(raw) : null, now);
  } catch {
    return {};
  }
}

/** Saves the log, pruned. A failed write is ignored: the log is a convenience, not a record. */
export function savePopupLog(log: PopupLog, now: number = Date.now()): void {
  try {
    kvSet(POPUP_LOG_KEY, JSON.stringify(prunePopupLog(log, now)));
  } catch {
    // Kept for this session only.
  }
}

/** Load, record one block, save. Does nothing in Private browsing. Returns the log that was written. */
export function recordPopupBlockStored(entry: PopupLogEntry, privateMode: boolean, now: number = Date.now()): PopupLog {
  if (privateMode) return loadPopupLog(now);
  const next = recordPopupBlock(loadPopupLog(now), entry, { privateMode, now });
  savePopupLog(next, now);
  return next;
}
