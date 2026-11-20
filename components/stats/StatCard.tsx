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
  /** Every picture sits in the same 40 dp box (20 art pixels at 2 dp). 'none' for a card without one. */
  box?: 'half' | 'full' | 'dial' | 'none';
  full?: boolean;
  icon?: PixelIconName;
  iconColor?: string;
  accessibilityLabel: string;
}

const PIC_BOX = { width: 40, height: 40 };
const BOX = { half: PIC_BOX, full: PIC_BOX, dial: PIC_BOX, none: { width: 0, height: 0 } };

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
      style={[s.card, full ? s.stretchFull : s.stretch]}
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
      padding: 14, // design-exception: tile padding 14 matches the chevron inset (top/right 14) and the minHeight 122 tile geometry
      gap: spacing.sm,
      justifyContent: 'space-between',
    },
    half: { flexBasis: '45%', flexGrow: 1, minHeight: 122 },
    full: { flexBasis: '100%' },
    halfWrap: { flexBasis: '45%', flexGrow: 1, minHeight: 122 },
    fullWrap: { flexBasis: '100%' },
    stretch: { flexGrow: 1, minHeight: 122 },
    // A full card is as tall as its content: the value block never drops away from the title.
    stretchFull: { flexGrow: 1 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, height: 16, paddingRight: spacing.xxl },
    title: { ...type.bodyStrong, fontSize: type.size.sm, lineHeight: 16, color: c.textMuted, flexShrink: 1 },
    chev: { position: 'absolute', top: 14, right: 14 },
    body: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md, marginTop: 'auto' },
    left: { flexShrink: 1, minWidth: 0, gap: spacing.xs },
    box: { alignItems: 'flex-end', justifyContent: 'flex-end' },
    big: { ...type.monoBold, fontSize: type.size.xxl, lineHeight: 28, height: 28 },
    unit: { ...type.bodyStrong, fontSize: type.size.sm },
    subRow: { height: 16, marginTop: -4, justifyContent: 'center' },
    sub: { ...type.body, fontSize: type.size.sm, lineHeight: 16, color: c.textMuted },
  });
