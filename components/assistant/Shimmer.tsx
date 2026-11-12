import React, { useEffect, useRef } from 'react';
import { Animated, StyleProp, TextStyle } from 'react-native';
import { useReduceMotion } from '../motion';

export interface ShimmerProps {
  text: string;
  style?: StyleProp<TextStyle>;
  /** Animate only while true. Reduce motion always shows still text. */
  active?: boolean;
}

/** Text that slowly brightens and dims while something is happening. A text effect, not a spinner or a dot. */
export function Shimmer({ text, style, active = true }: ShimmerProps) {
  const reduce = useReduceMotion();
  const v = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active || reduce) {
      v.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.35, duration: 900, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 900, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduce, v]);
  return <Animated.Text style={[style, { opacity: v }]}>{text}</Animated.Text>;
}
