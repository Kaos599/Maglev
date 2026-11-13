import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing } from '../../constants/theme';
import { steppedRanges } from '../brand/markMotion';
import { useReduceMotion } from '../motion/useReduceMotion';

export interface ProgressSquaresProps {
  /** Zero-based index of the current step. */
  index: number;
  total: number;
}

/** A square that becomes current pops from half size to full in whole steps. */
const POP = [0.5, 0.75, 1];

function Square({ state, style }: { state: 'done' | 'current' | 'todo'; style: object }) {
  const reduce = useReduceMotion();
  const clock = useRef(new Animated.Value(state === 'current' ? 0 : 1)).current;
  useEffect(() => {
    if (state !== 'current' || reduce) {
      clock.setValue(1);
      return;
    }
    clock.setValue(0);
    const anim = Animated.timing(clock, { toValue: 1, duration: 160, easing: Easing.linear, useNativeDriver: true });
    anim.start();
    return () => anim.stop();
  }, [state, reduce, clock]);
  const scale = clock.interpolate({ ...steppedRanges(POP, false), extrapolate: 'clamp' });
  return <Animated.View style={[style, { transform: [{ scale }] }]} />;
}

/** Pixel progress rail: one square per step. Passed steps are muted, the current one is lime. */
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
      {Array.from({ length: total }, (_, i) => {
        const state = i < index ? 'done' : i === index ? 'current' : 'todo';
        return <Square key={i} state={state} style={[styles.square, styles[state]]} />;
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
    square: { width: 8, height: 8 },
    current: { backgroundColor: c.accent },
    done: { backgroundColor: c.textMuted },
    todo: { backgroundColor: c.border },
  });
