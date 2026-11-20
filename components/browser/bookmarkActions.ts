/** Remove and add with the app's notice, shared by the start page and the page menu toggle. */
import { bookmarkCopy } from '../../constants/bookmarkCopy';
import { addBookmark, removeBookmark, restoreBookmark } from '../../utils/browser/bookmarks';

/** The engine's `showNotice`, as far as bookmarks need it. */
export type ShowNotice = (next: { message: string; actionLabel?: string; onAction?: () => void }, autoDismissMs?: number | null) => void;

/** How long "Removed X. Undo" stays. Matches the History screen. */
export const BOOKMARK_UNDO_MS = 5000;

/** Removes a bookmark at once and offers Undo, which puts it back in the same place. */
export function removeWithUndo(id: string, showNotice: ShowNotice): void {
  const removed = removeBookmark(id);
  if (!removed) return;
  showNotice(
    {
      message: bookmarkCopy.notices.removed(removed.bookmark.title),
      actionLabel: bookmarkCopy.notices.undo,
      onAction: () => restoreBookmark(removed.bookmark, removed.index),
    },
    BOOKMARK_UNDO_MS,
  );
}

/** Saves a page and says what happened (added, already there, full, not a web page). Returns true when it was added. */
export function addWithNotice(url: string, title: string, showNotice: ShowNotice): boolean {
  const r = addBookmark(url, title);
  const n = bookmarkCopy.notices;
  showNotice({ message: r.reason === 'added' ? n.added : r.reason === 'exists' ? n.exists : r.reason === 'full' ? n.full : n.invalid }, 3000);
  return r.reason === 'added';
}
