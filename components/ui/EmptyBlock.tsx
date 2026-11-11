import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { animateTo, duration, useReduceMotion } from '../motion';
import { Button } from './Button';

export interface EmptyBlockAction {
  label: string;
  onPress: () => void;
  icon?: PixelIconName;
}

export interface EmptyBlockProps {
  icon: PixelIconName;
  title: string;
  body?: string;
  primary?: EmptyBlockAction;
  secondary?: EmptyBlockAction;
  /** Tints the icon with the danger color for error states. */
  error?: boolean;
  testID?: string;
}

/** Whole pixels the tile and copy rise through on entrance. */
const RISE = 6;

/**
 * Empty or error state. On mount the icon tile settles in first and the copy follows a beat
 * later: one 220 ms ease-out run on the native driver, split by interpolation into two
 * overlapping 176 ms steps. It plays once per mount, never loops, and is skipped under reduce
 * motion. At rest both offsets are exactly 0 px.
 */
export function EmptyBlock({ icon, title, body, primary, secondary, error, testID }: EmptyBlockProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  const enter = useRef(new Animated.Value(0)).current;
  const anim = useRef({
    tileOpacity: enter.interpolate({ inputRange: [0, 0.8], outputRange: [0, 1], extrapolate: 'clamp' }),
    tileY: enter.interpolate({ inputRange: [0, 0.8], outputRange: [RISE, 0], extrapolate: 'clamp' }),
    copyOpacity: enter.interpolate({ inputRange: [0.2, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
    copyY: enter.interpolate({ inputRange: [0.2, 1], outputRange: [RISE, 0], extrapolate: 'clamp' }),
  }).current;

  useEffect(() => {
    animateTo(enter, 1, duration.enter, reduce);
    // Mount only: a later reduce-motion change must not replay the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.wrap} testID={testID}>
      <Animated.View style={[styles.tile, { opacity: anim.tileOpacity, transform: [{ translateY: anim.tileY }] }]}>
        <PixelIcon name={icon} size={24} color={error ? colors.danger : colors.textMuted} />
      </Animated.View>
      <Animated.View style={[styles.copy, { opacity: anim.copyOpacity, transform: [{ translateY: anim.copyY }] }]}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {body ? <Text style={styles.body}>{body}</Text> : null}
        {primary || secondary ? (
          <View style={styles.actions}>
            {primary ? <Button label={primary.label} icon={primary.icon} onPress={primary.onPress} /> : null}
            {secondary ? <Button label={secondary.label} icon={secondary.icon} onPress={secondary.onPress} variant="ghost" /> : null}
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { alignItems: 'center', paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxxl },
    tile: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    copy: { alignItems: 'center', alignSelf: 'stretch' },
    title: { ...type.bodyStrong, fontSize: 17, color: c.text, marginTop: spacing.lg, textAlign: 'center' },
    body: { ...type.body, fontSize: 13, lineHeight: 19, color: c.textMuted, marginTop: spacing.sm, textAlign: 'center', maxWidth: 300 },
    actions: { marginTop: spacing.xl, alignItems: 'center', gap: spacing.sm },
  });
