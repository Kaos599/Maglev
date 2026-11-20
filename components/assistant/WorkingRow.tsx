import React, { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, motion, spacing, type, touch } from '../../constants/theme';
import { useReduceMotion } from '../motion';

const SQUARES = 3;

/**
 * The "the Assistant is working" row at the newest end of the chat: three small squares that light one at a time
 * (stepped, no glow), then what it is doing in muted words. Reduce motion shows the squares still.
 */
export const WorkingRow = memo(function WorkingRow({ label }: { label: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  const [lit, setLit] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setLit((n) => (n + 1) % SQUARES), motion.loop.step);
    return () => clearInterval(id);
  }, [reduce]);
  return (
    <View style={styles.row} accessible accessibilityLiveRegion="polite" accessibilityLabel="Assistant is working">
      <View style={styles.squares} importantForAccessibility="no-hide-descendants">
        {Array.from({ length: SQUARES }, (_, i) => (
          <View key={i} style={[styles.square, { opacity: reduce || i === lit ? 1 : 0.25 }]} />
        ))}
      </View>
      <Text style={styles.text} importantForAccessibility="no">
        {label}
      </Text>
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { minHeight: touch.min, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    squares: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    square: { width: 6, height: 6, backgroundColor: c.accent },
    text: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
