import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { Banner } from '../ui';
import { banners } from '../../constants/copy';

export interface ClipboardChipProps {
  /** False for a link to a .torrent file. */
  magnet?: boolean;
  onAdd: () => void;
  onDismiss: () => void;
}

export function ClipboardChip({ magnet = true, onAdd, onDismiss }: ClipboardChipProps) {
  return (
    <View style={styles.wrap}>
      <Banner
        tone="info"
        title={magnet ? banners.transfers.magnetInClipboard.title : banners.transfers.torrentLinkInClipboard.title}
        actionLabel="Add"
        onAction={onAdd}
        onDismiss={onDismiss}
      />
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm } });
