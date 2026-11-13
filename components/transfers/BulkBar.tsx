import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { PressableScale } from '../ui';

export interface BulkBarProps {
  disabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

export function BulkBar({ disabled, onPause, onResume, onDelete }: BulkBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const cell = (label: string, icon: PixelIconName, onPress: () => void, tint: string) => (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label} selected`}
      accessibilityState={{ disabled }}
      style={(pressed) => [styles.cell, pressed && styles.cellPressed, disabled && styles.cellDisabled]}
    >
      <PixelIcon name={icon} size={20} color={tint} />
      <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </PressableScale>
  );
  return (
    // The tab bar below already clears the system navigation bar, so no safe-area inset here.
    <View style={styles.bar}>
      {cell('Pause', 'pause', onPause, colors.text)}
      {cell('Resume', 'play', onResume, colors.text)}
      {cell('Delete', 'trash', onDelete, colors.danger)}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    cell: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: radius.md },
    cellPressed: { backgroundColor: c.surfaceRaised },
    cellDisabled: { opacity: 0.4 },
    label: { ...type.bodyStrong, fontSize: 12 },
  });
