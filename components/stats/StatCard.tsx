/**
 * One anatomy for every Stats card: the title top-left, a chevron top-right only when it opens a sheet, the value block
 * bottom-left and a picture in a fixed box bottom-right, bottoms aligned. Half tiles all share one height and keep a
 * sub-line row (empty or not) so values in a row share a baseline.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { PressableScale } from '../ui';
import type { Parts } from '../../utils/stats/format';

export type ValueTone = 'normal' | 'dim' | 'danger';

/** "1.8" with a small " GB" after it; several parts for "2 h 5 min". A null value is "—". */
export function BigValue({ parts, text, tone = 'normal' }: { parts?: Parts[] | null; text?: string; tone?: ValueTone }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const color = tone === 'danger' ? colors.danger : tone === 'dim' ? colors.textFaint : colors.text;
  const unitColor = tone === 'danger' ? colors.danger : colors.textMuted;
  if (!parts && text == null) return <Text style={[s.big, { color: colors.textFaint }]}>—</Text>;
  return (
    <Text style={[s.big, { color }]} numberOfLines={1}>
      {text != null
        ? text
        : parts!.map((p, i) => (
            <Text key={i}>
              {i > 0 ? ' ' : ''}
              {p.n}
              <Text style={[s.unit, { color: unitColor }]}>{` ${p.unit}`}</Text>
            </Text>
          ))}
    </Text>
  );
}

export interface StatCardProps {
  title: string;
  /** Present only when the card opens a sheet. */
  onPress?: () => void;
  value: React.ReactNode;
  /** A small caption above the value ("around"). */
  pre?: React.ReactNode;
  /** Under the value: inside the value block on a full card, in the fixed sub-line row on a half tile. */
  sub?: React.ReactNode;
  picture?: React.ReactNode;
  /** half 44 x 44, full 132 x 56, dial 132 x 88. */
  box?: 'half' | 'full' | 'dial' | 'none';
  full?: boolean;
  icon?: PixelIconName;
  iconColor?: string;
  accessibilityLabel: string;
}

const BOX = { half: { width: 44, height: 44 }, full: { width: 132, height: 56 }, dial: { width: 132, height: 88 }, none: { width: 0, height: 0 } };

export function StatCard({ title, onPress, value, pre, sub, picture, box = 'half', full = false, icon, iconColor, accessibilityLabel }: StatCardProps) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const body = (
    <>
      <View style={s.titleRow}>
        {icon ? <PixelIcon name={icon} size={16} color={iconColor ?? colors.textMuted} /> : null}
        <Text style={s.title} numberOfLines={1}>
          {title}
        </Text>
      </View>
      {onPress ? (
        <View style={s.chev} pointerEvents="none">
          <PixelIcon name="chevron-right" size={16} color={colors.textMuted} />
        </View>
      ) : null}
      <View style={s.body}>
        <View style={s.left}>
          {pre}
          {value}
          {full ? sub : null}
        </View>
        {box !== 'none' ? <View style={[s.box, BOX[box]]}>{picture}</View> : null}
      </View>
      {full ? null : (
        <View style={s.subRow}>
          {typeof sub === 'string' ? (
            <Text style={s.sub} numberOfLines={1}>
              {sub}
            </Text>
          ) : (
            sub
          )}
        </View>
      )}
    </>
  );
  const style = [s.card, full ? s.full : s.half];
  if (!onPress) {
    return (
      <View style={style} accessible accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  }
  return (
    <PressableScale
      onPress={onPress}
      containerStyle={full ? s.fullWrap : s.halfWrap}
      style={[s.card, s.stretch]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Opens details"
    >
      {body}
    </PressableScale>
  );
}

export const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: 14,
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    half: { flexBasis: '45%', flexGrow: 1, minHeight: 122 },
    full: { flexBasis: '100%' },
    halfWrap: { flexBasis: '45%', flexGrow: 1, minHeight: 122 },
    fullWrap: { flexBasis: '100%' },
    stretch: { flexGrow: 1, minHeight: 122 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 16, paddingRight: 24 },
    title: { ...type.bodyStrong, fontSize: 12, lineHeight: 16, color: c.textMuted, flexShrink: 1 },
    chev: { position: 'absolute', top: 14, right: 14 },
    body: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md, marginTop: 'auto' },
    left: { flexShrink: 1, minWidth: 0, gap: 4 },
    box: { alignItems: 'flex-end', justifyContent: 'flex-end' },
    big: { ...type.monoBold, fontSize: 22, lineHeight: 28, height: 28 },
    unit: { ...type.bodyStrong, fontSize: 12 },
    subRow: { height: 16, marginTop: -4, justifyContent: 'center' },
    sub: { ...type.body, fontSize: 12, lineHeight: 16, color: c.textMuted },
  });
