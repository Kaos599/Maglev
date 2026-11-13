import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleProp, ViewStyle } from 'react-native';
import { easeOut } from './tokens';
import { useReduceMotion } from './useReduceMotion';

/** Enter and exit lengths (ms). Enter 150 ease-out; exit a touch quicker so the thing leaves softly. */
export const REVEAL_IN_MS = 150;
export const REVEAL_OUT_MS = 100;
/** Points the content rises while it fades in. */
export const REVEAL_RISE = 4;

interface RevealProps {
  visible: boolean;
  /** False: render at rest with no enter (first page load, or a row that was only recycled). */
  animate?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/**
 * Fades its children in (opacity 0 to 1, rising 4 points) and out again. It keeps them mounted while the exit plays,
 * then unmounts. With reduce motion on there is no animation at all. No bounce.
 */
export function Reveal({ visible, animate = true, style, children }: RevealProps) {
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(visible && !animate ? 1 : 0)).current;
  const first = useRef(true);

  useEffect(() => {
    const isFirst = first.current;
    first.current = false;
    if (visible) {
      setMounted(true);
      if (reduce || (isFirst && !animate)) {
        progress.setValue(1);
        return;
      }
      Animated.timing(progress, { toValue: 1, duration: REVEAL_IN_MS, easing: easeOut, useNativeDriver: true }).start();
      return;
    }
    if (reduce) {
      progress.setValue(0);
      setMounted(false);
      return;
    }
    Animated.timing(progress, { toValue: 0, duration: REVEAL_OUT_MS, easing: easeOut, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setMounted(false);
    });
    // `animate` only matters at the first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reduce, progress]);

  if (!mounted) return null;
  return (
    <Animated.View
      style={[style, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [REVEAL_RISE, 0] }) }] }]}
    >
      {children}
    </Animated.View>
  );
}
