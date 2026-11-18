/** Size range for Search results. Pure, no React Native, so tests run it directly. */

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** Slider stops in binary bytes. Index 0 is "no minimum", the last index is "no maximum". */
export const SIZE_STOPS: number[] = [0, 50 * MB, 100 * MB, 250 * MB, 500 * MB, GB, 2 * GB, 4 * GB, 8 * GB, 16 * GB, 32 * GB, 64 * GB, Infinity];

const LAST = SIZE_STOPS.length - 1;

/** "Any" at both ends, otherwise "50 MB", "1 GB", "64 GB". */
export function stopLabel(idx: number): string {
  if (idx <= 0 || idx >= LAST) return 'Any';
  const b = SIZE_STOPS[idx];
  return b >= GB ? `${b / GB} GB` : `${b / MB} MB`;
}

/** "Any size", "Over 1 GB", "Up to 8 GB" or "1 GB – 8 GB". */
export function rangeLabel(minIdx: number, maxIdx: number): string {
  const noMin = minIdx <= 0;
  const noMax = maxIdx >= LAST;
  if (noMin && noMax) return 'Any size';
  if (noMax) return `Over ${stopLabel(minIdx)}`;
  if (noMin) return `Up to ${stopLabel(maxIdx)}`;
  return `${stopLabel(minIdx)} – ${stopLabel(maxIdx)}`;
}

/** Keeps both indices inside the stops and at least one stop apart. */
export function clampRange(minIdx: number, maxIdx: number): { low: number; high: number } {
  let low = Math.min(Math.max(Math.round(minIdx), 0), LAST - 1);
  let high = Math.min(Math.max(Math.round(maxIdx), 1), LAST);
  if (high <= low) high = Math.min(low + 1, LAST);
  if (high <= low) low = high - 1;
  return { low, high };
}

/** The filter values for a range. An open top end has no maximum. */
export function toFilter(minIdx: number, maxIdx: number): { minBytes: number; maxBytes: number | undefined } {
  return { minBytes: SIZE_STOPS[minIdx], maxBytes: maxIdx >= LAST ? undefined : SIZE_STOPS[maxIdx] };
}
