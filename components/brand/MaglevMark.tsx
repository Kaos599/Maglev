import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View, useWindowDimensions, type HostInstance } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { triggerHaptic } from '../../constants/haptics';
import { useReduceMotion } from '../motion/useReduceMotion';
import { BOOST_ENTER_AT, BOOST_FRAMES, boostTravel, claimArrival, createTapGate, hitSlopFor, steppedRanges } from './markMotion';
import {
  MARK_BODY,
  MARK_BOOST,
  MARK_BOOST_COMPACT,
  MARK_COMPACT_BELOW,
  MARK_CYAN,
  MARK_FX,
  MARK_FX_COMPACT,
  MARK_GHOST,
  MARK_LIME,
  MARK_LINES,
  MARK_RAILS,
  MARK_RATIO,
  MARK_VIEWBOX,
  type MarkFx,
} from './markPaths';

export interface MaglevMarkProps {
  /** Rendered height in dp; width follows the mark's ratio. */
  height?: number;
  /**
   * Play the dash loop: tapered light-trails shed streaks off the back, the band ends smear, and
   * once a loop the train snaps forward. Off (or with reduce motion on) it is the still logo.
   * Trails reach past the mark's left edge, so leave some room there.
   */
  cruising?: boolean;
  /**
   * Tapping the mark plays a boost: the train launches off the right of the screen and comes back
   * in from the left. Works whether or not it is cruising. With reduce motion on, only the haptic.
   */
  tappable?: boolean;
  /** Play the arrival (the train comes in from the left) the first time a mark mounts in this process. */
  arrive?: boolean;
}

const [VB_X, VB_Y, , VB_H] = MARK_VIEWBOX.split(' ').map(Number);
/** Give up waiting to measure for the arrival after this long, and just show the logo. */
const ARRIVAL_WAIT_MS = 1000;

/** Sprite-style interpolation: hold each frame's value for its slice of the clock, then jump. */
function stepped(clock: Animated.Value, values: number[], loop: boolean) {
  return clock.interpolate({ ...steppedRanges(values, loop), extrapolate: 'clamp' });
}

/** Units to whole pixels; a non-zero offset moves at least one pixel. */
const px = (units: number, scale: number) =>
  units === 0 ? 0 : Math.sign(units) * Math.max(1, Math.round(Math.abs(units) * scale));

/** How far (dp) the longest trail of a frame set reaches left of the mark. */
const trailReach = (fx: MarkFx, scale: number) =>
  Math.max(0, VB_X - Math.min(...fx.sprites.map((sp) => Math.min(...sp.frames.map(([x]) => x))))) * scale;

function StillMark({ width, height }: { width: number; height: number }) {
  return (
    <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
      <Path d={MARK_LINES} fill={MARK_CYAN} />
      <Path d={MARK_BODY} fill={MARK_LIME} fillRule="evenodd" />
      <Path d={MARK_RAILS} fill={MARK_CYAN} />
    </Svg>
  );
}

/** A one-shot in flight: the first frame to play and the train's x offset (dp) for every frame. */
type Shot = { from: number; dx: number[] };

/**
 * The Maglev train mark: still, dashing in a loop, or playing a one-shot (tap boost, cold-start
 * arrival). One clock drives every layer of whichever is playing; sprites are native Views moved by
 * the native driver, so nothing re-renders React per frame.
 */
