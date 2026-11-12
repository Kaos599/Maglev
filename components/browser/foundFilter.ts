/**
 * Pure logic for the found-files tray (docs/NATIVE_CONTRACT.md section 24.3): merge, count, filter, sort.
 * Items arrive in the order they were found, so a higher index is newer.
 */
import type { FoundItem, FoundKind } from '../../modules/maglev-engine/src/MaglevBrowser';

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
