import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';

export interface Stat {
  label: string;
  value: string;
  tint?: string;
}

// Rough character widths as a share of the font size, with a margin for wider fonts (Space Mono).
const LABEL_CHAR_EM = 0.65;
const VALUE_CHAR_EM = 0.7;
// A cell's side padding plus its hairline border, both sides.
const CELL_CHROME = 2 * spacing.md + 2;

/** Label/value cells, 3 to a row (2 rows of 3 on the torrent page) or 2 to a row (`columns={2}`). Unknown values arrive as "—". */
export function StatGrid({ stats, columns = 3 }: { stats: Stat[]; columns?: 2 | 3 }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { fontScale } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(0);
  // At the default scale (or smaller) the caller's column count is used as is. Above it, three cells to a row stay only when
  // the longest label and value, at this font size, fit the measured cell; otherwise the grid drops to two.
  const large = fontScale > 1;
  let cols: 2 | 3 = columns;
  if (large && columns === 3) {
    const room = (gridWidth - 2 * spacing.sm) / 3 - CELL_CHROME;
    const longest = (pick: (x: Stat) => string) => Math.max(1, ...stats.map((x) => pick(x).length));
    const needLabel = longest((x) => x.label) * LABEL_CHAR_EM * type.size.xs * fontScale;
    const needValue = longest((x) => x.value) * VALUE_CHAR_EM * type.size.md * fontScale;
    cols = gridWidth > 0 && Math.max(needLabel, needValue) <= room ? 3 : 2;
  }
  return (
    <View style={styles.grid} onLayout={large ? (e) => setGridWidth(e.nativeEvent.layout.width) : undefined}>
      {stats.map((s) => (
        <View key={s.label} style={[styles.cell, cols === 2 && styles.cellHalf]} accessible accessibilityLabel={`${s.label} ${s.value}`}>
          {/* A label never breaks inside a word: at a large scale it shrinks a little instead (never below 70%). */}
          <Text style={styles.label} numberOfLines={large ? 1 : undefined} adjustsFontSizeToFit={large} minimumFontScale={0.7}>
            {s.label}
          </Text>
          <Text style={[styles.value, s.tint ? { color: s.tint } : null]} numberOfLines={large ? 2 : 1}>
            {s.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    cell: {
      flexBasis: '31%',
      flexGrow: 1,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
    },
    cellHalf: { flexBasis: '47%' },
    label: { ...type.body, fontSize: type.size.xs, color: c.textMuted, marginBottom: 2 },
    value: { ...type.monoBold, fontSize: type.size.md, color: c.text },
  });
