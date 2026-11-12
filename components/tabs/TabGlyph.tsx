import React, { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { ICON_VIEWBOX } from '../icons.generated';
import { GLYPH_MOVE_MS, GlyphTrack, TAB_GLYPHS, TabGlyphName } from './tabGlyphs';

const SIZE = 20;
const UNIT = SIZE / ICON_VIEWBOX;
const crisp = { shapeRendering: 'crispEdges' } as object;

/**
 * One progress value per tab button. It rests at 1 and runs 0 to 1 once each time `focused`
 * turns true: never on mount, never looping, never with reduce motion on. Share the returned
 * value between every <TabGlyph> of the button so the copies move together.
 */
export function useTabMove(focused: boolean, reduce: boolean): Animated.Value {
  const progress = useRef(new Animated.Value(1)).current;
  const was = useRef(focused);

  useEffect(() => {
    const turnedOn = focused && !was.current;
    was.current = focused;
    if (!turnedOn || reduce) {
      progress.stopAnimation();
      progress.setValue(1);
      return;
    }
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: GLYPH_MOVE_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    }).start();
  }, [focused, reduce, progress]);

  return progress;
}

function interpolateTrack(progress: Animated.Value, t: GlyphTrack) {
  if (t.prop === 'rotate') {
    return progress.interpolate({
      inputRange: t.inputRange,
      outputRange: t.outputRange.map((v) => `${v}deg`),
      easing: t.ease ? Easing.out(Easing.cubic) : undefined,
    });
  }
  const scale = t.prop === 'translateY' ? UNIT : 1;
  return progress.interpolate({ inputRange: t.inputRange, outputRange: t.outputRange.map((v) => v * scale) });
}

function styleFor(progress: Animated.Value, t: GlyphTrack | undefined) {
  if (!t) return null;
  const v = interpolateTrack(progress, t);
  if (t.prop === 'opacity') return { opacity: v };
  return { transform: [t.prop === 'rotate' ? { rotate: v } : { translateY: v }] };
}

export interface TabGlyphProps {
  name: TabGlyphName;
  color: string;
  progress: Animated.Value;
}

/** A tab icon drawn from its parts. At rest it is pixel-identical to <PixelIcon size={20}>. */
export const TabGlyph = memo(function TabGlyph({ name, color, progress }: TabGlyphProps) {
  const def = TAB_GLYPHS[name];
  const parts = useMemo(
    () => def.parts.map((p) => ({ part: p, style: styleFor(progress, p.track) })),
    [def, progress],
  );
  const wrapStyle = useMemo(() => styleFor(progress, def.wrapTrack), [def, progress]);

  const body = parts.map(({ part, style }) => (
    <Animated.View key={part.id} style={[StyleSheet.absoluteFill, style]}>
      <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} {...crisp}>
        <Path d={part.d} fill={color} {...crisp} />
      </Svg>
    </Animated.View>
  ));

  return (
    <View style={styles.box}>
      {wrapStyle ? <Animated.View style={[StyleSheet.absoluteFill, wrapStyle]}>{body}</Animated.View> : body}
    </View>
  );
});

const styles = StyleSheet.create({ box: { width: SIZE, height: SIZE } });

export default TabGlyph;