export function MaglevMark({ height = 96, cruising = false, tappable = false, arrive = false }: MaglevMarkProps) {
  const reduce = useReduceMotion();
  const { width: screenWidth } = useWindowDimensions();
  const scale = height / VB_H;
  const width = height * MARK_RATIO;
  const compact = height < MARK_COMPACT_BELOW;
  const loopFx = compact ? MARK_FX_COMPACT : MARK_FX;
  const shotFx = compact ? MARK_BOOST_COMPACT : MARK_BOOST;

  const root = useRef<HostInstance>(null);
  const gate = useRef(createTapGate()).current;
  const loopClock = useRef(new Animated.Value(0)).current;
  const shotClock = useRef(new Animated.Value(0)).current;
  const [shot, setShot] = useState<Shot | null>(null);
  // Until the arrival starts the train is hidden, so it never flashes at rest and then jumps away.
  const [waiting, setWaiting] = useState(() => arrive && claimArrival() && gate.tryStart());
  const run = cruising && !reduce && !shot && !waiting;

  useEffect(() => {
    if (!run) return;
    const anim = Animated.loop(
      Animated.timing(loopClock, { toValue: 1, duration: loopFx.ms, easing: Easing.linear, useNativeDriver: true }),
    );
    anim.start();
    return () => {
      anim.stop();
      loopClock.setValue(0);
    };
  }, [run, loopClock, loopFx]);

  /** Measure where the mark sits, then play the one-shot from frame `from`. The caller holds the gate. */
  const play = useCallback(
    (from: number) => {
      const start = (x: number) => {
        const left = (Number.isFinite(x) ? x : 0) + width + trailReach(shotFx, scale);
        const right = Math.max(width, screenWidth - (Number.isFinite(x) ? x : 0));
        shotClock.setValue(from / BOOST_FRAMES);
        setShot({ from, dx: boostTravel(left, right, height) });
        setWaiting(false);
      };
      if (root.current) root.current.measureInWindow((x) => start(x));
      else start(0);
    },
    [width, height, scale, screenWidth, shotFx, shotClock],
  );

  useEffect(() => {
    if (!shot) return;
    const anim = Animated.timing(shotClock, {
      toValue: 1,
      duration: (shotFx.ms * (BOOST_FRAMES - shot.from)) / BOOST_FRAMES,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (!finished) return;
      gate.finish();
      setShot(null);
    });
    return () => anim.stop();
  }, [shot, shotClock, shotFx, gate]);

  // Arrival: once laid out, check reduce motion from the source (the shared flag may not have loaded
  // this early in a cold start), then come in from the left.
  const arrivalAsked = useRef(false);
  const onLayout = useCallback(() => {
    if (!waiting || arrivalAsked.current) return;
    arrivalAsked.current = true;
    const skip = () => {
      gate.finish();
      setWaiting(false);
    };
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => (on ? skip() : play(BOOST_ENTER_AT)))
      .catch(skip);
  }, [waiting, gate, play]);

  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => {
      gate.finish();
      setWaiting(false);
    }, ARRIVAL_WAIT_MS);
    return () => clearTimeout(t);
  }, [waiting, gate]);

  const onPress = useCallback(() => {
    if (!gate.tryStart()) return;
    triggerHaptic('light');
    if (reduce) {
      gate.finish();
      return;
    }
    play(0);
  }, [gate, reduce, play]);

  const motion = useMemo(() => {
    if (!run && !shot) return null;
    const fx = shot ? shotFx : loopFx;
    const clock = shot ? shotClock : loopClock;
    const loop = !shot;
    return {
      gx: stepped(clock, shot ? shot.dx : fx.group.map(([dx]) => px(dx, scale)), loop),
      gy: stepped(clock, fx.group.map(([, dy]) => px(dy, scale)), loop),
      after: fx.after.map((fr) => ({
        x: stepped(clock, fr.map(([dx]) => px(dx, scale)), loop),
        o: stepped(clock, fr.map(([, o]) => o), loop),
      })),
      sprites: fx.sprites.map((sp) => {
        const [x0, w0] = sp.frames[0];
        return {
          left: (x0 - VB_X) * scale,
          top: (sp.y - VB_Y) * scale,
          width: w0 * scale,
          height: sp.h * scale,
          // scaleX works around the centre, so move the centre to where the frame wants it.
          x: stepped(clock, sp.frames.map(([x, w]) => Math.round((x + w / 2 - (x0 + w0 / 2)) * scale)), loop),
          sx: stepped(clock, sp.frames.map(([, w]) => w / w0), loop),
          o: stepped(clock, sp.frames.map(([, , o]) => o), loop),
        };
      }),
    };
  }, [run, shot, shotFx, loopFx, shotClock, loopClock, scale]);

  const art = motion ? (
    <>
      <Animated.View
        style={[StyleSheet.absoluteFill, { transform: [{ translateX: motion.gx }, { translateY: motion.gy }] }]}
      >
        {motion.after.map((a, j) => (
          <Animated.View key={`a${j}`} style={[StyleSheet.absoluteFill, { opacity: a.o, transform: [{ translateX: a.x }] }]}>
            <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
              {/* Only the band ends smear (MARK_GHOST), so nothing shows in the cut-ins or the window. */}
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
  ) : waiting ? (
    <Svg width={width} height={height} viewBox={MARK_VIEWBOX}>
      <Path d={MARK_RAILS} fill={MARK_CYAN} />
    </Svg>
  ) : (
    <StillMark width={width} height={height} />
  );

  // In flight the train crosses its neighbours, so it draws over them.
  const box = { width, height, zIndex: shot ? 1 : 0 };
  // Still an image to a screen reader: the tap is a flourish, not a control.
  const a11y = { accessible: true, accessibilityRole: 'image', accessibilityLabel: 'Maglev' } as const;

  return tappable ? (
    <Pressable ref={root} style={box} onPress={onPress} onLayout={onLayout} hitSlop={hitSlopFor(width, height)} {...a11y}>
      {art}
    </Pressable>
  ) : (
    <View ref={root} style={box} onLayout={onLayout} collapsable={false} {...a11y}>
      {art}
    </View>
  );
}
