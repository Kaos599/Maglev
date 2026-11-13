import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { alpha, spacing } from '../constants/theme';
import { Chip } from './ui';
import { FILTERS, TransferFilter } from './transfers/model';

export interface FilterPillsProps {
  value: TransferFilter;
  counts: Record<TransferFilter, number>;
  onChange: (f: TransferFilter) => void;
}

/** Opacity of the cover strips on the right edge, left to right (no gradient library). */
const FADE_STEPS = [0.2, 0.45, 0.7, 0.92] as const;

export function FilterPills({ value, counts, onChange }: FilterPillsProps) {
  const chips = useMemo(
    () => FILTERS.map((f) => <Chip key={f.id} label={f.label} count={counts[f.id]} selected={value === f.id} onPress={() => onChange(f.id)} />),
    [value, counts, onChange],
  );
  const { colors } = useTheme();
  // A fade on the right edge says there are more pills until the row is scrolled to its end.
  const [atEnd, setAtEnd] = useState(false);
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        style={styles.scroll}
        scrollEventThrottle={64}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const end = contentOffset.x + layoutMeasurement.width >= contentSize.width - 8;
          if (end !== atEnd) setAtEnd(end);
        }}
      >
        {chips}
      </ScrollView>
      {atEnd ? null : (
        <View pointerEvents="none" style={styles.fade}>
          {FADE_STEPS.map((a) => (
            <View key={a} style={{ flex: 1, backgroundColor: alpha(colors.bg, a) }} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  fade: { position: 'absolute', top: 0, bottom: 0, right: 0, width: 32, flexDirection: 'row' },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
});
