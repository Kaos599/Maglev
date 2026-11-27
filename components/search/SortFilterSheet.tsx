import React, { useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, Chip, ListRow, RangeSlider, SectionHeader, Sheet, Toggle } from '../ui';
import { customSizeCopy } from '../../constants/copy';
import { CustomSizeSheet } from './CustomSizeSheet';
import { SIZE_STOPS, hasSizeFilter, sizeLabel, stopLabel, stopsFor, toFilter, type SizeFilter } from './sizeRange';

export type SortKey = 'best' | 'seeders' | 'newest' | 'size' | 'name';

export const SORT_LABEL: Record<SortKey, string> = { best: 'Best match', seeders: 'Most shared', newest: 'Newest', size: 'Largest', name: 'Name' };
export const SORT_ORDER: SortKey[] = ['best', 'seeders', 'newest', 'size', 'name'];
const SORT_CAPTION: Record<SortKey, string> = {
  best: 'Names with all your words first, then the most shared.',
  seeders: 'Most people sharing first. Usually the fastest.',
  newest: 'Most recently added first.',
  size: 'Biggest files first.',
  name: 'A to Z.',
};

export interface SortFilterSheetProps {
  visible: boolean;
  onClose: () => void;
  returnFocusRef?: React.RefObject<any>;
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  /** Sources that answered, with result counts. The Source section shows only when there is more than one. */
  sources: { id: string; name: string; count: number }[];
  sourceFilter: string | null;
  onSourceChange: (id: string | null) => void;
  /** The size filter in bytes. A missing side means no limit. */
  sizeFilter: SizeFilter;
  onSizeFilterChange: (filter: SizeFilter) => void;
  hideNoShare: boolean;
  onHideNoShareChange: (next: boolean) => void;
  /** Results left after the filters, and results before them. */
  shownCount: number;
  totalCount: number;
  /** Clears source, size and the no-one-sharing switch. Sort is a preference and stays. */
  onReset: () => void;
}

/** Sort and filter sheet for Search. Presentational: the screen owns every value. */
export function SortFilterSheet({
  visible,
  onClose,
  returnFocusRef,
  sort,
  onSortChange,
  sources,
  sourceFilter,
  onSourceChange,
  sizeFilter,
  onSizeFilterChange,
  hideNoShare,
  onHideNoShareChange,
  shownCount,
  totalCount,
  onReset,
}: SortFilterSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [customOpen, setCustomOpen] = useState(false);
  const customBtnRef = useRef<any>(null);
  // Reset shows only when something differs from the defaults: all sources, any size, no-one-sharing hidden.
  const dirty = sourceFilter !== null || hasSizeFilter(sizeFilter) || !hideNoShare;
  const thumbs = useMemo(() => stopsFor(sizeFilter), [sizeFilter]);

  return (
    <>
      <Sheet visible={visible} onClose={onClose} title="Sort and filter" returnFocusRef={returnFocusRef} scroll={false}>
        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <SectionHeader title="Sort by" />
          <View accessibilityRole="radiogroup" accessibilityLabel="Sort by">
            {SORT_ORDER.map((s) => (
              <ListRow
                key={s}
                title={SORT_LABEL[s]}
                subtitle={SORT_CAPTION[s]}
                selected={sort === s}
                onPress={() => onSortChange(s)}
              />
            ))}
          </View>

          {sources.length > 1 ? (
            <View style={styles.section}>
              <SectionHeader title="Source" />
              <Text style={styles.caption}>Show results from one source.</Text>
              <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Source">
                <Chip role="radio" label="All" selected={sourceFilter === null} onPress={() => onSourceChange(null)} />
                {sources.map((s) => (
                  <Chip key={s.id} role="radio" label={s.name} count={s.count} selected={sourceFilter === s.id} onPress={() => onSourceChange(s.id)} />
                ))}
              </View>
            </View>
          ) : null}

          <View style={styles.section}>
            <SectionHeader title="Size" />
            <Text style={styles.readout} accessibilityLiveRegion="polite">{sizeLabel(sizeFilter)}</Text>
            <View style={styles.slider}>
              <RangeSlider
                steps={SIZE_STOPS.length}
                low={thumbs.low}
                high={thumbs.high}
                onChange={(low, high) => onSizeFilterChange(toFilter(low, high))}
                labelLow="Smallest size"
                labelHigh="Largest size"
                valueText={stopLabel}
              />
            </View>
            <View style={styles.customRow}>
              <Button label={customSizeCopy.button} variant="ghost" buttonRef={customBtnRef} onPress={() => setCustomOpen(true)} />
            </View>
            <Text style={styles.caption}>Files of unknown size always show.</Text>
          </View>

          <View style={styles.section}>
            <ListRow
              title="Hide torrents no one is sharing"
              subtitle="They rarely finish."
              accessory={<Toggle value={hideNoShare} onValueChange={onHideNoShareChange} accessibilityLabel="Hide torrents no one is sharing" />}
            />
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Text style={styles.count} accessibilityLiveRegion="polite">{`Showing ${shownCount} of ${totalCount} results`}</Text>
          <View style={styles.actions}>
            {dirty ? <Button label="Reset" variant="ghost" onPress={onReset} /> : null}
            <Button label="Done" variant="primary" onPress={onClose} />
          </View>
        </View>
      </Sheet>
      <CustomSizeSheet
        visible={customOpen}
        onClose={() => setCustomOpen(false)}
        returnFocusRef={customBtnRef}
        current={sizeFilter}
        onApply={(f) => {
          onSizeFilterChange(f);
          setCustomOpen(false);
        }}
      />
    </>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    scroll: { flexGrow: 0, flexShrink: 1 },
    section: { marginTop: spacing.md },
    caption: { ...type.body, fontSize: type.size.sm, lineHeight: 17, color: c.textMuted, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
    readout: { ...type.mono, fontSize: type.size.base, color: c.text, paddingHorizontal: spacing.lg, marginBottom: spacing.xs },
    slider: { paddingHorizontal: spacing.md },
    customRow: { flexDirection: 'row', paddingHorizontal: spacing.sm },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg },
    footer: { marginTop: spacing.md, gap: spacing.sm },
    count: { ...type.body, fontSize: type.size.sm, color: c.textMuted, paddingHorizontal: spacing.lg },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  });
