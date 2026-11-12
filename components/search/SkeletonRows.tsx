import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing } from '../../constants/theme';
import { useReduceMotion } from '../motion/useReduceMotion';

/** Rows shown before the first result arrives. ResultRow's minimum height, so nothing shifts when results replace them. */
export const SKELETON_FIRST_COUNT = 5;
/** Rows kept under real results while other sources are still answering. */
export const SKELETON_MORE_COUNT = 2;

const NAME_WIDTHS = ['86%', '72%', '58%'] as const;

/**
 * Static placeholder rows shaped like ResultRow: name, size / seeds / peers, "via" line, Add button.
 * They fade in once (unless the system asks for less motion) and then hold still: no shimmer, no pulse.
 */
export function SkeletonRows({ count = SKELETON_FIRST_COUNT }: { count?: number }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const fade = Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true });
    fade.start();
    return () => fade.stop();
  }, [opacity, reduceMotion]);

  return (
    <Animated.View style={{ opacity }} accessibilityLabel="Loading" accessibilityLiveRegion="polite" importantForAccessibility="yes">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.row} importantForAccessibility="no-hide-descendants">
          <View style={styles.lines}>
            <View style={[styles.name, { width: NAME_WIDTHS[i % NAME_WIDTHS.length] }]} />
            <View style={styles.meta}>
              <View style={styles.stat} />
              <View style={styles.stat} />
              <View style={styles.stat} />
            </View>
            <View style={styles.via} />
          </View>
          <View style={styles.action} />
        </View>
      ))}
    </Animated.View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // Same box as ResultRow's row.
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
    name: { height: 12, borderRadius: 3, backgroundColor: c.surfaceRaised },
    meta: { flexDirection: 'row', gap: spacing.md },
    stat: { width: 44, height: 10, borderRadius: 3, backgroundColor: c.surfaceRaised },
    via: { width: '36%', height: 8, borderRadius: 3, backgroundColor: c.surfaceRaised },
    action: { width: 44, height: 44, marginLeft: spacing.sm, borderRadius: radius.md, backgroundColor: c.surfaceRaised },
  });
