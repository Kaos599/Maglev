/** Whether the Settings "More below" pill has been dismissed. Persisted once, never shown again. */
import { kvGet, kvSet } from './kv.ts';

export const MORE_HINT_KEY = 'maglev.settings.moreHintSeen.v1';

let seen: boolean | null = null;

export function getMoreHintSeen(): boolean {
  if (seen !== null) return seen;
  try {
    seen = kvGet(MORE_HINT_KEY) === '1';
  } catch {
    seen = false;
  }
  return seen;
}

export function markMoreHintSeen(): void {
  seen = true;
  try {
    kvSet(MORE_HINT_KEY, '1');
  } catch {
    // Kept in memory for this session.
  }
}

/** True when the scroll position is within `slack` px of the end (or the content does not overflow). */
export function nearEnd(offsetY: number, viewportH: number, contentH: number, slack = 24): boolean {
  return contentH - viewportH - offsetY <= slack;
}
