import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path } from 'react-native-svg';
import { useReduceMotion } from '../motion/useReduceMotion';
import { useTheme } from '../../context/ThemeContext';

/**
 * The reload disc under the browser header while a page is pulled or reloading (0.35 section 4, "Sleek arc").
 * A 40 dp disc slides out from under the bar with a rubber band, holds a 2.5 dp accent arc that grows with the
 * pull, spins (Material indeterminate) while loading, closes and lifts away when done. Ported from the canvas
 * board option A. Every frame runs on the UI thread from shared values; the handle only writes them, so no event
 * re-renders this component. It never takes touches (pointerEvents none).
 */

const DISC = 40;
const INNER = DISC - 2; // inside the 1 px border
const CENTER = INNER / 2;
const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Native progress 1 is this many dp of pull. */
const TRIGGER_DP = 72;
const MAX_PULL = 120;
/** Where the disc sits while loading (dp of travel under the bar). */
const REST = 56;
const CLOSE_MS = 150; // design-exception: 0.35 section 4 sets the ring close at 150 ms
const EXIT_MS = 220; // design-exception: 0.35 section 4 sets the exit at 220 ms
const FADE_MS = 200; // design-exception: reduce-motion fade-out and early-release fade
const POP_MS = 200; // design-exception: arrowhead pop at the trigger, from the canvas board
/** One indeterminate cycle is about 1.1 s; the steady rotation keeps the demo's 1568/1333 ratio. */
const CYCLE_MS = 1100;
const ROT_MS = (CYCLE_MS * 1568) / 1333;
/** The spin clock runs this long in ms before it would stop (ten minutes). */
const LOAD_MAX_MS = 600000; // design-exception: a spin clock, not a transition
/** Rubber-banded travel at progress 1, used to turn travel back into progress. */
const TRIGGER_Y = MAX_PULL * (1 - Math.exp(-TRIGGER_DP / MAX_PULL));
/** A held release (armed, waiting for the reload to start) gives up after this long. */
const HOLD_MS = 400;

const IDLE = 0;
const DRAG = 1;
const BACK = 2;
const LOAD = 3;
const DONE = 4;
const EXIT = 5;
const FADE = 6;

const SPRING_BACK = { mass: 1, stiffness: 450, damping: 32 };
const SPRING_REST = { mass: 1, stiffness: 300, damping: 24 };

function rubber(d: number): number {
  return MAX_PULL * (1 - Math.exp(-d / MAX_PULL));
}

