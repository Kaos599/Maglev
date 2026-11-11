import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors } from '../../constants/theme';

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
  const fill = { download: colors.download, seed: colors.upload, paused: colors.paused, error: colors.danger }[tone];
  const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  const seg = w * 0.3;

  useEffect(() => {
    if (!indeterminate || w === 0) return;
    x.setValue(-seg);
    const loop = Animated.loop(
      Animated.timing(x, { toValue: w, duration: 1400, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [indeterminate, w, seg, x]);

  return (
    <View
      style={styles.track}
      testID={testID}
      onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={indeterminate ? undefined : { min: 0, max: 100, now: Math.round(p * 100) }}
    >
      {indeterminate ? (
        <Animated.View style={[styles.fill, { width: seg, backgroundColor: fill, transform: [{ translateX: x }] }]} />
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
