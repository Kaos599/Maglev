/** Copied-link prompt prefs: the on/off setting and the last text the user answered "Not now" to. */
import { useSyncExternalStore } from 'react';
import { kvGet, kvSet } from './kv.ts';

const CATCH_KEY = 'maglev.clipboard.catch.v1';
export const DISMISSED_CLIP_KEY = 'maglev.clipboard.dismissed.v1';

const listeners = new Set<() => void>();
let catchCache: boolean | null = null;

/** On unless the user turned it off. */
export function getCatchCopiedLinks(): boolean {
  if (catchCache !== null) return catchCache;
  try {
    catchCache = kvGet(CATCH_KEY) !== '0';
  } catch {
    catchCache = true;
  }
  return catchCache;
}

export function setCatchCopiedLinks(on: boolean): void {
  catchCache = on;
  try {
    kvSet(CATCH_KEY, on ? '1' : '0');
  } catch {
    // Kept in memory for this session.
  }
  listeners.forEach((l) => l());
}

export function useCatchCopiedLinks(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getCatchCopiedLinks,
    getCatchCopiedLinks,
  );
  return [on, setCatchCopiedLinks];
}

let dismissed: string | null | undefined;

function readDismissed(): string | null {
  if (dismissed !== undefined) return dismissed;
  try {
    dismissed = kvGet(DISMISSED_CLIP_KEY);
  } catch {
    dismissed = null;
  }
  return dismissed;
}

/** "Not now": remembers this text (one entry) so it is not offered again, also after a restart. */
export function dismissClip(text: string): void {
  dismissed = text.trim();
  try {
    kvSet(DISMISSED_CLIP_KEY, dismissed);
  } catch {
    // Kept in memory for this session.
  }
}

export function isDismissedClip(text: string): boolean {
  const saved = readDismissed();
  return saved !== null && saved !== '' && saved === text.trim();
}
