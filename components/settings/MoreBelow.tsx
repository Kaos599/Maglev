import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { useReduceMotion } from '../motion';

export const MORE_BELOW_LABEL = 'More below';
const FADE_HEIGHT = 72;
const FADE_BANDS = 12;
const BOB_CYCLES = 3;

/** A soft fade into the background over the bottom edge of a scroll view, built from stacked bands (no gradient package). */
export function BottomFade({ hidden }: { hidden: boolean }) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(hidden ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: hidden ? 0 : 1, duration: 150, useNativeDriver: true }).start();
  }, [hidden, opacity]);
  return (
    <Animated.View pointerEvents="none" style={[fadeStyle.root, { opacity }]}>
      {Array.from({ length: FADE_BANDS }, (_, i) => (
        <View key={i} style={{ height: FADE_HEIGHT / FADE_BANDS, backgroundColor: colors.bg, opacity: (i + 1) / FADE_BANDS }} />
      ))}
    </Animated.View>
  );
}

/** First-visit pill: bobs three times, then rests. Tapping it is the caller's job (scroll down, mark seen). */
export function MoreBelowPill({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReduceMotion();
  const bob = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion) return;
    const run = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 4, duration: 450, useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: 450, useNativeDriver: true }),
      ]),
      { iterations: BOB_CYCLES },
    );
    run.start();
    return () => run.stop();
  }, [reduceMotion, bob]);
  return (
    <Animated.View style={[s.wrap, { transform: [{ translateY: bob }] }]} pointerEvents="box-none">
      <PressableScale
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Scroll down for more settings"
        style={s.pill}
      >
        <Text style={s.text}>{MORE_BELOW_LABEL}</Text>
        <PixelIcon name="chevron-down" size={16} color={colors.textMuted} />
      </PressableScale>
    </Animated.View>
  );
}

const fadeStyle = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, bottom: 0, height: FADE_HEIGHT },
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { position: 'absolute', left: 0, right: 0, bottom: spacing.md, alignItems: 'center' },
    pill: {
      minHeight: touch.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
    },
    text: { ...type.bodyStrong, fontSize: 13, color: c.text },
  });
