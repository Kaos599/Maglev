const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Total: anything that is not a positive finite number reads as "0 B". Fractions below 1 B round to 0 B. */
export function formatBytes(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 1) return '0 B';
  let i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0), BYTE_UNITS.length - 1);
  let val = bytes / Math.pow(1024, i);
  // A value that would print as 1024 of a unit reads as 1.0 of the next one ("1.0 GB", not "1024 MB").
  if (val >= 1023.5 && i < BYTE_UNITS.length - 1) {
    i += 1;
    val /= 1024;
  }
  // One decimal below 100 ("3.2 MB", "45.5 MB"); whole numbers from 100 up ("412 MB"), where a decimal is noise.
  return `${val.toFixed(i === 0 || val >= 99.95 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

/**
 * NATIVE_CONTRACT 45.2: the compact amount, "134/587 MB" when both sides format to the same unit and
 * "820 MB/2.1 GB" when they differ. `done` drops a trailing ".0". `approx` goes before the total ("~", a stream's estimate).
 */
export function formatCompactAmount(done: number, total: number, approx = ''): string {
  const d = formatBytes(done);
  const t = formatBytes(total);
  const [dNum, dUnit] = d.split(' ');
  const [, tUnit] = t.split(' ');
  const num = dNum.replace(/\.0$/, '');
  return dUnit === tUnit ? `${num}/${approx}${t}` : `${num} ${dUnit}/${approx}${t}`;
}

/**
 * A speed in 7-9 characters: 3 significant digits ("2.00 MB/s", "62.5 MB/s", "125 MB/s"), and the unit moves up at
 * 1000 rather than 1024 ("0.98 MB/s", never "1000 KB/s"). The status line keeps a 9-character slot for it, so the
 * amount beside it never shifts and never floats away from it (owner pick 2026-11-20). Bytes per second stay whole.
 */
export function formatSpeed(bytesPerSec: number): string {
  const b = typeof bytesPerSec === 'number' && Number.isFinite(bytesPerSec) && bytesPerSec >= 1 ? bytesPerSec : 0;
  let i = 0;
  let val = b;
  while (i < BYTE_UNITS.length - 1 && Number(val.toFixed(0)) >= 1000) {
    i += 1;
    val /= 1024;
  }
  if (i === 0) return `${Math.round(val)} B/s`;
  // Round first, then pick the decimals from the rounded value, so 9.996 reads "10.0" and 99.96 reads "100".
  const two = val.toFixed(2);
  const one = val.toFixed(1);
  const shown = Number(two) < 10 ? two : Number(one) < 100 ? one : val.toFixed(0);
  return `${shown} ${BYTE_UNITS[i]}/s`;
}

/** The torrent page's progress text: one decimal, "42.0%". Takes a fraction from 0 to 1. */
export function formatProgressPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}
