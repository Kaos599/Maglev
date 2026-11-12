import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';

export interface CollapsibleProps {
  open: boolean;
  onToggle: () => void;
  accessibilityLabel: string;
  /** The always-visible row content, left of the chevron. */
  header: React.ReactNode;
  children?: React.ReactNode;
}

/** A 44px header row with a chevron that turns, and a body shown only while open. */
export function Collapsible({ open, onToggle, accessibilityLabel, header, children }: CollapsibleProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View>
      <Pressable
        onPress={onToggle}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: open }}
      >
        <View style={styles.headBody}>{header}</View>
        <View style={open ? styles.turned : undefined}>
          <PixelIcon name="chevron-down" size={16} color={colors.textMuted} />
        </View>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    head: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    headBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    pressed: { backgroundColor: c.surfaceRaised },
    turned: { transform: [{ rotate: '180deg' }] },
  });
