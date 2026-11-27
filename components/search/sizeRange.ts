/** Size range for Search results. Pure, no React Native, so tests run it directly. */

const KB = 1024;
const MB = KB ** 2;
const GB = KB ** 3;
const TB = KB ** 4;

/** The size filter in use, in bytes. A missing side means no limit on it. */
export interface SizeFilter {
  minBytes?: number;
  maxBytes?: number;
}

export type SizeUnit = 'KB' | 'MB' | 'GB' | 'TB';
export const SIZE_UNITS: readonly SizeUnit[] = ['KB', 'MB', 'GB', 'TB'];
const UNIT_BYTES: Record<SizeUnit, number> = { KB, MB, GB, TB };

/** The largest size a field takes: 1024 TB. */
export const MAX_FIELD_BYTES = 1024 * TB;

/** Slider stops in binary bytes. Index 0 is "no minimum", the last index is "no maximum". */
export const SIZE_STOPS: number[] = [0, 50 * MB, 100 * MB, 250 * MB, 500 * MB, GB, 2 * GB, 4 * GB, 8 * GB, 16 * GB, 32 * GB, 64 * GB, Infinity];

const LAST = SIZE_STOPS.length - 1;

/** "Any" at both ends, otherwise "50 MB", "1 GB", "64 GB". */
export function stopLabel(idx: number): string {
  if (idx <= 0 || idx >= LAST) return 'Any';
  const b = SIZE_STOPS[idx];
  return b >= GB ? `${b / GB} GB` : `${b / MB} MB`;
}

/** Keeps both indices inside the stops and at least one stop apart. */
export function clampRange(minIdx: number, maxIdx: number): { low: number; high: number } {
  let low = Math.min(Math.max(Math.round(minIdx), 0), LAST - 1);
  let high = Math.min(Math.max(Math.round(maxIdx), 1), LAST);
  if (high <= low) high = Math.min(low + 1, LAST);
  if (high <= low) low = high - 1;
  return { low, high };
}

/** The filter for two stops. Index 0 has no minimum and the last index has no maximum. */
export function toFilter(minIdx: number, maxIdx: number): SizeFilter {
  const out: SizeFilter = {};
  if (minIdx > 0) out.minBytes = SIZE_STOPS[minIdx];
  if (maxIdx < LAST) out.maxBytes = SIZE_STOPS[maxIdx];
  return out;
}

/** True when either side has a limit. */
export function hasSizeFilter(f: SizeFilter): boolean {
  return (f.minBytes !== undefined && f.minBytes > 0) || f.maxBytes !== undefined;
}

function nearestStop(bytes: number, from: number, to: number): number {
  let best = from;
  for (let i = from; i <= to; i++) {
    if (Math.abs(SIZE_STOPS[i] - bytes) < Math.abs(SIZE_STOPS[best] - bytes)) best = i;
  }
  return best;
}

/** Where the slider thumbs sit for a filter: the nearest stop to each side. A custom size sits on a stop beside it. */
export function stopsFor(f: SizeFilter): { low: number; high: number } {
  const low = f.minBytes && f.minBytes > 0 ? nearestStop(f.minBytes, 0, LAST - 1) : 0;
  const high = f.maxBytes !== undefined ? nearestStop(f.maxBytes, 1, LAST - 1) : LAST;
  return clampRange(low, high);
}

/** The biggest unit that keeps the number at 1 or more, or KB for anything smaller. */
export function unitFor(bytes: number): SizeUnit {
  for (let i = SIZE_UNITS.length - 1; i > 0; i--) if (bytes >= UNIT_BYTES[SIZE_UNITS[i]]) return SIZE_UNITS[i];
  return 'KB';
}

function trimmed(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}

function amount(bytes: number, unit: SizeUnit): string {
  const n = bytes / UNIT_BYTES[unit];
  const s = trimmed(n, 2);
  return s === '0' ? trimmed(n, 4) : s;
}

/** "Any size", "Over 700 MB", "Under 2 GB", "1.5–4 GB" or "700 MB–1.5 TB". */
export function sizeLabel(f: SizeFilter): string {
  const min = f.minBytes && f.minBytes > 0 ? f.minBytes : undefined;
  const max = f.maxBytes;
  const part = (b: number) => `${amount(b, unitFor(b))} ${unitFor(b)}`;
  if (min === undefined && max === undefined) return 'Any size';
  if (max === undefined) return `Over ${part(min as number)}`;
  if (min === undefined) return `Under ${part(max)}`;
  const u = unitFor(min);
  if (u === unitFor(max)) return `${amount(min, u)}–${amount(max, u)} ${u}`;
  return `${part(min)}–${part(max)}`;
}

/** What one size field holds: nothing, a size in bytes, text that is not a number, or more than the cap. */
export type FieldRead = { kind: 'empty' } | { kind: 'bytes'; bytes: number } | { kind: 'bad' } | { kind: 'over' };

/** Reads field text in a unit. A comma counts as the decimal point; a second separator, a sign or a letter is bad. */
export function readSize(text: string, unit: SizeUnit): FieldRead {
  const t = text.trim();
  if (!t) return { kind: 'empty' };
  if (!/^[0-9]*[.,]?[0-9]*$/.test(t) || !/[0-9]/.test(t)) return { kind: 'bad' };
  const bytes = Math.round(Number(t.replace(',', '.')) * UNIT_BYTES[unit]);
  if (!Number.isFinite(bytes) || bytes > MAX_FIELD_BYTES) return { kind: 'over' };
  return { kind: 'bytes', bytes };
}

export type SizeFieldError = 'bad' | 'over' | 'zero' | 'order';

export interface CustomSizeCheck {
  minError?: SizeFieldError;
  maxError?: SizeFieldError;
  /** Set only when both fields are fine. */
  filter?: SizeFilter;
}

/**
 * Checks the two fields. An empty field is no limit, a smallest of 0 is no minimum, a largest of 0 is an
 * error, and the order is checked on the final whole bytes, after rounding.
 */
export function checkCustomSize(min: FieldRead, max: FieldRead): CustomSizeCheck {
  const out: CustomSizeCheck = {};
  if (min.kind === 'bad' || min.kind === 'over') out.minError = min.kind;
  if (max.kind === 'bad' || max.kind === 'over') out.maxError = max.kind;
  else if (max.kind === 'bytes' && max.bytes < 1) out.maxError = 'zero';
  if (out.minError || out.maxError) return out;
  const minBytes = min.kind === 'bytes' && min.bytes > 0 ? min.bytes : undefined;
  const maxBytes = max.kind === 'bytes' ? max.bytes : undefined;
  if (minBytes !== undefined && maxBytes !== undefined && minBytes >= maxBytes) return { maxError: 'order' };
  const filter: SizeFilter = {};
  if (minBytes !== undefined) filter.minBytes = minBytes;
  if (maxBytes !== undefined) filter.maxBytes = maxBytes;
  return { filter };
}

/** Field text and unit for a size: the biggest unit that keeps the number at 1 or more, with enough decimals to read back as the same bytes. */
export function fieldFor(bytes: number | undefined, emptyUnit: SizeUnit): { text: string; unit: SizeUnit } {
  if (bytes === undefined || bytes <= 0) return { text: '', unit: emptyUnit };
  const unit = unitFor(bytes);
  const per = UNIT_BYTES[unit];
  for (let d = 0; d <= 12; d++) {
    const s = trimmed(bytes / per, d);
    if (Math.round(Number(s) * per) === bytes) return { text: s, unit };
  }
  return { text: String(bytes / per), unit };
}
