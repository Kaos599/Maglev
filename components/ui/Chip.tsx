import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { PressableScale } from './PressableScale';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  count?: number;
  disabled?: boolean;
  testID?: string;
}

export function Chip({ label, selected = false, onPress, count, disabled = false, testID }: ChipProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const hasCount = typeof count === 'number';
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={hasCount ? `${label}, ${count}` : label}
      accessibilityState={{ selected, disabled }}
      style={(pressed) => [
        styles.chip,
        selected ? styles.selected : pressed ? styles.pressed : styles.idle,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.label, { color: selected ? colors.accentText : colors.text }]}>
        {label}
      </Text>
      {hasCount ? (
        <View style={[styles.count, selected && styles.countSelected]}>
          <Text style={[styles.countText, { color: selected ? colors.accentText : colors.textMuted }]}>{count}</Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    chip: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    idle: { backgroundColor: c.surface, borderColor: c.border },
    pressed: { backgroundColor: c.surfaceRaised, borderColor: c.border },
    selected: { backgroundColor: alpha(c.accent, 0.15), borderColor: c.accent },
    disabled: { opacity: 0.4 },
    label: { ...type.bodyStrong, fontSize: 13, flexShrink: 1 },
    count: {
      minWidth: 20,
      height: 20,
      paddingHorizontal: 5,
      borderRadius: 4,
      backgroundColor: c.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countSelected: { backgroundColor: alpha(c.accent, 0.2) },
    countText: { ...type.mono, fontSize: 11 },
  });
