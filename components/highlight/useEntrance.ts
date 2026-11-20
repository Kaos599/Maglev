import { useCallback, useEffect, useRef } from 'react';
import { Easing, SharedValue, cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { haptic } from '../../constants/haptics';
import { useMotion } from '../ui/useMotion';
import { HIGHLIGHT_MOTION as M, IMPACT_MS } from './timing';
import { riseAt } from './timeline';

export interface Entrance {
  /** Milliseconds since the card opened, 0 to `totalMs`. One value drives the card, the train, the burst, the badge and the words. */
  clock: SharedValue<number>;
}

/**
 * Plays the entrance once, on mount. With reduce motion it jumps to the last frame: card in, train parked, badge
 * placed, no burst, no haptic. The haptic fires when the badge lands on the card's edge, from a callback scheduled
 * on that moment (`IMPACT_MS`), not from the effect. Once the dialog is closing (`open` false) or gone, the scheduled
 * haptic is cancelled and the callback is guarded, so Back or a button tapped mid-entrance never buzzes afterwards.
 */
export function useEntrance(open: boolean = true): Entrance {
  const m = useMotion();
  const clock = useSharedValue(0);
  const gate = useSharedValue(0);
  const live = useRef(open);
  live.current = open;
  const onImpact = useCallback(() => {
    if (live.current) haptic('done');
  }, []);

  // Closing (or unmounting) before the badge lands drops the pending haptic.
  useEffect(() => {
    if (!open) cancelAnimation(gate);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      live.current = false;
      cancelAnimation(gate);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    cancelAnimation(clock);
    cancelAnimation(gate);
    if (m.disabled) {
      clock.value = M.totalMs;
      return;
    }
    clock.value = 0;
    clock.value = withTiming(M.totalMs, { duration: M.totalMs, easing: Easing.linear });
    gate.value = withDelay(
      IMPACT_MS,
      withTiming(1, { duration: 1 /* design-exception: a one-frame step, not motion */ }, (finished) => {
        if (finished) scheduleOnRN(onImpact);
      }),
    );
    // Plays once per mount; only the reduce-motion flag restarts it.
  }, [m.disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  return { clock };
}

/** Fade and rise for the nth item of the content (`cq` points per 1% of the design's width), 40 ms after the one before. */
export function useStagger(clock: SharedValue<number>, index: number, cq: number) {
  return useAnimatedStyle(() => {
    const k = riseAt(clock.value, index);
    return { opacity: k.opacity, transform: [{ translateY: k.rise * cq }] };
  });
}
