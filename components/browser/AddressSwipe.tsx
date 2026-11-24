import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, motion, radius, spacing, touch, type } from '../../constants/theme';
import { useReduceMotion } from '../motion/useReduceMotion';
import { haptic } from '../../constants/haptics';
import { hostOf } from '../../utils/browserUrl';
import { isBlank, type Tab } from '../../utils/browser/tabs';
import { decideSwipe, decideVertical, dragOffset, neighbourIndex, swipeStartsAtEdge } from '../../utils/browser/tabSwipe';
import { titleOf } from './TabSwitcher';

export interface AddressSwipeProps {
  /** Tabs in strip order (the order TabSwitcher shows). */
  strip: Tab[];
  activeId: string;
  /** Off while the address is being edited, or when the pref is off. Sideways swipes also need 2+ tabs. */
  enabled: boolean;
  /** A still tap on the address focuses it. Only true while it is not being edited and the page is ready. */
  canFocusAddress: boolean;
  onFocusAddress: () => void;
  onSelect: (id: string) => void;
  onOpenSwitcher: () => void;
  /** The address field. Its taps are handled by this component, so the field itself takes no touches. */
  children: React.ReactNode;
  /** The tab-count and ⋮ buttons. They sit inside the bar, so a swipe that starts on them still switches tabs. */
  trailing: React.ReactNode;
}

const SPRING = { damping: 22, stiffness: 320, mass: 0.6 } as const;

/**
 * Wraps the whole header bar (0.34 section 3). A horizontal drag moves to the next or previous tab, a downward drag
 * opens the tab list. A still tap on the address focuses it; a sloppy swipe never does (the tap fails on movement).
 * The tab-count and ⋮ buttons stay the visible way to do the same, so nothing is gesture-only.
 * Gesture API: react-native-gesture-handler 3.3 usePanGesture, useTapGesture and useExclusiveGestures.
 */
export function AddressSwipe({
  strip,
  activeId,
  enabled,
  canFocusAddress,
  onFocusAddress,
  onSelect,
  onOpenSwitcher,
  children,
  trailing,
}: AddressSwipeProps) {
  // The tab slide uses the base motion token and is instant when the system asks for less motion.
  const reduceMotion = useReduceMotion();
  const slideMs = reduceMotion ? 0 : motion.duration.base;
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width: screenW } = useWindowDimensions();
  const tx = useSharedValue(0);
  const width = useSharedValue(0);
  const [hint, setHint] = useState<Tab | null>(null);

  // Gesture callbacks run on the JS thread and read the latest props through a ref.
  const live = useRef({ strip, activeId, screenW, onSelect, onOpenSwitcher, onFocusAddress, startOk: false, hintId: '' });
  live.current.strip = strip;
  live.current.activeId = activeId;
  live.current.screenW = screenW;
  live.current.onSelect = onSelect;
  live.current.onOpenSwitcher = onOpenSwitcher;
  live.current.onFocusAddress = onFocusAddress;

  const indexNow = () => live.current.strip.findIndex((t) => t.id === live.current.activeId);

  const showHint = useCallback((tab: Tab | null) => {
    const id = tab?.id ?? '';
    if (live.current.hintId === id) return;
    live.current.hintId = id;
    setHint(tab);
  }, []);

  const begin = (absoluteX: number) => {
    cancelAnimation(tx);
    live.current.startOk = !swipeStartsAtEdge(absoluteX, live.current.screenW);
  };

  const drag = (dx: number) => {
    if (!live.current.startOk) return;
    const n = neighbourIndex(dx, indexNow(), live.current.strip.length);
    tx.value = dragOffset(dx, n != null);
    showHint(n != null ? live.current.strip[n] : null);
  };

  const settle = () => {
    tx.value = withSpring(0, SPRING);
    live.current.hintId = '';
    setTimeout(() => setHint(null), motion.duration.release);
  };

  const finishHorizontal = (dx: number, vx: number) => {
    const l = live.current;
    if (!l.startOk) return settle();
    const i = indexNow();
    const d = decideSwipe(dx, vx, i, l.strip.length);
    if (d === 'none') return settle();
    const target = l.strip[d === 'next' ? i + 1 : i - 1];
    haptic('select');
    tx.value = withTiming((d === 'next' ? -1 : 1) * width.value, { duration: slideMs });
    setTimeout(() => {
      l.onSelect(target.id);
      tx.value = 0;
      l.hintId = '';
      setHint(null);
    }, slideMs);
  };

  // Swiping between tabs needs a second tab. Opening the list (downward) works with one tab too.
  const horizontal = usePanGesture({
    runOnJS: true,
    enabled: enabled && strip.length > 1,
    activeOffsetX: [-12, 12],
    failOffsetY: [-30, 30],
    onBegin: (e) => begin(e.absoluteX),
    onUpdate: (e) => drag(e.translationX),
    onDeactivate: (e) => finishHorizontal(e.translationX, e.velocityX),
  });
  // The bar is at the top of the screen, so a downward drag opens the list.
  const vertical = usePanGesture({
    runOnJS: true,
    enabled,
    activeOffsetY: 12,
    failOffsetX: [-10, 10],
    onBegin: (e) => begin(e.absoluteX),
    onDeactivate: (e) => {
      if (live.current.startOk && decideVertical(e.translationY, e.velocityY) === 'switcher') {
        haptic('select');
        live.current.onOpenSwitcher();
      }
    },
  });
  const gesture = useExclusiveGestures(horizontal, vertical);

  // A still tap on the address. It only starts while the pans have not activated: the tap fails once the finger
  // moves 10 dp, and the horizontal pan needs 12 dp before it activates.
  const focusTap = useTapGesture({
    runOnJS: true,
    enabled: canFocusAddress,
    maxDistance: 10,
    onActivate: () => live.current.onFocusAddress(),
  });

  const barStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const hintStyle = useAnimatedStyle(() => {
    const w = width.value;
    const side = tx.value < 0 ? w : -w;
    return {
      opacity: Math.min(1, Math.abs(tx.value) / 24),
      transform: [{ translateX: tx.value + side }],
    };
  });

  const hintTitle = hint ? titleOf(hint) : '';
  const hintHost = hint && !isBlank(hint) ? hostOf(hint.url) : '';

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.bar}>
        <View style={styles.slot} onLayout={(e: LayoutChangeEvent) => (width.value = e.nativeEvent.layout.width)}>
          <Animated.View style={[styles.fill, barStyle]}>
            <GestureDetector gesture={focusTap}>
              <View style={styles.fill}>{children}</View>
            </GestureDetector>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[styles.hint, hintStyle]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.hintTitle} numberOfLines={1}>
              {hintTitle}
            </Text>
            {hintHost && hintHost !== hintTitle ? (
              <Text style={styles.hintHost} numberOfLines={1}>
                {hintHost}
              </Text>
            ) : null}
          </Animated.View>
        </View>
        {trailing}
      </View>
    </GestureDetector>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs, minHeight: 56 },
    slot: { flex: 1, minWidth: touch.min, height: touch.min, overflow: 'hidden', borderRadius: radius.md },
    fill: { flex: 1, flexDirection: 'row' },
    hint: {
      ...StyleSheet.absoluteFill,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
    },
    hintTitle: { ...type.mono, fontSize: type.size.md, color: c.text },
    hintHost: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
  });
