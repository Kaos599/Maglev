import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { Banner } from '../ui';
import { banners } from '../../constants/copy';

export interface ClipboardChipProps {
  /** False for a link to a .torrent file. Ignored when `link` is given. */
  magnet?: boolean;
  /** The copied text. Its kind picks the title and its host is shown under it. */
  link?: string;
  onAdd: () => void;
  onDismiss: () => void;
}

/** "example.com" for a web link, null for anything else (a magnet has no readable host). */
function hostOf(link: string): string | null {
  try {
    const u = new URL(link);
    return /^https?:$/.test(u.protocol) ? u.host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

export function ClipboardChip({ magnet = true, link, onAdd, onDismiss }: ClipboardChipProps) {
  const isMagnet = link ? link.trim().toLowerCase().startsWith('magnet:') : magnet;
  const isTorrent = !isMagnet && (!link || /\.torrent(\?|#|$)/i.test(link));
  const title = isMagnet
    ? banners.transfers.magnetInClipboard.title
    : isTorrent
      ? banners.transfers.torrentLinkInClipboard.title
      : banners.transfers.linkInClipboard.title;
  const host = link && !isMagnet ? hostOf(link.trim()) : null;
  return (
    <View style={styles.wrap}>
      <Banner
        tone="info"
        title={title}
        body={host ?? undefined}
        actionLabel="Add"
        onAction={onAdd}
        onDismiss={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm } });
