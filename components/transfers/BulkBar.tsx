import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { LongName, PressableScale } from '../ui';

export interface BulkBarProps {
  disabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  /** The one selected transfer's name, shown whole above the buttons. Null with none or several selected. */
  name?: string | null;
  /** The bar's height as it changes (it grows with the name), so the list can end above it. */
  onHeight?: (height: number) => void;
}

export function BulkBar({ disabled, onPause, onResume, onDelete, name, onHeight }: BulkBarProps) {
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
    <View style={styles.bar} onLayout={onHeight ? (e) => onHeight(Math.ceil(e.nativeEvent.layout.height)) : undefined}>
      {name ? (
        <View style={styles.nameStrip}>
          <LongName name={name} size="line" testID="bulk-bar-name" />
        </View>
      ) : null}
      <View style={styles.cells}>
        {cell('Pause', 'pause', onPause, colors.text)}
        {cell('Resume', 'play', onResume, colors.text)}
        {cell('Delete', 'trash', onDelete, colors.danger)}
      </View>
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
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    nameStrip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: c.border },
    cells: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    cell: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: radius.md },
    cellPressed: { backgroundColor: c.surfaceRaised },
    cellDisabled: { opacity: 0.4 },
    label: { ...type.bodyStrong, fontSize: type.size.sm },
  });
