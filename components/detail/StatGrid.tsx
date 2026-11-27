import React, { useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';

export interface Stat {
  label: string;
  value: string;
  tint?: string;
}

// Above this font scale three cells to a row no longer fit. A cell on a 360 dp screen has about 80 dp of room for text, and
// the longest label ("Download", 8 characters at roughly 0.6 em on 11 sp) needs about 53 dp x scale there, plus the values
// ("12.3 MB/s", 9 characters on 13 sp) about 70 dp x scale. So 1.15 still fits and the next step up (1.3) does not.
const TWO_COLUMNS_ABOVE_SCALE = 1.15;

/** Label/value cells, 3 to a row (2 rows of 3 on the torrent page) or 2 to a row (`columns={2}`). Unknown values arrive as "—". */
export function StatGrid({ stats, columns = 3 }: { stats: Stat[]; columns?: 2 | 3 }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { fontScale } = useWindowDimensions();
  const large = fontScale > TWO_COLUMNS_ABOVE_SCALE;
  const cols = large ? 2 : columns;
  return (
    <View style={styles.grid}>
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
