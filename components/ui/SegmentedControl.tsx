import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, type } from '../../constants/theme';
import { PressableScale } from './PressableScale';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  accessibilityLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** 2 to 5 options. */
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel?: string;
  testID?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  testID,
}: SegmentedControlProps<T>) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel} testID={testID}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <PressableScale
            key={o.value}
            onPress={() => !active && onChange(o.value)}
            haptic={active ? false : 'select'}
            accessibilityRole="radio"
            accessibilityLabel={o.accessibilityLabel ?? o.label}
            accessibilityState={{ selected: active, checked: active }}
            style={(pressed) => [styles.seg, active ? styles.active : pressed && styles.pressed]}
          >
            <Text style={[styles.label, { color: active ? colors.onAccent : colors.textMuted }]} numberOfLines={1}>
              {o.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: {
      flexDirection: 'row',
      height: 44,
      padding: 3,
      gap: 3,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    seg: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm + 1 },
    active: { backgroundColor: c.accent },
    pressed: { backgroundColor: c.surfaceRaised },
    label: { ...type.bodyStrong, fontSize: 13 },
  });
