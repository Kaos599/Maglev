import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { PressableScale } from './PressableScale';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: PixelIconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  /** Ref to the button, e.g. to return screen reader focus to it. */
  buttonRef?: React.Ref<any>;
}

/** Three square dots blinking in sequence; subtle, no pulsing of the whole control. */
function Dots({ color }: { color: string }) {
  const vals = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    const loops = vals.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 200, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 200, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [vals]);
  return (
    <View style={{ flexDirection: 'row', gap: 3 }}>
      {vals.map((v, i) => (
        <Animated.View key={i} style={{ width: 4, height: 4, backgroundColor: color, opacity: v }} />
      ))}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  accessibilityLabel,
  testID,
  buttonRef,
}: ButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const inactive = disabled || loading;

  const fg =
    variant === 'primary'
      ? colors.onAccent
      : variant === 'danger'
        ? colors.danger
        : variant === 'ghost'
          ? colors.accentText
          : colors.text;

  return (
    <PressableScale
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      testID={testID}
      pressableRef={buttonRef}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      style={(pressed) => [
        styles.base,
        size === 'lg' ? styles.lg : styles.md,
        fullWidth && styles.full,
        styles[variant],
        pressed && !inactive && styles[`${variant}Pressed` as const],
        disabled && styles.disabled,
      ]}
    >
      {loading ? <Dots color={fg} /> : icon ? <PixelIcon name={icon} size={20} color={fg} /> : null}
      <Text style={[styles.label, { color: fg }]}>
        {label}
      </Text>
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    base: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
      paddingHorizontal: spacing.xl,
      paddingVertical: spacing.xs,
    },
    md: { minHeight: 44 },
    lg: { minHeight: 52 },
    full: { alignSelf: 'stretch' },
    label: { ...type.bodyStrong, fontSize: 15, flexShrink: 1, textAlign: 'center' },
    primary: { backgroundColor: c.accent, borderColor: c.accent },
    primaryPressed: { backgroundColor: c.accent, opacity: 0.88 },
    secondary: { backgroundColor: c.surface, borderColor: c.border },
    secondaryPressed: { backgroundColor: c.surfaceRaised, borderColor: c.border },
    ghost: { backgroundColor: 'transparent' },
    ghostPressed: { backgroundColor: c.surfaceRaised },
    danger: { backgroundColor: 'transparent', borderColor: c.danger },
    dangerPressed: { backgroundColor: c.surfaceRaised, borderColor: c.danger },
    disabled: { opacity: 0.4 },
  });
