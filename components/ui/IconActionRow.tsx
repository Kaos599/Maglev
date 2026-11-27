import React, { useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
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

// Rough width of one label character as a share of the font size, for deciding when a row has to wrap.
const CHAR_WIDTH_EM = 0.6;
// Up to this font scale the row stays one line, as before (a 1.15 "large" setting still fits the longest labels).
const WRAP_FROM_SCALE = 1.15;

/** The icon row at the top of a ⋮ menu: evenly spaced 48 dp targets with a small label under each. */
export function IconActionRow({ actions }: { actions: IconAction[] }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width, fontScale } = useWindowDimensions();
  // At a large font scale a label no longer fits its share of the row, and a word would break in the middle. Then the row
  // wraps into lines of as many items as fit the longest word, and a label may use two lines (a space is the only break).
  let perRow = actions.length;
  if (fontScale > WRAP_FROM_SCALE) {
    const longestWord = Math.max(1, ...actions.flatMap((a) => a.label.split(/\s+/).map((w) => w.length)));
    const wordWidth = longestWord * CHAR_WIDTH_EM * type.size.xs * fontScale;
    const rowWidth = width - 2 * spacing.xl - 2 * spacing.sm; // the sheet's side padding and the row's own
    perRow = Math.max(1, Math.min(actions.length, Math.floor(rowWidth / wordWidth)));
  }
  const wrapped = perRow < actions.length;
  return (
    <View style={[styles.row, wrapped && styles.rowWrapped]}>
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
            style={wrapped ? [styles.item, { flexBasis: `${100 / perRow}%` }] : styles.item}
          >
            <PixelIcon name={a.icon} size={24} color={tint} />
            <Text style={[styles.label, { color: a.disabled ? colors.textFaint : a.destructive ? colors.danger : a.active ? colors.accent : colors.textMuted }]} numberOfLines={2}>
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
    row: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-start', paddingHorizontal: spacing.sm, paddingBottom: spacing.sm },
    // Items start at the top of the row so icons share one line even when one label wraps and its neighbour's does not.
    rowWrapped: { flexWrap: 'wrap', rowGap: spacing.xs },
    item: { flex: 1, minHeight: 48, minWidth: touch.min, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    label: { ...type.body, fontSize: type.size.xs, textAlign: 'center' },
  });
