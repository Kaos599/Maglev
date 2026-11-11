import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { FreeSpace } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { PixelIcon } from '../PixelIcon';

interface Props {
  selectedBytes: number;
  totalBytes: number;
  free: FreeSpace | null;
  /** The selection does not fit; the bar turns to the danger colour. */
  tooBig: boolean;
}

/** Space strip under the file count (UI_SPEC S9.2): selected bytes against free space on the target. */
export function SpaceStrip({ selectedBytes, totalBytes, free, tooBig }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const frac = free && free.freeBytes > 0 ? Math.min(1, selectedBytes / free.freeBytes) : 0;
  const staging = free?.mode === 'staging';
  const freeLine = !free
    ? null
    : staging
      ? `Free in Maglev storage ${formatBytes(free.freeBytes)}${
          free.targetFreeBytes != null ? ` · Target folder ${formatBytes(free.targetFreeBytes)}` : ''
        }`
      : `Free on device ${formatBytes(free.freeBytes)}`;
  return (
    <View style={styles.wrap}>
      {free ? (
        <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={[styles.fill, { width: `${frac * 100}%`, backgroundColor: tooBig ? colors.danger : colors.accent }]} />
        </View>
      ) : null}
      <View style={styles.line}>
        <PixelIcon name="storage" size={16} color={colors.textMuted} />
        <Text style={styles.text}>
          Selected {formatBytes(selectedBytes)} of {formatBytes(totalBytes)}
        </Text>
      </View>
      {freeLine ? <Text style={styles.sub}>{freeLine}</Text> : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.xs },
    track: { height: 6, borderRadius: radius.sm, backgroundColor: c.surfaceRaised, overflow: 'hidden' },
    fill: { height: 6 },
    line: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    text: { ...type.mono, fontSize: type.size.sm, color: c.text },
    sub: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, paddingLeft: 20 },
  });
