import { Animated, Easing } from 'react-native';

/** Motion durations (ms). Everything sits in 120-220 ms. */
export const duration = {
  /** Finger down: fast, so the press reads as immediate. */
  press: 120,
  /** Finger up: a touch slower than press so the return is visible. */
  release: 160,
  /** Focus or selection change (tab icon, pill, label weight). */
  focus: 180,
  /** One-shot entrance (empty states). */
  enter: 220,
} as const;

/** Ease-out cubic: starts fast, settles softly. No springs, no bounce. */
export const easeOut = Easing.out(Easing.cubic);

/** Whole pixels an icon sinks while pressed. An integer, so the held icon stays crisp. */
export const PRESS_SINK = 2;

/**
 * Animate a value on the native driver, or jump straight to the target when motion is reduced.
 * Starting a new timing on the same value interrupts the old one, so this is safe to call mid-flight.
 */
export function animateTo(value: Animated.Value, toValue: number, ms: number, reduce: boolean): void {
  if (reduce) {
    value.stopAnimation();
    value.setValue(toValue);
    return;
  }
  Animated.timing(value, { toValue, duration: ms, easing: easeOut, useNativeDriver: true }).start();
}

/**
 * "Pixel snap" scale for an icon that just became active: 0.88 up past 1 by a hair, then exactly 1.
 * Drive it with a value that runs 0 -> 1; at rest (1) the scale is exactly 1, so the icon stays crisp.
 */
export function snapScale(progress: Animated.Value) {
  return progress.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [0.88, 1.04, 1],
    extrapolate: 'clamp',
  });
}
