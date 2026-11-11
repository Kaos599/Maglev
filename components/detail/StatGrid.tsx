import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';

export interface Stat {
  label: string;
  value: string;
  tint?: string;
}

/** 2 rows x 3 columns of label/value cells. Unknown values arrive as "—". */
export function StatGrid({ stats }: { stats: Stat[] }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.grid}>
      {stats.map((s) => (
        <View key={s.label} style={styles.cell} accessible accessibilityLabel={`${s.label} ${s.value}`}>
          <Text style={styles.label}>{s.label}</Text>
          <Text style={[styles.value, s.tint ? { color: s.tint } : null]} numberOfLines={1}>
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
    label: { ...type.body, fontSize: type.size.xs, color: c.textMuted, marginBottom: 2 },
    value: { ...type.monoBold, fontSize: type.size.md, color: c.text },
  });
