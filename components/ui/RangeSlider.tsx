import React, { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import { useTheme } from '../../context/ThemeContext';
import { haptic } from '../../constants/haptics';
import { touch, type ThemeColors } from '../../constants/theme';

export interface RangeSliderProps {
  /** How many stops the track has (at least 2). */
  steps: number;
  /** Stop index of the low and high thumbs. */
  low: number;
  high: number;
  onChange: (low: number, high: number) => void;
  /** Screen reader names for the two thumbs. */
  labelLow: string;
  labelHigh: string;
  /** Spoken value of a stop. */
  valueText: (index: number) => string;
  /** Fewest stops between the thumbs. */
  minGap?: number;
}

const TRACK_H = 4;
const THUMB = 20;

/** Two thumbs on one track, snapping to evenly spaced stops. The selected part of the track is lime. */
export function RangeSlider({ steps, low, high, onChange, labelLow, labelHigh, valueText, minGap = 1 }: RangeSliderProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [width, setWidth] = useState(0);
  const last = Math.max(steps - 1, 1);
  // Room at each end so a thumb at the edge keeps its whole touch target on screen.
  const inset = touch.min / 2;
  const trackW = Math.max(width - inset * 2, 0);

  // Gesture callbacks run on the JS thread and read the latest values through a ref.
  const live = useRef({ low, high, last, trackW, inset, minGap, onChange });
  live.current.last = last;
  live.current.trackW = trackW;
  live.current.minGap = minGap;
  live.current.onChange = onChange;
  live.current.low = low;
  live.current.high = high;
  const active = useRef<'low' | 'high' | null>(null);

  const move = useCallback((which: 'low' | 'high', idx: number) => {
    const l = live.current;
    const next = which === 'low' ? Math.max(0, Math.min(idx, l.high - l.minGap)) : Math.min(l.last, Math.max(idx, l.low + l.minGap));
    const prev = which === 'low' ? l.low : l.high;
    if (next === prev) return;
    haptic('select');
    if (which === 'low') l.low = next;
    else l.high = next;
    l.onChange(l.low, l.high);
  }, []);

  const indexAt = (x: number) => {
    const l = live.current;
    if (l.trackW <= 0) return 0;
    return Math.round(Math.min(Math.max((x - l.inset) / l.trackW, 0), 1) * l.last);
  };
  const nearest = (x: number): 'low' | 'high' => {
    const l = live.current;
    const at = (i: number) => l.inset + (i / l.last) * l.trackW;
    return Math.abs(x - at(l.low)) <= Math.abs(x - at(l.high)) && !(x > at(l.high)) ? 'low' : 'high';
  };

  // A horizontal drag from the first 8 dp moves the nearest thumb; a vertical move of 12 dp fails it so the sheet scrolls.
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-8, 8],
    failOffsetY: [-12, 12],
    onActivate: (e) => {
      active.current = nearest(e.x);
      move(active.current, indexAt(e.x));
    },
    onUpdate: (e) => {
      if (active.current) move(active.current, indexAt(e.x));
    },
    onFinalize: () => {
      active.current = null;
    },
  });
  const tap = useTapGesture({
    runOnJS: true,
    onActivate: (e) => move(nearest(e.x), indexAt(e.x)),
  });
  const gesture = useExclusiveGestures(pan, tap);

  const onAction = (which: 'low' | 'high') => (e: AccessibilityActionEvent) => {
    const l = live.current;
    const cur = which === 'low' ? l.low : l.high;
    if (e.nativeEvent.actionName === 'increment') move(which, cur + 1);
    if (e.nativeEvent.actionName === 'decrement') move(which, cur - 1);
  };

  const x = (i: number) => inset + (i / last) * trackW;
  const thumb = (which: 'low' | 'high', i: number) => (
    <View
      key={which}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={which === 'low' ? labelLow : labelHigh}
      accessibilityValue={{ text: valueText(i) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={onAction(which)}
      style={[styles.hit, { left: x(i) - touch.min / 2 }]}
    >
      <View style={styles.thumb} />
    </View>
  );

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.root} onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
        <View style={[styles.track, { left: inset, width: trackW }]} />
        <View style={[styles.selected, { left: x(low), width: Math.max(x(high) - x(low), 0) }]} />
        {thumb('low', low)}
        {thumb('high', high)}
      </View>
    </GestureDetector>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { height: touch.min, justifyContent: 'center' },
    track: { position: 'absolute', top: (touch.min - TRACK_H) / 2, height: TRACK_H, borderRadius: TRACK_H / 2, backgroundColor: c.border },
    selected: { position: 'absolute', top: (touch.min - TRACK_H) / 2, height: TRACK_H, backgroundColor: c.accent },
    hit: { position: 'absolute', top: 0, width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
    thumb: { width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: c.accent, borderWidth: 2, borderColor: c.bg },
  });
