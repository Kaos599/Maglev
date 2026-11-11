/**
 * Steady speed and time-left helpers (docs/UI_SPEC_PHASE2.md S10.2).
 * Pure functions with no imports so Node can run them directly in tests.
 */

/** Time constant of the speed moving average. */
export const TAU_MS = 5000;
/** A longer gap between samples (app was in the background) resets the average. */
export const RESET_GAP_MS = 15_000;
/** Below this rate the time left is unknown. */
export const MIN_ETA_BPS = 1024;

/** Exponential moving average of a rate. `prev` is null for the first sample. */
export function smoothRate(prev: number | null | undefined, sample: number, dtMs: number): number {
  const s = Number.isFinite(sample) && sample > 0 ? sample : 0;
  if (prev == null || !Number.isFinite(prev) || dtMs > RESET_GAP_MS) return s;
  if (dtMs <= 0) return prev;
  const alpha = 1 - Math.exp(-dtMs / TAU_MS);
  return prev + alpha * (s - prev);
}

/** Seconds left, or -1 when the rate is under 1 KB/s. */
export function etaSecs(remainingBytes: number, smoothedBps: number): number {
  if (!Number.isFinite(smoothedBps) || smoothedBps < MIN_ETA_BPS) return -1;
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return 0;
  return Math.ceil(remainingBytes / smoothedBps);
}

const UNKNOWN = '—';
const UNDER_MINUTE = 'under a minute';
const OVER_DAY = 'over a day';
const DAY = 86_400;

type Band = 'under' | 'min' | 'hour' | 'day';

function bandOf(secs: number): Band {
  if (secs < 60) return 'under';
  if (secs < 59.5 * 60) return 'min';
  if (secs < DAY) return 'hour';
  return 'day';
}

function labelFor(secs: number): string {
  switch (bandOf(secs)) {
    case 'under':
      return UNDER_MINUTE;
    case 'min':
      return `${Math.max(1, Math.round(secs / 60))} min`;
    case 'hour': {
      const total = Math.min(24 * 60 - 5, Math.round(secs / 300) * 5);
      const h = Math.floor(total / 60);
      const m = total % 60;
      return m === 0 ? `${h} h` : `${h} h ${m} min`;
    }
    default:
      return OVER_DAY;
  }
}

/** The number of seconds a label stands for. NaN for the unknown dash. */
export function etaLabelSecs(label: string): number {
  if (label === UNDER_MINUTE) return 30;
  if (label === OVER_DAY) return DAY;
  const hm = /^(\d+) h(?: (\d+) min)?$/.exec(label);
  if (hm) return Number(hm[1]) * 3600 + Number(hm[2] ?? 0) * 60;
  const m = /^(\d+) min$/.exec(label);
  if (m) return Number(m[1]) * 60;
  return NaN;
}

/**
 * Time-left label in coarse steps. Pass the label shown last time: it is kept
 * while the new value is within 10% of what it stands for and in the same step.
 */
export function formatEta(secs: number, prevLabel: string | null | undefined): string {
  if (!Number.isFinite(secs) || secs < 0) return UNKNOWN;
  const next = labelFor(secs);
  if (!prevLabel || prevLabel === next) return next;
  const prevSecs = etaLabelSecs(prevLabel);
  if (!Number.isFinite(prevSecs)) return next;
  if (bandOf(prevSecs) !== bandOf(secs)) return next;
  return Math.abs(secs - prevSecs) <= prevSecs * 0.1 ? prevLabel : next;
}
