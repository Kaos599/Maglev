import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PausedBy, TorrentState } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { stateColor, stateLabel } from './torrentLabels';
import type { BlockContext } from '../../utils/blocks/reasons';

interface Props {
  state: TorrentState;
  pausedBy?: PausedBy | null;
  moveProgress?: number | null;
  /** "HH:MM" shown on a scheduled pause. */
  resumesAt?: string | null;
  /** Active blocks and queue size, so the label can say why a torrent is held. */
  blocks?: BlockContext;
  /** SM-37: set while a magnet looks for its metadata. */
  resolving?: { peersSeen: number; secs: number } | null;
}

export function StateBadge({ state, pausedBy, moveProgress, resumesAt, resolving, blocks }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tint = stateColor(state, colors);
  return (
    <View style={[styles.badge, { borderColor: tint, backgroundColor: alpha(tint, 0.12) }]}>
      <Text style={[styles.text, { color: tint }]}>{stateLabel(state, pausedBy, { moveProgress, resumesAt, resolving, blocks })}</Text>
    </View>
  );
}

const makeStyles = (_c: ThemeColors) =>
  StyleSheet.create({
    badge: {
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.sm,
      borderWidth: 1,
    },
    text: { ...type.bodyStrong, fontSize: type.size.sm },
  });