function clamp01(x: number): number {
  'worklet';
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function easeInOutCubic(x: number): number {
  'worklet';
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function pullStart(y: number): number {
  'worklet';
  return -25 + 40 * Math.min(y / TRIGGER_DP, MAX_PULL / TRIGGER_DP);
}

type Snap = {
  ph: number;
  y: number;
  prog: number;
  pullY: number;
  loadT: number;
  rot0: number;
  fromPull: boolean;
  closeP: number;
  exitP: number;
  fadeP: number;
  o0: number;
  yExit0: number;
  fadeFull: boolean;
  pop: number;
  reduce: boolean;
};

/** Material-style indeterminate arc: steady turn plus head and tail easing in different halves of each cycle. */
function arcLoading(t: number, rot0: number, fromPull: boolean): { start: number; sweep: number } {
  'worklet';
  const cyc = t / CYCLE_MS + (fromPull ? 0.5 : 0);
  const k = Math.floor(cyc);
  const u = cyc - k;
  const head = 240 * easeInOutCubic(clamp01(u / 0.5));
  const tail = 240 * easeInOutCubic(clamp01((u - 0.5) / 0.5));
  return { start: rot0 + (t / ROT_MS) * 360 + k * 240 + tail, sweep: 30 + head - tail };
}

function geometry(s: Snap): { start: number; sweep: number; arrow: number } {
  'worklet';
  const ph = s.ph;
  const pulling = ph === DRAG || ph === BACK || (ph === FADE && !s.fadeFull);
  const pop = !s.reduce ? 1 + 0.15 * Math.sin(Math.PI * s.pop) : 1;
  if (pulling) {
    const p = ph === BACK && !s.reduce ? clamp01(s.y / TRIGGER_Y) : s.prog;
    return {
      start: s.reduce ? 0 : pullStart(ph === BACK ? s.y : s.pullY),
      sweep: 270 * p,
      arrow: pop,
    };
  }
  if (ph === LOAD) {
    if (s.reduce) return { start: 0, sweep: 360, arrow: 0 };
    const g = arcLoading(s.loadT, s.rot0, s.fromPull);
    return { start: g.start, sweep: g.sweep, arrow: s.fromPull ? 1 - clamp01(s.loadT / 150) : 0 };
  }
  if (ph === DONE) {
    const g = arcLoading(s.loadT, s.rot0, s.fromPull);
    return { start: g.start, sweep: g.sweep + (360 - g.sweep) * s.closeP, arrow: 0 };
  }
  if (ph === EXIT) {
    const g = arcLoading(s.loadT, s.rot0, s.fromPull);
    return { start: g.start, sweep: 360, arrow: 0 };
  }
  if (ph === FADE) return { start: 0, sweep: 360, arrow: 0 };
  return { start: 0, sweep: 0, arrow: 0 };
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

export type ReloadStripHandle = {
  /** Pull progress from the view, 0 to 1.5. 0 means released. Ignored while reloading. */
  pull(progress: number): void;
  /** A reload started (pull, menu or command): the disc springs to rest and spins until reloadEnd. */
  reloadStart(): void;
  /** The reload ended: the ring closes, then the disc shrinks and lifts away. */
  reloadEnd(): void;
  /** Hides the disc at once (for example when the active tab changes). */
  reset(): void;
};

export const ReloadStrip = forwardRef<ReloadStripHandle, object>(function ReloadStrip(_props, ref) {
  const { colors } = useTheme();
  const reduce = useReduceMotion();

  const phase = useSharedValue(IDLE);
  const y = useSharedValue(0);
  const pullY = useSharedValue(0);
  const prog = useSharedValue(0);
  const loadT = useSharedValue(0);
  const rot0 = useSharedValue(0);
  const fromPull = useSharedValue(false);
  const closeP = useSharedValue(0);
  const exitP = useSharedValue(0);
  const yExit0 = useSharedValue(0);
  const fadeP = useSharedValue(0);
  const o0 = useSharedValue(1);
  const fadeFull = useSharedValue(false);
  const pop = useSharedValue(1);
  const reduceSv = useSharedValue(reduce);

  const reduceNow = useRef(reduce);
  reduceNow.current = reduce;
  useEffect(() => {
    reduceSv.value = reduce;
  }, [reduce, reduceSv]);

  const flags = useRef({ dragging: false, pulled: false, armed: false, loading: false, lastPullY: 0 });
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useImperativeHandle(
    ref,
    () => {
      const clearHold = () => {
        if (holdTimer.current) clearTimeout(holdTimer.current);
        holdTimer.current = null;
      };
      const stopAll = () => {
        cancelAnimation(y);
        cancelAnimation(loadT);
        cancelAnimation(closeP);
        cancelAnimation(exitP);
        cancelAnimation(fadeP);
        cancelAnimation(pop);
      };
      const fadeOut = (full: boolean, from: number) => {
        phase.value = FADE;
        fadeFull.value = full;
        o0.value = from;
        fadeP.value = 0;
        fadeP.value = withTiming(1, { duration: FADE_MS, easing: Easing.linear }, (finished) => {
          if (finished) phase.value = IDLE;
        });
      };
      const release = () => {
        clearHold();
        const f = flags.current;
        f.dragging = false;
        f.armed = false;
        if (reduceNow.current) {
          fadeOut(false, clamp01(f.lastPullY / (TRIGGER_DP * 0.3)));
          return;
        }
        phase.value = BACK;
        y.value = withSpring(0, SPRING_BACK, (finished) => {
          if (finished) {
            phase.value = IDLE;
            y.value = 0;
          }
        });
      };
      return {
        pull(progress: number) {
          const f = flags.current;
          if (f.loading) return;
          if (progress <= 0) {
            if (!f.dragging) return;
            if (f.armed) {
              // Released past the line: the reload is about to start. Wait for it, but never hang.
              clearHold();
              holdTimer.current = setTimeout(release, HOLD_MS);
            } else {
              release();
            }
            return;
          }
          clearHold();
          if (!f.dragging) {
            f.dragging = true;
            f.pulled = true;
            stopAll();
            fadeP.value = 0;
            pop.value = 1;
            phase.value = DRAG;
          }
          const d = progress * TRIGGER_DP;
          const travel = rubber(d);
          f.lastPullY = travel;
          pullY.value = travel;
          prog.value = Math.min(1, progress);
          y.value = reduceNow.current ? REST : travel;
          if (!f.armed && progress >= 1) {
            f.armed = true;
            if (!reduceNow.current) {
              pop.value = 0;
              pop.value = withTiming(1, { duration: POP_MS, easing: Easing.linear });
            }
          } else if (f.armed && progress < 1) {
            f.armed = false;
          }
        },
        reloadStart() {
          const f = flags.current;
          if (f.loading) return;
          clearHold();
          stopAll();
          f.loading = true;
          f.dragging = false;
          f.armed = false;
          const pulled = f.pulled;
          fromPull.value = pulled && !reduceNow.current;
          rot0.value = pulled && !reduceNow.current ? pullStart(f.lastPullY) : 0;
          fadeFull.value = false;
          phase.value = LOAD;
          if (reduceNow.current) {
            y.value = REST;
          } else {
            if (!pulled) y.value = 0;
            y.value = withSpring(REST, SPRING_REST);
            loadT.value = 0;
            loadT.value = withTiming(LOAD_MAX_MS, { duration: LOAD_MAX_MS, easing: Easing.linear });
          }
        },
        reloadEnd() {
          const f = flags.current;
          if (!f.loading) return;
          f.loading = false;
          f.pulled = false;
          clearHold();
          if (reduceNow.current) {
            fadeOut(true, 1);
            return;
          }
          // Freeze the spin where it is, close the ring, then shrink and lift.
          cancelAnimation(loadT);
          cancelAnimation(exitP);
          phase.value = DONE;
          closeP.value = 0;
          closeP.value = withTiming(
            1,
            { duration: CLOSE_MS, easing: Easing.out(Easing.cubic) },
            (finished) => {
              if (!finished) return;
              phase.value = EXIT;
              yExit0.value = y.value;
              exitP.value = 0;
              exitP.value = withTiming(
                1,
                { duration: EXIT_MS, easing: Easing.in(Easing.cubic) },
                (done) => {
                  if (!done) return;
                  phase.value = IDLE;
                  y.value = 0;
                },
              );
            },
          );
        },
        reset() {
          clearHold();
          stopAll();
          cancelAnimation(exitP);
          flags.current = { dragging: false, pulled: false, armed: false, loading: false, lastPullY: 0 };
          phase.value = IDLE;
          y.value = 0;
        },
      };
    },
    [phase, y, pullY, prog, loadT, rot0, fromPull, closeP, exitP, yExit0, fadeP, o0, fadeFull, pop],
  );

  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );

  const read = (): Snap => {
    'worklet';
    return {
      ph: phase.value,
      y: y.value,
      prog: prog.value,
      pullY: pullY.value,
      loadT: loadT.value,
      rot0: rot0.value,
      fromPull: fromPull.value,
      closeP: closeP.value,
      exitP: exitP.value,
      fadeP: fadeP.value,
      o0: o0.value,
      yExit0: yExit0.value,
      fadeFull: fadeFull.value,
      pop: pop.value,
      reduce: reduceSv.value,
    };
  };

  const discStyle = useAnimatedStyle(() => {
    const s = read();
    let ty = 0;
    let o = 0;
    let sc = 0.6;
    const f = clamp01(Math.max(0, s.ph === BACK ? s.y : s.pullY) / (TRIGGER_DP * 0.3));
    if (s.ph === DRAG || s.ph === BACK) {
      ty = s.reduce ? REST : s.ph === BACK ? s.y : s.pullY;
      o = f;
      sc = s.reduce ? 1 : 0.6 + 0.4 * f;
    } else if (s.ph === FADE) {
      ty = REST;
      sc = 1;
      o = s.o0 * (1 - clamp01(s.fadeP));
    } else if (s.ph === LOAD || s.ph === DONE) {
      ty = s.reduce ? REST : s.y;
      o = 1;
      sc = 1;
    } else if (s.ph === EXIT) {
      const ee = clamp01(s.exitP);
      ty = s.yExit0 * (1 - ee);
      sc = 1 - ee;
      o = 1;
    }
    return { opacity: o, transform: [{ translateY: ty }, { scale: Math.max(0, sc) }] };
  });

  const spinStyle = useAnimatedStyle(() => {
    return { transform: [{ rotate: `${geometry(read()).start}deg` }] };
  });

  const arcProps = useAnimatedProps(() => {
    const g = geometry(read());
    const len = (Math.min(360, g.sweep) / 360) * CIRCUMFERENCE;
    return { strokeDasharray: [len, 100], opacity: g.sweep < 1.5 ? 0 : 1 };
  });

  const arrowProps = useAnimatedProps(() => {
    const g = geometry(read());
    const a = (g.sweep * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // Triangle pointing along the tangent, scaled about the centre, moved to the arc tip, turned with the sweep.
    const pts = [
      [0, -3.2],
      [3.4, 0],
      [0, 3.2],
    ];
    let d = '';
    for (let i = 0; i < 3; i++) {
      const px = pts[i][0] * g.arrow;
      const py = pts[i][1] * g.arrow - RADIUS;
      const x = CENTER + px * cos - py * sin;
      const yy = CENTER + px * sin + py * cos;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${yy.toFixed(2)}`;
    }
    return { d: `${d}Z`, opacity: g.arrow > 0.01 ? 1 : 0 };
  });

  return (
    <Animated.View pointerEvents="none" style={styles.strip}>
      <Animated.View
        style={[styles.disc, { backgroundColor: colors.surface, borderColor: colors.border }, discStyle]}
      >
        <Animated.View style={[styles.spin, spinStyle]}>
          <Svg width={INNER} height={INNER} viewBox={`0 0 ${INNER} ${INNER}`}>
            <AnimatedCircle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke={colors.accent}
              strokeWidth={2.5}
              strokeLinecap="round"
              rotation={-90}
              origin={`${CENTER}, ${CENTER}`}
              animatedProps={arcProps}
            />
            <AnimatedPath fill={colors.accent} animatedProps={arrowProps} />
          </Svg>
        </Animated.View>
      </Animated.View>
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  // Clips the disc at the top edge so it emerges from under the header. Tall enough for the longest pull.
  strip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: MAX_PULL + 8,
    overflow: 'hidden',
    zIndex: 2,
  },
  disc: {
    position: 'absolute',
    top: -DISC,
    left: '50%',
    marginLeft: -DISC / 2,
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    borderWidth: 1,
    opacity: 0,
  },
  spin: { width: INNER, height: INNER },
});
