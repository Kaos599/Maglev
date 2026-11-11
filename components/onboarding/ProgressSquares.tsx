import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing } from '../../constants/theme';

export interface ProgressSquaresProps {
  /** Zero-based index of the current step. */
  index: number;
  total: number;
}

/** Pixel progress indicator: one small square per step. */
export function ProgressSquares({ index, total }: ProgressSquaresProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${index + 1} of ${total}`}
      accessibilityValue={{ min: 1, max: total, now: index + 1 }}
    >
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[styles.square, i <= index ? styles.on : styles.off]} />
      ))}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    square: { width: 8, height: 8 },
    on: { backgroundColor: c.accent },
    off: { backgroundColor: c.border },
  });
