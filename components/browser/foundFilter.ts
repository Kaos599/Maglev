/**
 * Pure logic for the found-files tray (docs/NATIVE_CONTRACT.md section 24.3): merge, count, filter, sort.
 * Items arrive in the order they were found, so a higher index is newer.
 */
import type { FoundItem, FoundKind } from '../../modules/maglev-engine/src/MaglevBrowser';
import { formatBytes } from '../../constants/format.ts';

export type FoundFilter = 'all' | FoundKind;

export const FILTER_ORDER: readonly FoundFilter[] = ['all', 'video', 'audio', 'image', 'document', 'other'];
export const FILTER_LABEL: Record<FoundFilter, string> = {
  all: 'All',
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  document: 'Document',
  other: 'Other',
};

export const MAX_FOUND = 500;
const INSTALLER_EXT = new Set(['apk', 'exe', 'msi', 'dmg', 'bat', 'cmd', 'scr']);

/** Adds new items to the list (newest last), skipping ids already there, keeping the newest MAX_FOUND. */
export function mergeFound(existing: readonly FoundItem[], incoming: readonly FoundItem[]): FoundItem[] {
  const seen = new Set(existing.map((i) => i.id));
  const next = [...existing];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    next.push(item);
  }
  return next.length > MAX_FOUND ? next.slice(next.length - MAX_FOUND) : next;
}

export function countByKind(items: readonly FoundItem[]): Record<FoundFilter, number> {
  const counts: Record<FoundFilter, number> = { all: items.length, video: 0, audio: 0, image: 0, document: 0, other: 0 };
  for (const i of items) counts[i.kind]++;
  return counts;
}

/** All, plus every kind that has at least one item. */
export function visibleFilters(counts: Record<FoundFilter, number>): FoundFilter[] {
  return FILTER_ORDER.filter((f) => f === 'all' || counts[f] > 0);
}

/** A filter with no items falls back to All. */
export function effectiveFilter(filter: FoundFilter, counts: Record<FoundFilter, number>): FoundFilter {
  return filter === 'all' || counts[filter] > 0 ? filter : 'all';
}

/** Filters and orders for display. Video: biggest first, then newest. Everything else: newest first. */
export function sortFound(items: readonly FoundItem[], filter: FoundFilter): FoundItem[] {
  const indexed = items.map((item, index) => ({ item, index })).filter((x) => filter === 'all' || x.item.kind === filter);
  indexed.sort((a, b) => {
    if (filter === 'video') {
      const sa = a.item.size ?? -1;
      const sb = b.item.size ?? -1;
      if (sa !== sb) return sb - sa;
    }
    return b.index - a.index;
  });
  return indexed.map((x) => x.item);
}

export function isInstaller(item: Pick<FoundItem, 'ext' | 'name'>): boolean {
  const ext = (item.ext ?? /\.([A-Za-z0-9]+)$/.exec(item.name)?.[1] ?? '').toLowerCase();
  return INSTALLER_EXT.has(ext);
}

export function streamTag(item: Pick<FoundItem, 'stream'>): 'HLS' | 'DASH' | null {
  return item.stream === 'hls' ? 'HLS' : item.stream === 'dash' ? 'DASH' : null;
}

function hlsParts(url: string): { origin: string; dir: string; path: string } | null {
  const m = /^(https?:\/\/[^/?#]+)(\/[^?#]*)?/i.exec(url);
  if (!m) return null;
  const path = m[2] ?? '/';
  return { origin: m[1].toLowerCase(), dir: path.slice(0, path.lastIndexOf('/') + 1), path };
}

/**
 * Hides HLS media playlists that sit next to their master (section 24.8). The probe gives no variant addresses,
 * so this is address-based: an HLS playlist is hidden only when an EARLIER HLS playlist from the same page and
 * origin lives in the same folder or above it (a player asks for the master first, then the variants).
 * A lone HLS item is never hidden, the first one found always stays, and a playlist at the server root
 * hides nothing (it would otherwise cover every stream on that host).
 */
export function hideVariantPlaylists(items: readonly FoundItem[]): FoundItem[] {
  const keep: FoundItem[] = [];
  const masters: { pageUrl: string; origin: string; dir: string; path: string }[] = [];
  for (const item of items) {
    const hls = item.stream === 'hls' ? hlsParts(item.url) : null;
    if (!hls) {
      keep.push(item);
      continue;
    }
    const covered = masters.some((m) => m.dir !== '/' && m.pageUrl === item.pageUrl && m.origin === hls.origin && m.path !== hls.path && hls.dir.startsWith(m.dir));
    if (covered) continue;
    masters.push({ pageUrl: item.pageUrl, ...hls });
    keep.push(item);
  }
  return keep;
}

/** The list after Clear. */
export function clearFound(): FoundItem[] {
  return [];
}

/**
 * Removes one item. Variant playlists that were hidden behind it (hideVariantPlaylists) go too,
 * so removing a master does not make its variants appear.
 */
export function removeFound(items: readonly FoundItem[], id: string): FoundItem[] {
  const rest = items.filter((i) => i.id !== id);
  if (rest.length === items.length) return rest;
  const before = new Set(hideVariantPlaylists(items).map((i) => i.id));
  const after = hideVariantPlaylists(rest);
  return rest.filter((i) => before.has(i.id) || !after.includes(i));
}

function documentOf(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? url : url.slice(0, i);
}

/**
 * Keeps only the files found on the document now showing. A new address (a different path or query) is a new
 * document, a #fragment is not. An empty address or about:blank (the gap during a load) changes nothing.
 */
export function pruneToPage(items: readonly FoundItem[], pageUrl: string): FoundItem[] {
  if (!pageUrl || pageUrl.startsWith('about:')) return items as FoundItem[];
  const now = documentOf(pageUrl);
  const kept = items.filter((i) => documentOf(i.pageUrl) === now);
  return kept.length === items.length ? (items as FoundItem[]) : kept;
}

/** "5.2 MB", "~1.2 GB" for an estimate, "\u2014" when the size is not known. Never a made-up number. */
export function foundSizeLabel({ size, estimate = false }: { size?: number | null; estimate?: boolean }): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return '\u2014';
  return `${estimate ? '~' : ''}${formatBytes(size)}`;
}

/** The quality when known ("1080p"), else the type ("HLS", "MP4"), else null. */
export function foundDetail(item: Pick<FoundItem, 'stream' | 'height' | 'ext'>): string | null {
  if (item.height) return `${item.height}p`;
  const tag = streamTag(item);
  if (tag) return tag;
  const ext = item.ext?.replace(/^\./, '').trim();
  return ext ? ext.toUpperCase() : null;
}
