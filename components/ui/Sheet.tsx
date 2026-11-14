import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, LayoutChangeEvent, Modal, Platform, Pressable, StyleSheet, Text, View, findNodeHandle, useWindowDimensions } from 'react-native';
import { GestureDetector, GestureHandlerRootView, usePanGesture } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, backdropOpacity, motion, radius, sheetDragOffset, shouldDismissSheet, spacing, type } from '../../constants/theme';
import { useMotion } from './useMotion';
import { useOverlayTracking } from '../../utils/overlayTracker';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  testID?: string;
  /** The control that opened the sheet. TalkBack focus goes back to it after the sheet closes. */
  returnFocusRef?: React.RefObject<any>;
}

/**
 * Bottom sheet. Slides up and fades its backdrop in (220 ms ease-out), slides out the same way,
 * and can be dragged down by its handle and title: a fling or a drag past 30% of its height
 * (at most 160 points) closes it, anything less springs back. Back, the backdrop ("Close") and the
 * caller's own buttons still close it. With reduce motion it appears and disappears at once; the
 * drag still follows the finger, and the release settles without animation.
 *
 * A Modal is its own native window on Android, outside the app's root gesture view, so the sheet
 * brings its own GestureHandlerRootView.
 */
export function Sheet({ visible, onClose, title, subtitle, children, testID, returnFocusRef }: SheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const m = useMotion();
  useOverlayTracking(visible);

  // The Modal stays mounted while the sheet slides out.
  const [mounted, setMounted] = useState(visible);
  // Points below the resting place. Starts off screen; the first layout slides it in.
  const offset = useSharedValue(height);
  const sheetH = useSharedValue(0);
  const pendingOpen = useRef(true);
  const titleRef = useRef<any>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnRef = useRef(returnFocusRef);
  returnRef.current = returnFocusRef;

  const focusNode = useCallback((node: unknown, delay: number) => {
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      const tag = node ? findNodeHandle(node as never) : null;
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, delay);
  }, []);
  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);

  const open = useCallback(() => {
    cancelAnimation(offset);
    if (m.disabled) offset.value = 0;
    else offset.value = withTiming(0, { duration: m.base, easing: m.easing });
    // Move TalkBack focus to the title once the sheet has settled.
    focusNode(titleRef.current, m.disabled ? 100 : m.base + 100);
  }, [m, offset, focusNode]);

  // The next mount measures again and slides in from there.
  const unmount = useCallback(() => {
    pendingOpen.current = true;
    setMounted(false);
    // Hand TalkBack focus back to the opener once the sheet is gone.
    if (returnRef.current?.current) focusNode(returnRef.current.current, 100);
  }, [focusNode]);

  useEffect(() => {
    if (visible) {
      if (!mounted) {
        pendingOpen.current = true;
        setMounted(true);
      } else if (!pendingOpen.current) {
        // Opened again while sliding out.
        open();
      }
      return;
    }
    if (!mounted) return;
    cancelAnimation(offset);
    const to = sheetH.value > 0 ? sheetH.value : height;
    if (m.disabled) {
      offset.value = to;
      unmount();
      return;
    }
    offset.value = withTiming(to, { duration: m.base, easing: m.easing }, (finished) => {
      if (finished) scheduleOnRN(unmount);
    });
    // Only the visible edge drives this; the rest is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const onSheetLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height;
      sheetH.value = h;
      if (pendingOpen.current && visible) {
        pendingOpen.current = false;
        offset.value = h;
        open();
      }
    },
    [open, offset, sheetH, visible],
  );

  const reduce = m.disabled;
  const base = m.base;
  const easing = m.easing;
  const pan = usePanGesture({
    enabled: visible,
    // Vertical only: a sideways swipe on the title is left alone.
    activeOffsetY: [-8, 8],
    failOffsetX: [-24, 24],
    onUpdate: (e) => {
      'worklet';
      offset.value = sheetDragOffset(e.translationY);
    },
    onDeactivate: (e) => {
      'worklet';
      const h = sheetH.value;
      if (shouldDismissSheet(offset.value, e.velocityY, h)) {
        const to = h > 0 ? h : height;
        offset.value = reduce ? to : withTiming(to, { duration: base, easing });
        scheduleOnRN(onClose);
        return;
      }
      offset.value = reduce
        ? 0
        : withSpring(0, { duration: motion.duration.base, dampingRatio: 1, velocity: e.velocityY });
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(-motion.sheet.overdrag, offset.value) }] }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: sheetH.value > 0 ? backdropOpacity(offset.value, sheetH.value) : 0,
  }));

  if (!mounted) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <GestureHandlerRootView style={styles.root}>
        <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Animated.View style={[styles.backdrop, backdropStyle]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close"
            />
          </Animated.View>
          <Animated.View
            testID={testID}
            accessibilityViewIsModal
            onLayout={onSheetLayout}
            style={[styles.sheet, { maxHeight: height * 0.85, paddingBottom: Math.max(insets.bottom, spacing.lg) }, sheetStyle]}
          >
            <GestureDetector gesture={pan}>
              <View style={styles.dragArea}>
                <View style={styles.grabber} />
                <Text ref={titleRef} style={styles.title} accessibilityRole="header">
                  {title}
                </Text>
                {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
              </View>
            </GestureDetector>
            <View style={styles.content}>{children}</View>
          </Animated.View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1 },
    fill: { flex: 1, justifyContent: 'flex-end' },
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.overlay },
    sheet: {
      backgroundColor: c.surface,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      borderWidth: 1,
      borderBottomWidth: 0,
      borderColor: c.border,
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.sm,
    },
    // The drag target: handle, title and subtitle. It reaches the sheet's side edges so it is easy to grab.
    dragArea: { marginHorizontal: -spacing.xl, paddingHorizontal: spacing.xl, paddingBottom: spacing.xs },
    grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: c.borderStrong, marginBottom: spacing.lg },
    title: { ...type.bodyStrong, fontSize: 17, color: c.text },
    subtitle: { ...type.body, fontSize: 13, color: c.textMuted, marginTop: 4 },
    content: { marginTop: spacing.lg, flexShrink: 1 },
  });
