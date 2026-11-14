/**
 * Dismissed files for the browser's found list (docs/NATIVE_CONTRACT.md 24.6a). Remove and Clear only hide ids
 * on the screen. The view keeps its tracker, so a player that asks for the same file again does not bring it back.
 * Undo and "Scan again" empty the set. Every helper returns a new Set.
 */
import type { FoundItem } from '../../modules/maglev-engine/src/MaglevBrowser';
import { hideVariantPlaylists } from './foundFilter.ts';

/** What the tray lists: variant playlists folded away first, then the dismissed ids hidden. */
export function visibleFound(items: readonly FoundItem[], dismissed: ReadonlySet<string>): FoundItem[] {
  const base = hideVariantPlaylists(items);
  return dismissed.size === 0 ? base : base.filter((i) => !dismissed.has(i.id));
}

/** Hides `ids`. `added` is only the ones that were not hidden before, so Undo restores exactly those. */
export function dismissIds(
  dismissed: ReadonlySet<string>,
  _visible: readonly FoundItem[],
  ids: readonly string[],
): { next: Set<string>; added: string[] } {
  const next = new Set(dismissed);
  const added: string[] = [];
  for (const id of ids) {
    if (next.has(id)) continue;
    next.add(id);
    added.push(id);
  }
  return { next, added };
}

/** Clear: hides every row the tray lists now. */
export function dismissAllVisible(dismissed: ReadonlySet<string>, visible: readonly FoundItem[]) {
  return dismissIds(dismissed, visible, visible.map((i) => i.id));
}

/** Undo: shows `ids` again. */
export function restoreIds(dismissed: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(dismissed);
  for (const id of ids) next.delete(id);
  return next;
}
