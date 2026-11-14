/**
 * Matches found files against Transfers, and sums the running downloads for the footer chip.
 * Pure: no React, no native modules.
 *
 * The downloads snapshot carries `urlDisplay` only: scheme, host and path, never the query (NATIVE_CONTRACT 17).
 * So a link is compared on those three parts, with the lower-casing and fragment rules of the native
 * `FoundClassifier.normalize` (24.3). A row whose link has a query (other than `range` or `bytes`, which the
 * native dedupe drops) is never matched: two files can differ only by `?id=`, and a wrong "In Transfers" is worse
 * than none.
 */
import type { DownloadSnapshot } from '../../modules/maglev-engine/src/MaglevEngine.types';
import type { FoundItem } from '../../modules/maglev-engine/src/MaglevBrowser';
import { foundTray } from '../../constants/copy.ts';

const URL_RE = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const DROPPED = new Set(['range', 'bytes']);

function parts(url: string | null | undefined): { key: string; hasQuery: boolean } | null {
  const m = URL_RE.exec((url ?? '').trim());
  if (!m) return null;
  const authority = m[2];
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (!hostPort) return null;
  const query = (m[4] ?? '').replace(/^\?/, '');
  const kept = query.split('&').filter((p) => p && !DROPPED.has(p.split('=')[0].toLowerCase()));
  return { key: `${m[1].toLowerCase()}://${hostPort}${m[3] || '/'}`, hasQuery: kept.length > 0 };
}

/** scheme://host/path in lower case, no credentials, query or fragment. Null for anything but http and https. */
export function transferKey(url: string): string | null {
  return parts(url)?.key ?? null;
}

/** found item id to the id of the download that already has its link. Newest download wins. */
export function matchTransfers(
  items: readonly Pick<FoundItem, 'id' | 'url'>[],
  downloads: readonly Pick<DownloadSnapshot, 'id' | 'urlDisplay' | 'addedAt'>[],
): Map<string, string> {
  const out = new Map<string, string>();
  if (downloads.length === 0) return out;
  const byKey = new Map<string, { id: string; addedAt: number }>();
  for (const d of downloads) {
    const key = transferKey(d.urlDisplay);
    if (!key) continue;
    const have = byKey.get(key);
    if (!have || d.addedAt >= have.addedAt) byKey.set(key, { id: d.id, addedAt: d.addedAt });
  }
  for (const item of items) {
    const p = parts(item.url);
    if (!p || p.hasQuery) continue;
    const hit = byKey.get(p.key);
    if (hit) out.set(item.id, hit.id);
  }
  return out;
}

export interface ActiveSummary {
  count: number;
  /** Whole percent over all running downloads, or null when any of them has no size yet. */
  percent: number | null;
}

/** The downloads that are moving bytes now, or null when none are. */
export function activeSummary(downloads: readonly Pick<DownloadSnapshot, 'state' | 'size' | 'downloaded'>[]): ActiveSummary | null {
  const active = downloads.filter((d) => d.state === 'downloading');
  if (active.length === 0) return null;
  let size = 0;
  let done = 0;
  for (const d of active) {
    if (d.size == null || !(d.size > 0)) return { count: active.length, percent: null };
    size += d.size;
    done += d.downloaded;
  }
  return { count: active.length, percent: Math.max(0, Math.min(100, Math.floor((done / size) * 100))) };
}

export function activeLabel(s: ActiveSummary): string {
  return s.percent == null ? foundTray.downloading(s.count) : `${foundTray.downloading(s.count)} · ${s.percent}%`;
}
