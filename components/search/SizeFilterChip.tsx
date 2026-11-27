import React, { useMemo } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type, touch } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { customSizeCopy } from '../../constants/copy';
import { sizeLabel, type SizeFilter } from './sizeRange';

export interface SizeFilterChipProps {
  filter: SizeFilter;
  onRemove: () => void;
}

/** The size filter in use, above the results. Pressing it removes the filter. */
export function SizeFilterChip({ filter, onRemove }: SizeFilterChipProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const label = sizeLabel(filter);
  return (
    <PressableScale
      onPress={onRemove}
      haptic="select"
      accessibilityRole="button"
      accessibilityLabel={customSizeCopy.removeChip}
      accessibilityValue={{ text: label }}
      style={styles.chip}
    >
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      <PixelIcon name="close" size={16} color={colors.text} />
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    chip: {
      minHeight: touch.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: 1,
      backgroundColor: alpha(c.accent, 0.15),
      borderColor: c.accent,
    },
    label: { ...type.bodyStrong, fontSize: type.size.md, color: c.text, flexShrink: 1 },
  });
