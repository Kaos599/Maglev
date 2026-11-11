import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DetailPeer, DetailTracker } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatSpeed } from '../../constants/format';


export function PeerRow({ peer }: { peer: DetailPeer }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.listItem} accessible accessibilityLabel={`${peer.addr}, ${peer.client || 'unknown client'}`}>
      <Text style={styles.name} numberOfLines={1}>{peer.addr}</Text>
      <Text style={styles.meta} numberOfLines={1}>{peer.client || 'Unknown client'}</Text>
      <View style={styles.speeds}>
        <Text style={[styles.speed, { color: colors.download }]}>↓ {formatSpeed(peer.downBps)}</Text>
        <Text style={[styles.speed, { color: colors.upload }]}>↑ {formatSpeed(peer.upBps)}</Text>
      </View>
    </View>
  );
}

export function TrackerRow({ tracker }: { tracker: DetailTracker }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.listItem}>
      <Text style={styles.name} selectable>{tracker.url}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      paddingLeft: spacing.xs,
    },
    press: { flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingRight: spacing.md, paddingVertical: spacing.sm, gap: spacing.sm },
    body: { flex: 1 },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
    skipped: { color: c.textMuted },
    meta: { ...type.mono, fontSize: type.size.xs, color: c.textMuted, marginTop: 2 },
    bar: { marginTop: spacing.sm },
    listItem: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    speeds: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.xs },
    speed: { ...type.mono, fontSize: type.size.sm },
  });
