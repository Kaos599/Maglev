import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { StyleSheet, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useMotion } from '../ui/useMotion';
import { swipeDirection } from './tipsLogic';

/**
 * Holds the current page and lets a horizontal drag move to the next or previous one.
 * The page follows the finger, a fling or a drag past 30% of the width commits, anything less springs back, and a
 * page with nothing beyond it only gives a little. The new page settles in with a spring. With reduce motion the
 * page does not follow and the switch is instant. The buttons in TipsBar do the same, so nothing is swipe-only.
 * Gesture API: react-native-gesture-handler 3.3 usePanGesture.
 */
export function SwipeDeck({
  index,
  last,
  onMove,
  children,
}: {
  index: number;
  /** Highest page index (the end card). */
  last: number;
  /** +1 for the next page, -1 for the previous one. */
  onMove: (delta: 1 | -1) => void;
  children: React.ReactNode;
}) {
  const m = useMotion();
  const tx = useSharedValue(0);
  const width = useSharedValue(0);
  const canPrev = useSharedValue(index > 0);
  const canNext = useSharedValue(index < last);
  const entering = useRef<0 | 1 | -1>(0);

  useEffect(() => {
    canPrev.value = index > 0;
    canNext.value = index < last;
  }, [index, last, canPrev, canNext]);

  const reduce = m.disabled;
  const base = m.base;
  const fast = m.fast;
  const easing = m.easing;

  // The new page slides in from the side the old one left towards, once it has rendered.
  useLayoutEffect(() => {
    const d = entering.current;
    if (d === 0) return;
    entering.current = 0;
    if (reduce) {
      tx.value = 0;
      return;
    }
    tx.value = d * width.value * 0.25;
    tx.value = withSpring(0, { duration: base, dampingRatio: 1 });
  }, [index, reduce, base, tx, width]);

  const move = useCallback(
    (d: 1 | -1) => {
      entering.current = d;
      onMove(d);
    },
    [onMove],
  );

  const pan = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-20, 20],
    onUpdate: (e) => {
      'worklet';
      if (reduce) return;
      const dx = e.translationX;
      const blocked = (dx > 0 && !canPrev.value) || (dx < 0 && !canNext.value);
      tx.value = blocked ? dx * 0.25 : dx;
    },
    onDeactivate: (e) => {
      'worklet';
      const d = swipeDirection(e.translationX, e.velocityX, width.value, canPrev.value, canNext.value);
      if (d === 0) {
        tx.value = reduce ? 0 : withSpring(0, { duration: base, dampingRatio: 1, velocity: e.velocityX });
        return;
      }
      // Swiping left (dx < 0) goes to the next page.
      const dir = (d === 1 ? 1 : -1) as 1 | -1;
      if (reduce) {
        tx.value = 0;
        scheduleOnRN(move, dir);
        return;
      }
      tx.value = withTiming(-dir * width.value, { duration: fast, easing }, (finished) => {
        if (finished) scheduleOnRN(move, dir);
      });
    },
  });

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const onLayout = (e: LayoutChangeEvent) => {
    width.value = e.nativeEvent.layout.width;
  };

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.fill, style]} onLayout={onLayout}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
