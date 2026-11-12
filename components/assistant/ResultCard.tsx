import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import type { TokenKey } from '../../utils/assistant/glossary';
import type { ResultCardView } from '../../utils/assistant/runtime';
import { Banner, Button } from '../ui';
import { PixelIcon } from '../PixelIcon';
import { WhatsInside } from './WhatsInside';

export interface ResultCardProps {
  view: ResultCardView;
  /** Whether a magnet or .torrent URL is known for this result. */
  canChoose: boolean;
  onChooseFiles: () => void;
  onAskAbout: () => void;
  onChip: (key: TokenKey) => void;
}

const LABELS = { 'best-fit': 'Best fit', smaller: 'Smaller', 'best-quality': 'Best quality' } as const;
const FIT_TEXT = { fits: 'Fits', tight: 'Tight', too_big: 'Too big' } as const;

/** One shortlisted result. Every value is app-computed (docs/ASSISTANT_DESIGN.md section 9). */
export const ResultCard = memo(function ResultCard({ view, canChoose, onChooseFiles, onAskAbout, onChip }: ResultCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const fitTint = view.fit === 'fits' ? colors.accentText : view.fit === 'tight' ? colors.warning : colors.danger;
  const meta = [view.sizeText, view.sharingText, view.sourcesText].filter(Boolean).join(' · ');

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title}>{view.title}</Text>
        {view.label ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{LABELS[view.label]}</Text>
          </View>
        ) : null}
      </View>

      {view.chips.length > 0 ? (
        <View style={styles.chips}>
          {view.chips.map((chip, i) => (
            <View key={chip.key} style={styles.chipItem}>
              <Pressable
                onPress={() => onChip(chip.key)}
                hitSlop={{ top: 12, bottom: 12, left: 6, right: 6 }}
                accessibilityRole="button"
                accessibilityLabel={`${chip.label}, what is this?`}
              >
                <Text style={styles.chipText}>{chip.label}</Text>
              </Pressable>
              {i < view.chips.length - 1 ? <Text style={styles.dot}> · </Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {meta ? <Text style={styles.meta}>{meta}</Text> : null}

      {view.fit !== 'unknown' ? (
        <View style={styles.fitRow}>
          <View style={[styles.pill, { borderColor: alpha(fitTint, 0.6), backgroundColor: alpha(fitTint, 0.1) }]}>
            <Text style={[styles.pillText, { color: fitTint }]}>{FIT_TEXT[view.fit]}</Text>
          </View>
          {view.fitText ? <Text style={styles.fitText}>{view.fitText}</Text> : null}
        </View>
      ) : null}

      {view.reasons.length > 0 ? (
        <View style={styles.reasons}>
          {view.reasons.map((r) => (
            <Text key={r} style={styles.reason}>
              {r}
            </Text>
          ))}
        </View>
      ) : null}

      {view.riskyWarning ? (
        <View style={styles.warnRow}>
          <PixelIcon name="warning" size={16} color={colors.warning} />
          <Text style={styles.warnText}>{view.riskyWarning}</Text>
        </View>
      ) : null}

      {view.safety?.level === 'red' ? (
        <View style={styles.safety}>
          <Banner tone="danger" title={view.safety.text} />
        </View>
      ) : null}
      {view.safety?.level === 'amber' ? (
        <View style={styles.warnRow}>
          <PixelIcon name="warning" size={16} color={colors.warning} />
          <Text style={styles.warnText}>{view.safety.text}</Text>
        </View>
      ) : null}
      {view.safety?.level === 'green' ? <Text style={styles.reason}>{view.safety.text}</Text> : null}

      {view.details ? <WhatsInside details={view.details} /> : null}

      <View style={styles.actions}>
        {/* R1-8: a red result can't be added, from a card or from here. */}
        <Button label="Choose files" variant="secondary" disabled={!canChoose || view.safety?.level === 'red'} onPress={onChooseFiles} />
        <Button label="Ask about this" variant="ghost" onPress={onAskAbout} />
      </View>
    </View>
  );
});

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      alignSelf: 'stretch',
      padding: spacing.md,
      gap: spacing.xs,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
    },
    head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    badge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, backgroundColor: c.firstBg, borderWidth: 1, borderColor: c.firstBorder },
    badgeText: { ...type.bodyStrong, fontSize: type.size.sm, color: c.firstFg },
    title: { ...type.bodyStrong, flex: 1, fontSize: 15, lineHeight: 20, color: c.text },
    chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
    chipItem: { flexDirection: 'row', alignItems: 'center' },
    chipText: { ...type.mono, fontSize: type.size.md, color: c.accentText, textDecorationLine: 'underline', textDecorationStyle: 'dotted', textDecorationColor: c.accentText },
    dot: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    fitRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    pill: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1 },
    pillText: { ...type.bodyStrong, fontSize: type.size.sm },
    fitText: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    reasons: { gap: 2 },
    reason: { ...type.body, fontSize: type.size.md, lineHeight: 18, color: c.textMuted },
    warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    warnText: { ...type.body, flex: 1, fontSize: type.size.md, lineHeight: 18, color: c.warning },
    safety: { marginTop: spacing.xs },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  });
