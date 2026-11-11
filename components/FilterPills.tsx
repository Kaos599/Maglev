import React, { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { spacing } from '../constants/theme';
import { Chip } from './ui';
import { FILTERS, TransferFilter } from './transfers/model';

export interface FilterPillsProps {
  value: TransferFilter;
  counts: Record<TransferFilter, number>;
  onChange: (f: TransferFilter) => void;
}

export function FilterPills({ value, counts, onChange }: FilterPillsProps) {
  const chips = useMemo(
    () => FILTERS.map((f) => <Chip key={f.id} label={f.label} count={counts[f.id]} selected={value === f.id} onPress={() => onChange(f.id)} />),
    [value, counts, onChange],
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.scroll}>
      {chips}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
});
