/** Plain-words helpers for how many people share a result. No React, so tests run them directly. */

/** Zero or one person sharing: the download may never start or may crawl. */
export function isLowShare(seeders: number | undefined): boolean {
  return seeders !== undefined && seeders <= 1;
}

/** Short badge for a row, or null when the result is healthy or the source gives no counts. */
export function sharingBadge(seeders: number | undefined): string | null {
  if (seeders === undefined) return null;
  if (seeders === 0) return 'No one sharing';
  if (seeders === 1) return 'Only 1 sharing';
  return null;
}

/** "12 sharing, 3 downloading" for the preview and screen readers. */
export function sharingWords(seeders: number | undefined, leechers: number | undefined): string {
  if (seeders === undefined && leechers === undefined) return 'Sharing count unknown';
  const sharing = seeders === undefined ? 'Sharing count unknown' : seeders === 0 ? 'No one sharing' : `${seeders.toLocaleString('en-US')} sharing`;
  return leechers === undefined ? sharing : `${sharing}, ${leechers.toLocaleString('en-US')} downloading`;
}

export interface ResultFilter {
  hideDead: boolean;
  minBytes: number;
}

/** Unknown counts and sizes are never filtered out. */
export function passesResultFilter(r: { seeders?: number; sizeBytes?: number }, f: ResultFilter): boolean {
  if (f.hideDead && r.seeders === 0) return false;
  if (f.minBytes > 0 && r.sizeBytes !== undefined && r.sizeBytes < f.minBytes) return false;
  return true;
}
