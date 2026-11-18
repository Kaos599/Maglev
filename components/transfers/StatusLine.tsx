import React from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, monoSlotWidth, spacing, type } from '../../constants/theme';

/** Status line font size; the value slot is sized in Space Mono glyphs at this size. */
export const STATUS_SIZE = 12;
export const STATUS_LINE = 18;

/**
 * Widest strings each value slot holds, in glyphs: "1023.9 KB/s", "↑ 1023.9 KB/s", "1023.9 GB".
 * A fixed minimum width means a speed that gains a digit never shifts the text beside it.
 * An amount ("320 MB of 2.1 GB") has no fixed width: it takes what it needs and the left side gives way.
 */
const SLOT_CHARS = { speed: 11, upload: 13, size: 9, amount: 0 } as const;

export type LineTone = 'muted' | 'accent' | 'danger' | 'download';

export interface StatusLineModel {
  lead: string;
  pct?: string;
  value?: string;
  slot?: keyof typeof SLOT_CHARS;
  tone: LineTone;
}

export function toneColor(tone: LineTone, c: ThemeColors): string {
  return tone === 'danger' ? c.danger : tone === 'accent' ? c.accentText : tone === 'download' ? c.download : c.textMuted;
}

/**
 * The one status line of a card. Left: a phrase that ellipsizes, then the percent as its own text so it always shows.
 * Right: one value in a slot that never ellipsizes. `overlay` draws over the slot (the finish check).
 */
export function StatusLine({ status, overlay }: { status: StatusLineModel; overlay?: React.ReactNode }) {
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const color = toneColor(status.tone, colors);
  const chars = SLOT_CHARS[status.slot ?? 'speed'];
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={[styles.text, styles.lead, { color }]} numberOfLines={1} ellipsizeMode="tail">
          {status.lead}
        </Text>
        {status.pct ? <Text style={[styles.text, styles.pct, { color }]} numberOfLines={1}>{` · ${status.pct}`}</Text> : null}
      </View>
      {status.value ? (
        <View style={[styles.slot, chars > 0 ? { minWidth: monoSlotWidth(chars, STATUS_SIZE, fontScale, type.slotAdvance) } : null]}>
          <Text style={[styles.text, styles.value, { color }]} numberOfLines={1}>
            {status.value}
          </Text>
          {overlay}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // One line, always present, at a fixed minimum height: rows never grow or shrink as the text changes.
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: STATUS_LINE },
  left: { flex: 1, flexShrink: 1, flexDirection: 'row', alignItems: 'center' },
  text: { ...type.mono, fontSize: STATUS_SIZE, lineHeight: STATUS_LINE },
  lead: { flexShrink: 1 },
  pct: { flexShrink: 0 },
  slot: { flexShrink: 0, alignItems: 'flex-end', justifyContent: 'center' },
  value: { textAlign: 'right' },
});
