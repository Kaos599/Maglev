import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PausedBy, TorrentState } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { stateColor, stateLabel } from './torrentLabels';

interface Props {
  state: TorrentState;
  pausedBy?: PausedBy | null;
  moveProgress?: number | null;
  /** "HH:MM" shown on a scheduled pause. */
  resumesAt?: string | null;
}

export function StateBadge({ state, pausedBy, moveProgress, resumesAt }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tint = stateColor(state, colors);
  return (
    <View style={[styles.badge, { borderColor: tint, backgroundColor: alpha(tint, 0.12) }]}>
      <Text style={[styles.text, { color: tint }]}>{stateLabel(state, pausedBy, { moveProgress, resumesAt })}</Text>
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
