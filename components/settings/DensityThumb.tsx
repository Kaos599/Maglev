import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { TelemetryDensity } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors } from '../../constants/theme';

/**
 * NATIVE_CONTRACT 41.3: the small pixel drawing of a layout, 44x32 dp on a 2 dp grid, plain Views (no images).
 * A card (surface fill, 2 dp strong outline, outer radius 3; every pixel inside is square) with a muted title bar and a
 * light percent bar on the top line, a progress track with a download-coloured fill, then:
 * Compact: one short cyan bar and one muted bar (the speed line). Detailed: a row of three small outlined boxes.
 * Hidden from screen readers; the row that holds it carries the words.
 */
export function DensityThumb({ density }: { density: TelemetryDensity }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.card} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="density-thumb">
      <View style={[s.px, s.title]} />
      <View style={[s.px, s.percent]} />
      <View style={[s.px, s.track]} />
      <View style={[s.px, s.fill]} />
      {density === 'COMPACT' ? (
        <>
          <View style={[s.px, s.speed]} />
          <View style={[s.px, s.speedMuted]} />
        </>
      ) : (
        <>
          <View style={[s.px, s.box, { left: 2 }]} />
          <View style={[s.px, s.box, { left: 14 }]} />
          <View style={[s.px, s.box, { left: 26 }]} />
        </>
      )}
    </View>
  );
}

// Every offset and size below is a multiple of 2 dp, measured inside the 2 dp outline.
const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: { width: 44, height: 32, backgroundColor: c.surface, borderWidth: 2, borderColor: c.borderStrong, borderRadius: 3, overflow: 'hidden' }, // design-exception: thumbnail drawing: pixel geometry
    px: { position: 'absolute', borderRadius: 0 },
    title: { left: 2, top: 2, width: 12, height: 2, backgroundColor: c.textMuted },
    percent: { left: 28, top: 2, width: 8, height: 2, backgroundColor: c.text },
    track: { left: 2, top: 8, width: 36, height: 2, backgroundColor: c.border },
    fill: { left: 2, top: 8, width: 16, height: 2, backgroundColor: c.download },
    speed: { left: 2, top: 14, width: 10, height: 2, backgroundColor: c.download },
    speedMuted: { left: 14, top: 14, width: 8, height: 2, backgroundColor: c.textMuted },
    box: { top: 14, width: 10, height: 8, borderWidth: 2, borderColor: c.borderStrong, backgroundColor: 'transparent' },
  });
