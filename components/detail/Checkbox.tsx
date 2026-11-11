import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, touch } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';

export interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
}

/** 44x44 touch target around a 20 px box. Checked state shows a check glyph, not color alone. */
export function Checkbox({ checked, onChange, accessibilityLabel, disabled = false }: CheckboxProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <PressableScale
      onPress={() => onChange(!checked)}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked, disabled }}
      style={styles.target}
    >
      <View style={[styles.box, checked && styles.boxOn, disabled && styles.boxOff]}>
        {checked ? <PixelIcon name="check" size={16} color={colors.onAccent} /> : null}
      </View>
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    target: { minWidth: touch.min, minHeight: touch.min, alignItems: 'center', justifyContent: 'center' },
    box: {
      width: 20,
      height: 20,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: 'transparent',
    },
    boxOn: { backgroundColor: c.accent, borderColor: c.accent },
    boxOff: { opacity: 0.4 },
  });
