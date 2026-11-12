import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha } from '../../constants/theme';
import { useReduceMotion } from '../motion';

/**
 * Lets a screen calm its indeterminate bars. `active: false` stops them (the screen is not focused).
 * `sweeps` ends the sweep after that many passes; null sweeps for as long as the bar is shown.
 * A bar that is not sweeping shows a still, faint full-width fill: busy, with no amount implied.
 * An endless sweep keeps Android from ever reaching an idle screen (uiautomator "could not get idle state").
 */
export interface ProgressMotion {
  active: boolean;
  sweeps: number | null;
}
export const ProgressMotionContext = createContext<ProgressMotion>({ active: true, sweeps: null });

export type ProgressTone = 'download' | 'seed' | 'paused' | 'error';

export interface ProgressBarProps {
  /** 0..1 */
  progress?: number;
  tone?: ProgressTone;
  indeterminate?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function ProgressBar({ progress = 0, tone = 'download', indeterminate = false, accessibilityLabel, testID }: ProgressBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [w, setW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReduceMotion();
  const motion = useContext(ProgressMotionContext);
  const [settled, setSettled] = useState(false);
  const fill = { download: colors.download, seed: colors.upload, paused: colors.paused, error: colors.danger }[tone];
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const seg = w * 0.3;

  // A bar that comes back (indeterminate again, or the screen focused again) gets its sweeps again.
  useEffect(() => {
    if (!indeterminate || !motion.active) setSettled(false);
  }, [indeterminate, motion.active]);

  const sweeping = indeterminate && motion.active && !reduceMotion && !settled;
  const sweeps = motion.sweeps;
  useEffect(() => {
    if (!sweeping || w === 0) return;
    x.setValue(-seg);
    const loop = Animated.loop(
      Animated.timing(x, { toValue: w, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      { iterations: sweeps ?? -1 },
    );
    loop.start(({ finished }) => {
      if (finished) setSettled(true);
    });
    return () => loop.stop();
  }, [sweeping, sweeps, w, seg, x]);

  return (
    <View
      style={styles.track}
      testID={testID}
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={indeterminate ? undefined : { min: 0, max: 100, now: Math.round(p * 100) }}
    >
      {indeterminate && sweeping ? (
        <Animated.View style={[styles.fill, { width: seg, backgroundColor: fill, transform: [{ translateX: x }] }]} />
      ) : indeterminate ? (
        <View style={[styles.fill, { width: '100%', backgroundColor: alpha(fill, 0.35) }]} />
      ) : (
        <View style={[styles.fill, { width: `${p * 100}%`, backgroundColor: fill }]} />
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    track: { height: 6, borderRadius: 3, backgroundColor: c.surfaceRaised, overflow: 'hidden' },
    fill: { height: 6, borderRadius: 3 },
  });
