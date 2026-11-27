import React, { useMemo, useState } from 'react';
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

// Rough width of one label character as a share of the font size, with a margin for wider fonts.
const CHAR_WIDTH_EM = 0.7;

/** The icon row at the top of a ⋮ menu: evenly spaced 48 dp targets with a small label under each. */
export function IconActionRow({ actions }: { actions: IconAction[] }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { fontScale } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState(0);
  // At the default scale (or smaller) the row is one line exactly as before. Above it, a label may no longer fit its share and
  // a word would break in the middle, so the row wraps: as many items per line as the longest word allows, then the items are
  // spread over equal lines (5 become 3 + 2, 4 become 2 + 2) and each gets a whole-dp width from the measured row.
  const wrapMode = fontScale > 1 && rowWidth > 0;
  let perRow = actions.length;
  let itemWidth = 0;
  if (wrapMode) {
    const inner = rowWidth - 2 * spacing.sm;
    const longestWord = Math.max(1, ...actions.flatMap((a) => a.label.split(/\s+/).map((w) => w.length)));
    const wordWidth = longestWord * CHAR_WIDTH_EM * type.size.xs * fontScale;
    const fit = Math.max(1, Math.min(actions.length, Math.floor(inner / wordWidth)));
    const lines = Math.ceil(actions.length / fit);
    perRow = Math.ceil(actions.length / lines);
    itemWidth = Math.floor(inner / perRow);
  }
  const wrapped = wrapMode && perRow < actions.length;
  return (
    <View style={[styles.row, wrapped && styles.rowWrapped]} onLayout={fontScale > 1 ? (e) => setRowWidth(e.nativeEvent.layout.width) : undefined}>
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
            style={wrapped ? [styles.item, styles.itemWrapped, { width: itemWidth }] : styles.item}
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
    rowWrapped: { flexWrap: 'wrap', justifyContent: 'center', rowGap: spacing.xs },
    itemWrapped: { flexGrow: 0, flexShrink: 0 },
    item: { flex: 1, minHeight: 48, minWidth: touch.min, alignItems: 'center', justifyContent: 'center', gap: spacing.xs },
    label: { ...type.body, fontSize: type.size.xs, textAlign: 'center' },
  });
