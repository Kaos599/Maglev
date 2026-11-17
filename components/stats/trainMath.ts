/**
 * The train as the day cursor, in scene units (the same units the city is drawn in). Pure.
 * `L` is the city layout: x0 (first building's left), bw (building width), pitch (distance between buildings).
 * Days are indices into the range's buckets; `lo` is the first reachable one (the first stats day), `hi` the last built one.
 */
export interface Pitch {
  x0: number;
  bw: number;
  pitch: number;
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** The horizontal centre of building `i`. */
export const centreOf = (L: Pitch, i: number): number => L.x0 + i * L.pitch + L.bw / 2;

/** The day under x, rounded to the nearest building and held between `lo` and `hi` (past `hi` the track ends: the buffer stop). */
export function snapIndex(x: number, L: Pitch, lo: number, hi: number): number {
  const top = Math.max(lo, hi);
  return clamp(Math.round((x - L.x0 - L.bw / 2) / L.pitch), lo, top);
}

/** Where the train's centre is while a finger is at x: it follows the finger, but never leaves the first to the last day. */
export function trainCentre(x: number, L: Pitch, lo: number, hi: number): number {
  const top = Math.max(lo, hi);
  return clamp(x, centreOf(L, lo), centreOf(L, top));
}

/** The cursor position: the finger's (held between the first and last day), or a whole day at a time with Reduce motion. */
export function cursorAt(x: number, L: Pitch, lo: number, hi: number, wholeDays: boolean): number {
  return wholeDays ? centreOf(L, snapIndex(x, L, lo, hi)) : trainCentre(x, L, lo, hi);
}

/** The last bucket that is not in the future (today in the current range, the last bucket in a finished one). -1 when none. */
export function lastBuilt(buckets: readonly { future: boolean }[]): number {
  for (let i = buckets.length - 1; i >= 0; i--) if (!buckets[i].future) return i;
  return -1;
}

/** The days the opening run passes under, Monday (or the first reachable day) to today. */
export function runStops(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

/** When (ms into the run) building `i` starts to rise: as the train reaches it. */
export function riseStart(i: number, last: number, runMs: number): number {
  return last <= 0 ? 0 : Math.round((runMs * Math.max(0, Math.min(i, last))) / last);
}

/** Wagons on the train: one per finished download, never more than `cap` (then one wagon stands for several). */
export function wagonCount(finished: number, cap: number): number {
  return finished <= 0 ? 0 : Math.min(cap, finished);
}
