import { useSyncExternalStore } from 'react';

/**
 * Count of new (unseen) feed items, shared between the Feeds screen (which knows the live
 * answer) and the tab bar (which shows it). Kept free of storage imports so it is easy to test.
 */
let count = 0;
const listeners = new Set<() => void>();

export function getFeedsNewCount(): number {
  return count;
}

export function setFeedsNewCount(n: number): void {
  const next = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (next === count) return;
  count = next;
  listeners.forEach((l) => l());
}

export function subscribeFeedsNewCount(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFeedsNewCount(): number {
  return useSyncExternalStore(subscribeFeedsNewCount, getFeedsNewCount, getFeedsNewCount);
}

/** New items from stored data only (no network): ids last seen in each feed that the user has not seen. */
export function countNewFromStored(
  feeds: readonly { id: string }[],
  ids: Record<string, string[]>,
  seen: Record<string, string[]>,
): number {
  let n = 0;
  for (const f of feeds) {
    const known = new Set(seen[f.id] ?? []);
    n += (ids[f.id] ?? []).filter((id) => !known.has(id)).length;
  }
  return n;
}

/** Text inside the tab badge: hidden at 0, capped at "99+". */
export function badgeLabel(n: number): string | null {
  if (!(n > 0)) return null;
  return n > 99 ? '99+' : String(Math.floor(n));
}
