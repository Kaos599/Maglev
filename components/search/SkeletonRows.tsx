import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing } from '../../constants/theme';

/** Static placeholder rows for loading states (no pulsing). */
export function SkeletonRows({ count = 6 }: { count?: number }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View accessibilityLabel="Loading" accessibilityLiveRegion="polite" importantForAccessibility="yes">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row}>
          <View style={styles.lines}>
            <View style={[styles.bar, { width: `${86 - (i % 3) * 14}%` }]} />
            <View style={[styles.bar, styles.short]} />
          </View>
          <View style={styles.action} />
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 72,
      paddingVertical: spacing.md,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      marginBottom: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    lines: { flex: 1, gap: spacing.sm },
    bar: { height: 12, borderRadius: 3, backgroundColor: c.surfaceRaised },
    short: { width: '40%', height: 10 },
    action: { width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.surfaceRaised },
  });
