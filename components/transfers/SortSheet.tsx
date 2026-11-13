import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { SORT_KEYS, SortDir, TransferSort } from '../../utils/prefs/transfers';
import { ListRow, SegmentedControl, Sheet } from '../ui';
import { SORT_LABELS } from './model';

export interface SortSheetProps {
  visible: boolean;
  sort: TransferSort;
  onChange: (next: TransferSort) => void;
  onClose: () => void;
  /** When more than 0, a Clear finished row shows under the sort choices, so it works from every filter. */
  finishedCount?: number;
  onClearFinished?: () => void;
}

export function SortSheet({ visible, sort, onChange, onClose, finishedCount = 0, onClearFinished }: SortSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Sort by">
      <View style={styles.dir}>
        <SegmentedControl<SortDir>
          value={sort.dir}
          onChange={(dir) => onChange({ ...sort, dir })}
          options={[
            { value: 'asc', label: 'Ascending' },
            { value: 'desc', label: 'Descending' },
          ]}
        />
      </View>
      {SORT_KEYS.map((key) => (
        <ListRow
          key={key}
          title={SORT_LABELS[key]}
          selected={sort.key === key}
          onPress={() => {
            onChange({ ...sort, key });
            onClose();
          }}
        />
      ))}
      {finishedCount > 0 && onClearFinished ? (
        <ListRow title="Clear finished" subtitle={`${finishedCount} done`} icon="trash" onPress={onClearFinished} />
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({ dir: { marginBottom: spacing.md } });
