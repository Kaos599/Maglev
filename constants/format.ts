const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Total: anything that is not a positive finite number reads as "0 B". Fractions below 1 B round to 0 B. */
export function formatBytes(bytes: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 1) return '0 B';
  const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0), BYTE_UNITS.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
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
