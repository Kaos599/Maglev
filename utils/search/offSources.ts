// NATIVE_CONTRACT 45.5: when a search finds nothing, count the sources that are off and could have answered. Pure:
// settings and provider lists only, nothing is fetched.
import type { Category } from './types';

/** The part of a provider the count needs. Built-ins and Torznab entries both fit. */
export interface OffSourceInfo {
  id: string;
  nsfw?: boolean;
  categories?: readonly Category[];
  /** Turned off by the source list: the user can't switch it on, so it doesn't count. */
  turnedOff?: unknown;
}

const isAdult = (p: OffSourceInfo): boolean =>
  !!p.nsfw || (!!p.categories && p.categories.length > 0 && p.categories.every((c) => c === 'adult'));

/** Sources that are off, can be turned on, and are not adult while adult results are off. */
export function countOffSources(providers: readonly OffSourceInfo[], enabled: readonly string[], adult: boolean): number {
  const on = new Set(enabled);
  const seen = new Set<string>();
  let k = 0;
  for (const p of providers) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    if (on.has(p.id) || p.turnedOff) continue;
    if (isAdult(p) && !adult) continue;
    k++;
  }
  return k;
}
