import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { steppedRanges } from '../brand/markMotion';
import { useReduceMotion } from '../motion/useReduceMotion';

/** How far the next step travels in from the side, in dp, one pixel-step at a time. */
const TRAVEL = [24, 14, 6, 0];

export interface StepSlideProps {
  /** +1 when moving forward (new step comes in from the right), -1 when going back. */
  direction: 1 | -1;
  children: React.ReactNode;
}

/**
 * Moving between steps: the content slides in from the side in four whole-pixel steps, like the
 * train's own frames, and fades in. Remount (key) replays it. With reduce motion on it only fades.
 * It never delays anything: the content is on screen and tappable from the first frame.
 */
export function StepSlide({ direction, children }: StepSlideProps) {
  const reduce = useReduceMotion();
  const clock = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.timing(clock, {
      toValue: 1,
      duration: reduce ? 120 : 200,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [clock, reduce]);

  const style = useMemo(() => {
    const opacity = clock.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] });
    if (reduce) return { opacity };
    const translateX = clock.interpolate({
      ...steppedRanges(
        TRAVEL.map((d) => d * direction),
        false,
      ),
      extrapolate: 'clamp',
    });
    return { opacity, transform: [{ translateX }] };
  }, [clock, reduce, direction]);

  return <Animated.View style={[styles.fill, style]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
