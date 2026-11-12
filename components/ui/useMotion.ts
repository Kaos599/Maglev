import { useMemo } from 'react';
import { Easing } from 'react-native-reanimated';
import { motion } from '../../constants/theme';
import { useReduceMotion } from '../motion';

export interface Motion {
  /** True when the system asks for less motion: jump to end states, play nothing. */
  disabled: boolean;
  fast: number;
  base: number;
  press: number;
  /** Ease-out cubic, as a Reanimated easing (a worklet). */
  easing: typeof Easing.linear;
}

const easing = Easing.out(Easing.cubic);

/**
 * Motion tokens plus the live reduce-motion flag. Reanimated's own useReducedMotion is read once
 * at app start and never updates, so this uses the app's shared AccessibilityInfo subscription.
 */
export function useMotion(): Motion {
  const disabled = useReduceMotion();
  return useMemo(
    () => ({
      disabled,
      fast: motion.duration.fast,
      base: motion.duration.base,
      press: motion.duration.press,
      easing,
    }),
    [disabled],
  );
}
