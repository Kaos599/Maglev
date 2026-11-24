import React, { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { ICON_VIEWBOX } from '../icons.generated';
import { GLYPH_MOVE_MS, GlyphTrack, TAB_GLYPHS, TabGlyphName, tracksOf } from './tabGlyphs';

const SIZE = 20;
const UNIT = SIZE / ICON_VIEWBOX;
const crisp = { shapeRendering: 'crispEdges' } as object;
/** Centre of the 24-unit grid. A view scales about its own centre, which is this point. */
const CENTRE = ICON_VIEWBOX / 2;

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

/** Maps a track's output values, keeping its input steps. */
function mapTrack(progress: Animated.Value, t: GlyphTrack, f: (v: number) => number) {
  return progress.interpolate({ inputRange: t.inputRange, outputRange: t.outputRange.map(f) });
}

/**
 * Transforms for a scale track. With an origin, the view also shifts by (1 - s) * (origin - centre),
 * so that grid point stays put: p' = C + s(p - C) + (1 - s)(O - C). Transforms apply in list order,
 * so the scale runs first and the shift second.
 */
function scaleTransforms(progress: Animated.Value, t: GlyphTrack): object[] {
  const scale = mapTrack(progress, t, (s) => s);
  if (!t.origin) return [{ scale }];
  const [ox, oy] = t.origin;
  const shift = (o: number) => mapTrack(progress, t, (s) => (1 - s) * (o - CENTRE) * UNIT);
  return [{ translateX: shift(ox) }, { translateY: shift(oy) }, { scale }];
}

/** Style for every track a part plays. Null when it plays none. */
function styleFor(progress: Animated.Value, tracks: GlyphTrack[]) {
  if (tracks.length === 0) return null;
  const style: { opacity?: Animated.AnimatedInterpolation<number>; transform?: object[] } = {};
  const transform: object[] = [];
  for (const t of tracks) {
    if (t.prop === 'opacity') {
      style.opacity = mapTrack(progress, t, (v) => v);
    } else if (t.prop === 'rotate') {
      transform.push({
        rotate: progress.interpolate({
          inputRange: t.inputRange,
          outputRange: t.outputRange.map((v) => `${v}deg`),
          easing: t.ease ? Easing.out(Easing.cubic) : undefined,
        }),
      });
    } else if (t.prop === 'scale') {
      transform.push(...scaleTransforms(progress, t));
    } else {
      const v = mapTrack(progress, t, (x) => x * UNIT);
      transform.push(t.prop === 'translateX' ? { translateX: v } : { translateY: v });
    }
  }
  if (transform.length) style.transform = transform;
  return style;
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
    () => def.parts.map((p) => ({ part: p, style: styleFor(progress, tracksOf(p)) })),
    [def, progress],
  );
  const wrapStyle = useMemo(() => styleFor(progress, def.wrapTrack ? [def.wrapTrack] : []), [def, progress]);

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
