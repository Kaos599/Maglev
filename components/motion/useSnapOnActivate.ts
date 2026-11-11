import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { animateTo, duration, snapScale } from './tokens';

/**
 * Returns a scale that plays the pixel snap once each time `active` turns true.
 * It never plays on mount and never loops: idle components animate nothing.
 */
export function useSnapOnActivate(active: boolean, reduce: boolean) {
  const progress = useRef(new Animated.Value(1)).current;
  const scale = useRef(snapScale(progress)).current;
  const was = useRef(active);

  useEffect(() => {
    const turnedOn = active && !was.current;
    was.current = active;
    if (!turnedOn || reduce) return;
    progress.setValue(0);
    animateTo(progress, 1, duration.focus, false);
  }, [active, reduce, progress]);

  return scale;
}
