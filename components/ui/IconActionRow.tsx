import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, touch, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { PressableScale } from './PressableScale';

export interface IconAction {
  key: string;
  icon: PixelIconName;
  label: string;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** Lit in the accent colour, e.g. the bookmark of a page that is saved. */
  active?: boolean;
  /** Icon and label in the danger colour, for an action that removes something (it should still confirm). */
  destructive?: boolean;
}

/** The icon row at the top of a ⋮ menu: evenly spaced 48 dp targets with a small label under each. */
export function IconActionRow({ actions }: { actions: IconAction[] }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      {actions.map((a) => {
        const tint = a.disabled ? colors.textFaint : a.destructive ? colors.danger : a.active ? colors.accent : colors.text;
        return (
          <PressableScale
            key={a.key}
            onPress={a.onPress}
            onLongPress={a.onLongPress}
            disabled={a.disabled}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            accessibilityState={{ disabled: !!a.disabled, selected: !!a.active }}
            style={styles.item}
          >
            <PixelIcon name={a.icon} size={24} color={tint} />
            <Text style={[styles.label, { color: a.disabled ? colors.textFaint : a.destructive ? colors.danger : a.active ? colors.accent : colors.textMuted }]} numberOfLines={1}>
              {a.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', justifyContent: 'space-around', paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
    item: { flex: 1, minHeight: 48, minWidth: touch.min, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    label: { ...type.body, fontSize: type.size.xs },
  });
