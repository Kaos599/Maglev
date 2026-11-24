import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import { MaglevMark } from '../brand/MaglevMark';
import { useReduceMotion } from '../motion/useReduceMotion';
import { motion } from '../../constants/theme';

/**
 * The pixel train under the browser header while a page is pulled or reloading (0.34 section 4, option A).
 * The native view reports the pull and the reload; this strip only moves one Animated.Value, so no event
 * re-renders it. It never takes touches (pointerEvents none).
 */

/** Strip height in dp. The train is MARK_HEIGHT tall and centred in it. */
const STRIP_HEIGHT = 28;
const MARK_HEIGHT = 18;
/** Off the left edge (dp), and where the train rests while pulled past the threshold or reloading. */
const HIDDEN_X = -64;
const REST_X = 16;
/** The slide back and the start of a reload take the release token (160 ms). The exit is 260 ms by contract. */
const SLIDE_MS = motion.duration.release;
const EXIT_MS = 260;
/** The exit ends this far past the right edge (dp). */
const EXIT_PAST_EDGE = 64;

export type ReloadStripHandle = {
  /** Pull progress from the view, 0 to 1.5. 0 means released: the train slides back. Ignored while reloading. */
  pull(progress: number): void;
  /** A reload started (pull, menu or command): the train rests in the strip and cruises until reloadEnd. */
  reloadStart(): void;
  /** The reload ended: the train exits to the right, then waits off screen. */
  reloadEnd(): void;
  /** Hides the train at once (for example when the active tab changes). */
  reset(): void;
};

export const ReloadStrip = forwardRef<ReloadStripHandle, object>(function ReloadStrip(_props, ref) {
  const reduce = useReduceMotion();
  const { width: screenWidth } = useWindowDimensions();
  const x = useRef(new Animated.Value(HIDDEN_X)).current;
  const [cruising, setCruising] = useState(false);
  // The handle is created once, so it reads these through refs instead of re-rendering per event.
  const reloading = useRef(false);
  const exiting = useRef(false);
  const cruisingNow = useRef(false);
  const reduceNow = useRef(reduce);
  reduceNow.current = reduce;
  const widthNow = useRef(screenWidth);
  widthNow.current = screenWidth;

  useImperativeHandle(
    ref,
    () => {
      const setCruise = (on: boolean) => {
        if (cruisingNow.current === on) return;
        cruisingNow.current = on;
        setCruising(on);
      };
      return {
        pull(progress: number) {
          // Reduce motion: no sprite motion while pulling (the reload still shows the static mark).
          if (reloading.current || exiting.current || reduceNow.current) return;
          if (progress <= 0) {
            // Released short of the threshold: slide back out.
            setCruise(false);
            Animated.timing(x, { toValue: HIDDEN_X, duration: SLIDE_MS, useNativeDriver: true }).start();
            return;
          }
          // setValue stops a slide-back that is still running.
          x.setValue(HIDDEN_X + (REST_X - HIDDEN_X) * Math.min(progress, 1));
          // Past the threshold the train stays at rest and cruises: "release now".
          setCruise(progress >= 1);
        },
        reloadStart() {
          reloading.current = true;
          exiting.current = false;
          x.stopAnimation();
          if (reduceNow.current) {
            // Reduce motion: the mark appears at rest and does not move.
            x.setValue(REST_X);
            setCruise(false);
            return;
          }
          setCruise(true);
          Animated.timing(x, { toValue: REST_X, duration: SLIDE_MS, useNativeDriver: true }).start();
        },
        reloadEnd() {
          reloading.current = false;
          x.stopAnimation();
          if (reduceNow.current) {
            x.setValue(HIDDEN_X);
            setCruise(false);
            return;
          }
          // The train keeps cruising while it leaves; it stops once it is off screen.
          exiting.current = true;
          Animated.timing(x, {
            toValue: widthNow.current + EXIT_PAST_EDGE,
            duration: EXIT_MS, // design-exception: 0.34 section 4 sets the exit at 260 ms, above the 250 ms ceiling
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }).start(({ finished }) => {
            // A stopped exit (a new reload or a reset) reports finished false and leaves the train alone.
            if (!finished) return;
            exiting.current = false;
            setCruise(false);
            x.setValue(HIDDEN_X);
          });
        },
        reset() {
          reloading.current = false;
          exiting.current = false;
          x.stopAnimation();
          x.setValue(HIDDEN_X);
          if (cruisingNow.current) {
            cruisingNow.current = false;
            setCruising(false);
          }
        },
      };
    },
    [x],
  );

  return (
    <View pointerEvents="none" style={styles.strip}>
      <Animated.View style={{ transform: [{ translateX: x }] }}>
        <MaglevMark height={MARK_HEIGHT} cruising={cruising} />
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: STRIP_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
    zIndex: 2,
  },
});
