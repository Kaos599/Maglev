import React from 'react';
import { useMaglevEngine } from '../../context/EngineContext';
import { bookmarkCopy } from '../../constants/bookmarkCopy';
import { haptic } from '../../constants/haptics';
import { findBookmark, useBookmarks } from '../../utils/browser/bookmarks';
import { ListRow } from '../ui';
import { addWithNotice, removeWithUndo } from './bookmarkActions';

export interface BookmarkToggleProps {
  /** The current page's address. Only http(s) pages can be bookmarked; for others the row is disabled. */
  url: string;
  /** The current page's title. */
  title: string;
  /** Called after the row acts, so the menu that holds it can close. */
  onDone?: () => void;
}

/** A page-menu row: "Add bookmark", or "Remove bookmark" (with Undo) when the page is already saved. */
export function BookmarkToggle({ url, title, onDone }: BookmarkToggleProps) {
  const { showNotice } = useMaglevEngine();
  const saved = findBookmark(useBookmarks(), url);
  const webPage = /^https?:\/\//i.test(url);
  const c = bookmarkCopy.toggle;
  return (
    <ListRow
      icon="bookmark"
      title={saved ? c.remove : c.add}
      subtitle={saved ? c.removeSubtitle : c.addSubtitle}
      disabled={!webPage}
      onPress={() => {
        haptic('select');
        onDone?.();
        if (saved) removeWithUndo(saved.id, showNotice);
        else addWithNotice(url, title, showNotice);
      }}
    />
  );
}
