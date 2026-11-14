import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { PixelIcon } from '../PixelIcon';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { textSizeCopy } from '../../constants/copy';
import { Button, PressableScale } from '../ui';
import { FloatingSheet } from './FloatingSheet';
import { TEXT_ZOOM_DEFAULT, TEXT_ZOOM_MAX, TEXT_ZOOM_MIN, TEXT_ZOOM_STEP } from '../../utils/prefs/browser';

export interface TextSizeSheetProps {
  visible: boolean;
  /** Current size in percent. */
  value: number;
  onChange(percent: number): void;
  onClose(): void;
}

/** Text size for every open page: smaller, larger (steps of 10, 50 to 200) and Reset (100). */
export function TextSizeSheet({ visible, value, onChange, onClose }: TextSizeSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const set = (next: number) => {
    const v = Math.min(TEXT_ZOOM_MAX, Math.max(TEXT_ZOOM_MIN, next));
    if (v === value) return;
    haptic('select');
    onChange(v);
  };
  const atMin = value <= TEXT_ZOOM_MIN;
  const atMax = value >= TEXT_ZOOM_MAX;
  return (
    <FloatingSheet visible={visible} onClose={onClose} title={textSizeCopy.title}>
      <View style={styles.row}>
        <PressableScale
          onPress={() => set(value - TEXT_ZOOM_STEP)}
          disabled={atMin}
          accessibilityRole="button"
          accessibilityLabel={textSizeCopy.smaller}
          style={[styles.step, atMin && styles.dim]}
        >
          <PixelIcon name="minus" size={24} color={colors.text} />
        </PressableScale>
        <Text style={styles.value} accessibilityLiveRegion="polite">
          {textSizeCopy.value(value)}
        </Text>
        <PressableScale
          onPress={() => set(value + TEXT_ZOOM_STEP)}
          disabled={atMax}
          accessibilityRole="button"
          accessibilityLabel={textSizeCopy.larger}
          style={[styles.step, atMax && styles.dim]}
        >
          <PixelIcon name="plus" size={24} color={colors.text} />
        </PressableScale>
      </View>
      <View style={styles.actions}>
        <Button label={textSizeCopy.reset} variant="secondary" disabled={value === TEXT_ZOOM_DEFAULT} onPress={() => set(TEXT_ZOOM_DEFAULT)} />
      </View>
    </FloatingSheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingHorizontal: spacing.md },
    step: {
      width: 56,
      height: 56,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    value: { ...type.monoBold, fontSize: type.size.xl, color: c.text, fontVariant: ['tabular-nums'] },
    actions: { paddingHorizontal: spacing.md, paddingTop: spacing.md, alignItems: 'center' },
    dim: { opacity: 0.4 },
  });
