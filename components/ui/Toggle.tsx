import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors } from '../../constants/theme';
import { triggerHaptic } from '../../constants/haptics';

export interface ToggleProps {
  value: boolean;
  onValueChange: (next: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  testID?: string;
}

const W = 44;
const H = 26;
const KNOB = 18;
const PAD = 4;

export function Toggle({ value, onValueChange, accessibilityLabel, disabled = false, testID }: ToggleProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const x = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(x, { toValue: value ? 1 : 0, duration: 140, useNativeDriver: true }).start();
  }, [value, x]);

  return (
    <Pressable
      onPress={() => {
        triggerHaptic('selection');
        onValueChange(!value);
      }}
      disabled={disabled}
      testID={testID}
      hitSlop={{ top: 9, bottom: 9, left: 0, right: 0 }}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: value, disabled }}
      style={[styles.track, value ? styles.on : styles.off, disabled && styles.disabled]}
    >
      <Animated.View
        style={[
          styles.knob,
          { backgroundColor: value ? colors.onAccent : colors.textMuted },
          { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [0, W - KNOB - PAD * 2 - 2] }) }] },
        ]}
      />
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    track: { width: W, height: H, borderRadius: 6, borderWidth: 1, justifyContent: 'center', paddingHorizontal: PAD - 1 },
    on: { backgroundColor: c.accent, borderColor: c.accent },
    off: { backgroundColor: c.surfaceRaised, borderColor: c.borderStrong },
    disabled: { opacity: 0.4 },
    knob: { width: KNOB, height: KNOB, borderRadius: 4 },
  });
