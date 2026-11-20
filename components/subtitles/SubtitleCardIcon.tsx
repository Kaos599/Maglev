import React, { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import type { ThemeColors } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { cardIconLabel, type CardIconModel } from './flow';
import { radius } from '../../constants/theme';

interface Props {
  model: CardIconModel;
  onPress: () => void;
}

/** One badge cell is 2 dp (NATIVE_CONTRACT 44.8). Rows run top to bottom, `#` is a filled cell. */
const CELL = 2;
const BADGE_BITMAPS = {
  /** A check mark, 5 x 4 cells. */
  saved: ['....#', '...#.', '#.#..', '.#...'],
  /** A question mark, 3 x 5 cells. */
  'needs-look': ['###', '..#', '.##', '...', '.#.'],
} as const;

type BadgeState = keyof typeof BADGE_BITMAPS;

/** The small check or ? drawn on a 2 dp grid (44.8), shared with the Subtitles row (44.14). Place it over the glyph's top right. */
export function SubtitleBadge({ state, color }: { state: BadgeState; color: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.badge} importantForAccessibility="no-hide-descendants">
      {BADGE_BITMAPS[state].map((row, y) => (
        <View key={y} style={styles.row}>
          {row.split('').map((c, x) => (
            <View key={x} style={{ width: CELL, height: CELL, backgroundColor: c === '#' ? color : 'transparent' }} />
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * Top right of a transfer card, only after subtitles were asked for on that item (36.10, 44.8). The state is told
 * by shape, not by colour alone:
 * - getting: the dotted ring around the glyph, muted.
 * - saved: the glyph with a small check badge (accentText).
 * - needs a pick: a small ? badge in the text colour, never a warning colour.
 * - none, offline, limited: the muted glyph, no badge.
 * The glyph is 20 px; hitSlop makes the tap area 44 px.
 */
function SubtitleCardIconImpl({ model, onPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const badge: BadgeState | null = model.state === 'saved' || model.state === 'needs-look' ? model.state : null;
  const badgeColor = model.state === 'saved' ? colors.accentText : colors.text;
  const glyph = model.state === 'saved' ? colors.accentText : model.state === 'needs-look' ? colors.text : colors.textMuted;
  return (
    <PressableScale
      onPress={onPress}
      scaleTo={0.92}
      hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
      accessibilityRole="button"
      accessibilityLabel={cardIconLabel(model)}
      testID="subtitle-card-icon"
      style={styles.box}
    >
      {model.state === 'getting' ? <View style={[styles.ring, { borderColor: colors.textMuted }]} /> : null}
      <PixelIcon name="subtitles" size={20} color={glyph} />
      {badge ? <SubtitleBadge state={badge} color={badgeColor} /> : null}
    </PressableScale>
  );
}

export const SubtitleCardIcon = memo(SubtitleCardIconImpl, (a, b) => a.onPress === b.onPress && a.model.state === b.model.state && a.model.lang === b.model.lang);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    box: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    ring: { position: 'absolute', width: 28, height: 28, borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dotted' },
    // A card-coloured patch under the badge keeps it readable over the glyph.
    badge: { position: 'absolute', top: -2, right: -2, padding: 1, backgroundColor: c.surface },
    row: { flexDirection: 'row' },
  });
