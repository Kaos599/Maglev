import React, { useMemo } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, monoSlotWidth, spacing, type } from '../../constants/theme';

/** Status line font size; the value slot is sized in Space Mono glyphs at this size. */
const STATUS_SIZE = 12;
const STATUS_LINE = 18;

/**
 * Widest strings each value slot holds, in glyphs: "0.98 MB/s", "↑ 0.98 MB/s", "1023.9 GB". A speed is 3 significant
 * digits and changes unit at 1000 (`formatSpeed`), so it is never wider than 9; a wider slot left a gap between the
 * amount's dot and the speed (owner report 2026-11-20).
 * A fixed minimum width means a speed that gains a digit never shifts the text beside it.
 * An amount ("320 MB of 2.1 GB") has no fixed width: it takes what it needs and the left side gives way.
 */
const SLOT_CHARS = { speed: 9, upload: 11, size: 9, amount: 0 } as const;

export type LineTone = 'muted' | 'accent' | 'danger' | 'download';

export interface StatusLineModel {
  lead: string;
  pct?: string;
  value?: string;
  /** While data flows: the amount, in the normal telemetry colour, before the speed (NATIVE_CONTRACT 43.2). */
  amount?: string;
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
  // `colors` is a new object on every theme or font-style change (ThemeContext), so this also follows a live font switch.
  const styles = useMemo(() => makeStyles(), [colors]);
  const { fontScale } = useWindowDimensions();
  const color = toneColor(status.tone, colors);
  const chars = SLOT_CHARS[status.slot ?? 'speed'];
  const slotWidth = chars > 0 ? monoSlotWidth(chars, STATUS_SIZE, fontScale, type.slotAdvance) : 0;
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={[styles.text, styles.lead, { color }]} numberOfLines={1} ellipsizeMode="tail">
          {status.lead}
        </Text>
        {status.pct ? <Text style={[styles.text, styles.pct, { color }]} numberOfLines={1}>{` · ${status.pct}`}</Text> : null}
      </View>
      {status.value ? (
        <View style={[styles.slot, chars > 0 && !status.amount ? { minWidth: slotWidth } : null]}>
          {status.amount ? (
            <Text style={[styles.text, styles.value, { color: colors.textMuted }]} numberOfLines={1}>
              {`${status.amount} · `}
            </Text>
          ) : null}
          {/* With an amount beside it, the speed keeps its own fixed width so a new digit never shifts the amount. */}
          <View style={status.amount && chars > 0 ? { minWidth: slotWidth, alignItems: 'flex-end' } : null}>
            <Text style={[styles.text, styles.value, { color }]} numberOfLines={1}>
              {status.value}
            </Text>
          </View>
          {overlay}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    // One line, always present, at a fixed minimum height: rows never grow or shrink as the text changes.
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: STATUS_LINE },
    left: { flex: 1, flexShrink: 1, flexDirection: 'row', alignItems: 'center' },
    text: { ...type.mono, fontSize: STATUS_SIZE, lineHeight: STATUS_LINE },
    lead: { flexShrink: 1 },
    pct: { flexShrink: 0 },
    slot: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
    value: { textAlign: 'right' },
  });
