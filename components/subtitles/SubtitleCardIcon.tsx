import React, { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import type { ThemeColors } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { cardIconLabel, type CardIconModel } from './flow';

interface Props {
  model: CardIconModel;
  onPress: () => void;
}

/**
 * Top right of a transfer card, only after the user asked for subtitles on that item (36.10).
 * Getting: a dotted ring around the glyph. Saved: a lime dot. Needs a look: the warning colour and a dot.
 * The glyph is 20 px; hitSlop makes the tap area 44 px.
 */
function SubtitleCardIconImpl({ model, onPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tint = model.state === 'needs-look' ? colors.warning : model.state === 'saved' ? colors.accentText : colors.download;
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
      {model.state === 'getting' ? <View style={[styles.ring, { borderColor: tint }]} /> : null}
      <PixelIcon name="file-doc" size={20} color={tint} />
      {model.state !== 'getting' ? <View style={[styles.dot, { backgroundColor: tint }]} /> : null}
    </PressableScale>
  );
}

export const SubtitleCardIcon = memo(SubtitleCardIconImpl, (a, b) => a.onPress === b.onPress && a.model.state === b.model.state && a.model.lang === b.model.lang);

const makeStyles = (_c: ThemeColors) =>
  StyleSheet.create({
    box: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    ring: { position: 'absolute', width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderStyle: 'dotted' },
    dot: { position: 'absolute', top: 0, right: 0, width: 6, height: 6, borderRadius: 3 },
  });
