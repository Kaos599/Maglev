import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { customSizeCopy } from '../../constants/copy';
import { Button, SegmentedControl, Sheet, TextField } from '../ui';
import { SIZE_UNITS, checkCustomSize, fieldFor, readSize, type SizeFilter, type SizeUnit } from './sizeRange';

const UNIT_OPTIONS = SIZE_UNITS.map((u) => ({ value: u, label: u }));

export interface CustomSizeSheetProps {
  visible: boolean;
  onClose: () => void;
  returnFocusRef?: React.RefObject<any>;
  /** The size filter in use. The fields start from it. */
  current: SizeFilter;
  /** Called with the filter the fields describe, only when they make a valid range. */
  onApply: (filter: SizeFilter) => void;
}

/** Type a smallest and a largest size. What you type is a draft: nothing is filtered until Apply. */
export function CustomSizeSheet({ visible, onClose, returnFocusRef, current, onApply }: CustomSizeSheetProps) {
  const [minText, setMinText] = useState('');
  const [minUnit, setMinUnit] = useState<SizeUnit>('MB');
  const [maxText, setMaxText] = useState('');
  const [maxUnit, setMaxUnit] = useState<SizeUnit>('GB');

  // Each time the sheet opens, the fields start from the filter in use.
  useEffect(() => {
    if (!visible) return;
    const lo = fieldFor(current.minBytes, 'MB');
    const hi = fieldFor(current.maxBytes, 'GB');
    setMinText(lo.text);
    setMinUnit(lo.unit);
    setMaxText(hi.text);
    setMaxUnit(hi.unit);
    // Only on open: a later change to `current` must not overwrite what you are typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const check = useMemo(() => checkCustomSize(readSize(minText, minUnit), readSize(maxText, maxUnit)), [minText, minUnit, maxText, maxUnit]);
  const filter = check.filter;

  return (
    <Sheet visible={visible} onClose={onClose} title={customSizeCopy.title} subtitle={customSizeCopy.subtitle} returnFocusRef={returnFocusRef}>
      <View style={styles.body}>
        <View style={styles.field}>
          <TextField
            label={customSizeCopy.smallest}
            value={minText}
            onChangeText={setMinText}
            placeholder={customSizeCopy.noMinimum}
            error={check.minError ? customSizeCopy.errors[check.minError] : undefined}
            keyboardType="decimal-pad"
            mono
            onSurface
            clearable
            clearLabel={customSizeCopy.clearSmallest}
            maxLength={24}
          />
          <SegmentedControl options={UNIT_OPTIONS} value={minUnit} onChange={setMinUnit} accessibilityLabel={customSizeCopy.smallestUnit} />
        </View>
        <View style={styles.field}>
          <TextField
            label={customSizeCopy.largest}
            value={maxText}
            onChangeText={setMaxText}
            placeholder={customSizeCopy.noMaximum}
            error={check.maxError ? customSizeCopy.errors[check.maxError] : undefined}
            keyboardType="decimal-pad"
            mono
            onSurface
            clearable
            clearLabel={customSizeCopy.clearLargest}
            maxLength={24}
          />
          <SegmentedControl options={UNIT_OPTIONS} value={maxUnit} onChange={setMaxUnit} accessibilityLabel={customSizeCopy.largestUnit} />
        </View>
        <View style={styles.actions}>
          <Button label={customSizeCopy.apply} fullWidth disabled={!filter} onPress={() => filter && onApply(filter)} />
          <Button label={customSizeCopy.cancel} variant="secondary" fullWidth onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: spacing.lg },
  field: { gap: spacing.sm },
  actions: { gap: spacing.sm },
});
