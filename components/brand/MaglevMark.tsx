import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useReduceMotion } from '../motion/useReduceMotion';
import {
  MARK_BOB,
  MARK_BODY,
  MARK_CYAN,
  MARK_LIME,
  MARK_RAILS,
  MARK_RATIO,
  MARK_STREAKS,
  MARK_VIEWBOX,
} from './markPaths';

export interface MaglevMarkProps {
  /** Rendered height in dp; width follows the mark's ratio. */
  height?: number;
  /**
   * Play the cruise loop: speed lines stream off the back and the train hovers over the rails.
   * Off (or with reduce motion on) the mark sits still in its logo pose.
   */
  cruising?: boolean;
}

const [VB_X, VB_Y, , VB_H] = MARK_VIEWBOX.split(' ').map(Number);
const EPS = 1e-4;

/**
 * Sprite-style interpolation: hold each frame's value for its slice of the loop, then jump.
 * Values are rounded to whole pixels so every frame lands crisp.
 */
function stepped(clock: Animated.Value, frames: number[]) {
  const n = frames.length;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  frames.forEach((v, k) => {
    inputRange.push(k / n, (k + 1) / n - EPS);
    outputRange.push(v, v);
  });
  inputRange.push(1);
  outputRange.push(frames[0]);
  return clock.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
}

/** Units to whole pixels; any non-zero offset moves at least one pixel. */
const px = (units: number, scale: number) => (units === 0 ? 0 : Math.sign(units) * Math.max(1, Math.round(Math.abs(units) * scale)));

/** The Maglev train mark, optionally cruising. Speed lines are native Views so the loop runs on the UI thread. */
export function MaglevMark({ height = 96, cruising = false }: MaglevMarkProps) {
  const reduce = useReduceMotion();
  const run = cruising && !reduce;
  const scale = height / VB_H;
  const width = height * MARK_RATIO;

  const clocks = useRef(MARK_STREAKS.map(() => new Animated.Value(0))).current;
  const bobClock = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!run) return;
    const loop = (v: Animated.Value, ms: number) =>
      Animated.loop(Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true }));
    const anims = [...MARK_STREAKS.map((s, i) => loop(clocks[i], s.ms)), loop(bobClock, MARK_BOB.ms)];
    anims.forEach((a) => a.start());
    return () => {
      anims.forEach((a) => a.stop());
      clocks.forEach((c) => c.setValue(0));
      bobClock.setValue(0);
    };
  }, [run, clocks, bobClock]);

  const motion = useMemo(
    () => ({
      bob: stepped(bobClock, MARK_BOB.frames.map((u) => px(u, scale))),
      streaks: MARK_STREAKS.map((s, i) => ({
        x: stepped(clocks[i], s.frames.map(([dx]) => px(dx, scale))),
        o: stepped(clocks[i], s.frames.map(([, o]) => o)),
      })),
    }),
    [scale, clocks, bobClock],
  );

  return (
    <View
      style={{ width, height, overflow: 'hidden' }}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Maglev"
    >
      <Animated.View style={[StyleSheet.absoluteFill, run && { transform: [{ translateY: motion.bob }] }]}>
        {MARK_STREAKS.map((s, i) => (
          <Animated.View
            key={i}
            style={[
              {
                position: 'absolute',
                left: (s.x - VB_X) * scale,
                top: (s.y - VB_Y) * scale,
                width: s.w * scale,
                height: s.h * scale,
                backgroundColor: MARK_CYAN,
              },
              run && { opacity: motion.streaks[i].o, transform: [{ translateX: motion.streaks[i].x }] },
            ]}
          />
        ))}
        {/* The body is drawn over the lines, so a line starting a loop slides out from behind it. */}
        <Svg width={width} height={height} viewBox={MARK_VIEWBOX} style={StyleSheet.absoluteFill}>
          <Path d={MARK_BODY} fill={MARK_LIME} fillRule="evenodd" />
        </Svg>
      </Animated.View>
      <Svg width={width} height={height} viewBox={MARK_VIEWBOX} style={StyleSheet.absoluteFill}>
        <Path d={MARK_RAILS} fill={MARK_CYAN} />
      </Svg>
    </View>
  );
}
