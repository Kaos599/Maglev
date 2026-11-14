import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, findNodeHandle, useWindowDimensions } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { useMotion } from '../ui/useMotion';
import { useOverlayTracking } from '../../utils/overlayTracker';

export interface FloatingSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
  testID?: string;
}

/** Points the card travels while it fades in and out. */
const RISE = 24;

/**
 * A compact card that floats above the bottom edge, inset from the sides, over a dimmed scrim. Its height
 * follows its content (the content scrolls when it would not fit). Tapping the scrim ("Close") or pressing
 * Back closes it. It fades and rises in (the Sheet's duration and easing) and the same on the way out; with
 * reduce motion it appears and disappears at once. TalkBack focus moves to the title once it has settled.
 *
 * A Modal is its own native window on Android, so the card is rendered inside it.
 */
export function FloatingSheet({ visible, onClose, title, subtitle, children, testID }: FloatingSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const m = useMotion();
  useOverlayTracking(visible);

  // The Modal stays mounted while the card fades out.
  const [mounted, setMounted] = useState(visible);
  // 0 = hidden, 1 = shown.
  const progress = useSharedValue(0);
  const titleRef = useRef<any>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);

  const unmount = useCallback(() => setMounted(false), []);

  const show = useCallback(() => {
    cancelAnimation(progress);
    if (m.disabled) progress.value = 1;
    else progress.value = withTiming(1, { duration: m.base, easing: m.easing });
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      const tag = titleRef.current ? findNodeHandle(titleRef.current) : null;
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, m.disabled ? 100 : m.base + 100);
  }, [m, progress]);

  useEffect(() => {
    if (visible) {
      if (!mounted) setMounted(true);
      return;
    }
    if (!mounted) return;
    cancelAnimation(progress);
    if (m.disabled) {
      progress.value = 0;
      unmount();
      return;
    }
    progress.value = withTiming(0, { duration: m.base, easing: m.easing }, (finished) => {
      if (finished) scheduleOnRN(unmount);
    });
    // Only the visible edge drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Opening: once the Modal has mounted, run the fade in.
  useEffect(() => {
    if (visible && mounted) show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mounted]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * RISE }],
  }));

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[styles.scrim, scrimStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View
          testID={testID}
          accessibilityViewIsModal
          style={[styles.card, { maxHeight: height * 0.8, marginBottom: Math.max(insets.bottom, spacing.lg) }, cardStyle]}
        >
          <View style={styles.header}>
            <Text ref={titleRef} style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" bounces={false}>
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A quiet line for information that is not a problem: a small icon and muted text, no tinted fill. */
export function NoteRow({ text }: { text: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.note} accessible accessibilityLiveRegion="polite">
      <PixelIcon name="about" size={16} color={colors.textMuted} />
      <Text style={styles.noteText}>{text}</Text>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: spacing.lg },
    scrim: { ...StyleSheet.absoluteFill, backgroundColor: c.overlay },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.lg,
      overflow: 'hidden',
    },
    header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
    title: { ...type.bodyStrong, fontSize: 17, color: c.text },
    subtitle: { ...type.body, fontSize: 13, color: c.textMuted, marginTop: 4 },
    scroll: { flexGrow: 0, flexShrink: 1 },
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    note: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs },
    noteText: { ...type.body, fontSize: 13, lineHeight: 18, color: c.textMuted, flex: 1 },
  });

/** A little longer than the fade out (motion `base`), so the Modal's window is gone before `fn` runs. */
const AFTER_CLOSE_MS = 360;

/**
 * Runs `fn` once a FloatingSheet that was just closed has left the screen. A sheet is a Modal, its own window on
 * Android, so a notice raised while it is still up sits under it and can expire unseen.
 */
export function afterSheetCloses(fn: () => void): void {
  setTimeout(fn, AFTER_CLOSE_MS);
}
