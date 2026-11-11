import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useReduceMotion } from '../motion/useReduceMotion';
import {
  MARK_BODY,
  MARK_CYAN,
  MARK_FX,
  MARK_GHOST,
  MARK_LIME,
  MARK_LINES,
  MARK_RAILS,
  MARK_RATIO,
  MARK_VIEWBOX,
} from './markPaths';

export interface MaglevMarkProps {
  /** Rendered height in dp; width follows the mark's ratio. */
  height?: number;
  /**
   * Play the dash loop: trails stretch off the back, afterimages smear behind, wind and ground
   * dashes whip past and the train surges. Off (or with reduce motion on) it is the still logo.
   * Trails reach past the mark's left edge, so leave some room there.
   */
  cruising?: boolean;
}

const [VB_X, VB_Y, , VB_H] = MARK_VIEWBOX.split(' ').map(Number);
const EPS = 1e-4;

/** Sprite-style interpolation: hold each frame's value for its slice of the loop, then jump. */
function stepped(clock: Animated.Value, values: number[]) {
  const n = values.length;
  const inputRange: number[] = [];
  const outputRange: number[] = [];
  values.forEach((v, k) => {
    inputRange.push(k / n, (k + 1) / n - EPS);
    outputRange.push(v, v);
  });
  inputRange.push(1);
  outputRange.push(values[0]);
  return clock.interpolate({ inputRange, outputRange, extrapolate: 'clamp' });
}

/** Units to whole pixels; a non-zero offset moves at least one pixel. */
const px = (units: number, scale: number) =>
  units === 0 ? 0 : Math.sign(units) * Math.max(1, Math.round(Math.abs(units) * scale));

function StillMark({ width, height }: { width: number; height: number }) {
  return (
    <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
      <Path d={MARK_LINES} fill={MARK_CYAN} />
      <Path d={MARK_BODY} fill={MARK_LIME} fillRule="evenodd" />
      <Path d={MARK_RAILS} fill={MARK_CYAN} />
    </Svg>
  );
}

/**
 * The Maglev train mark, optionally dashing. One clock drives every layer; sprites are native
 * Views moved by the native driver, so the loop never re-renders React.
 */
export function MaglevMark({ height = 96, cruising = false }: MaglevMarkProps) {
  const reduce = useReduceMotion();
  const run = cruising && !reduce;
  const scale = height / VB_H;
  const width = height * MARK_RATIO;
  const clock = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!run) return;
    const anim = Animated.loop(
      Animated.timing(clock, { toValue: 1, duration: MARK_FX.ms, easing: Easing.linear, useNativeDriver: true }),
    );
    anim.start();
    return () => {
      anim.stop();
      clock.setValue(0);
    };
  }, [run, clock]);

  const motion = useMemo(() => {
    if (!run) return null;
    return {
      gx: stepped(clock, MARK_FX.group.map(([dx]) => px(dx, scale))),
      gy: stepped(clock, MARK_FX.group.map(([, dy]) => px(dy, scale))),
      after: MARK_FX.after.map((fr) => ({
        x: stepped(clock, fr.map(([dx]) => px(dx, scale))),
        o: stepped(clock, fr.map(([, o]) => o)),
      })),
      sprites: MARK_FX.sprites.map((sp) => {
        const [x0, w0] = sp.frames[0];
        return {
          left: (x0 - VB_X) * scale,
          top: (sp.y - VB_Y) * scale,
          width: w0 * scale,
          height: sp.h * scale,
          // scaleX works around the centre, so move the centre to where the frame wants it.
          x: stepped(clock, sp.frames.map(([x, w]) => Math.round((x + w / 2 - (x0 + w0 / 2)) * scale))),
          sx: stepped(clock, sp.frames.map(([, w]) => w / w0)),
          o: stepped(clock, sp.frames.map(([, , o]) => o)),
        };
      }),
    };
  }, [run, clock, scale]);

  return (
    <View style={{ width, height }} accessible accessibilityRole="image" accessibilityLabel="Maglev">
      {motion ? (
        <>
          <Animated.View
            style={[StyleSheet.absoluteFill, { transform: [{ translateX: motion.gx }, { translateY: motion.gy }] }]}
          >
            {motion.after.map((a, j) => (
              <Animated.View key={`a${j}`} style={[StyleSheet.absoluteFill, { opacity: a.o, transform: [{ translateX: a.x }] }]}>
                <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
                  {/* Only the train's back smears (MARK_GHOST), so it never shows through the window. */}
                  <Path d={MARK_GHOST} fill={MARK_LIME} />
                </Svg>
              </Animated.View>
            ))}
            {motion.sprites.map((sp, i) => (
              <Animated.View
                key={i}
                style={{
                  position: 'absolute',
                  left: sp.left,
                  top: sp.top,
                  width: sp.width,
                  height: sp.height,
                  backgroundColor: MARK_CYAN,
                  opacity: sp.o,
                  transform: [{ translateX: sp.x }, { scaleX: sp.sx }],
                }}
              />
            ))}
            <Svg width={width} height={height} viewBox={MARK_VIEWBOX} style={StyleSheet.absoluteFill}>
              <Path d={MARK_BODY} fill={MARK_LIME} fillRule="evenodd" />
            </Svg>
          </Animated.View>
          <Svg width={width} height={height} viewBox={MARK_VIEWBOX} style={StyleSheet.absoluteFill}>
            <Path d={MARK_RAILS} fill={MARK_CYAN} />
          </Svg>
        </>
      ) : (
        <StillMark width={width} height={height} />
      )}
    </View>
  );
}
