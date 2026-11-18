import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Modal, Pressable, StyleProp, StyleSheet, View, findNodeHandle } from 'react-native';
import Animated, { SharedValue, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../PixelIcon';
import { useMotion } from './useMotion';
import { useOverlayTracking } from '../../utils/overlayTracker';

export interface DialogProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  /** Pixelarticons name, shown in a tinted square above the title. */
  icon?: PixelIconName;
  children?: React.ReactNode;
  /** Buttons, stacked full width at the bottom. */
  actions?: React.ReactNode;
  testID?: string;
  /** Content above the icon and title, at the card's edges (it takes the card's padding as a negative margin). */
  hero?: React.ReactNode;
  /** Extra, animatable style for the title, e.g. to fade it in. */
  titleStyle?: StyleProp<any>;
  /**
   * A scripted entrance driven by a shared clock (ms since the dialog opened) instead of the built-in fade and
   * scale. `card` gives the card's opacity, scale and how far below its place it is (in `unit` points);
   * `scrim` the backdrop's opacity. Closing still fades and scales down over `exitMs`.
   */
  intro?: DialogIntro;
  /** How long closing takes (default 180 ms). */
  exitMs?: number;
  /** Called once the closing animation is done and the dialog is gone. */
  onExited?: () => void;
}

export interface DialogIntro {
  clock: SharedValue<number>;
  unit: number;
  card: (ms: number) => { opacity: number; scale: number; rise: number };
  scrim: (ms: number) => number;
}

/** The widest the card gets, and the margin kept on each side of it, in points. */
export const DIALOG_MAX_WIDTH = 360;
export const DIALOG_GUTTER = spacing.lg;

const DURATION = 180;
const START_SCALE = 0.94;
const MAX_WIDTH = DIALOG_MAX_WIDTH;

/**
 * Centred dialog for a temporary message that sits above the app and goes away. The card fades in and
 * scales from 0.94 to 1 (180 ms ease-out) while the backdrop fades; closing plays it in reverse. Back
 * and a tap on the backdrop close it. With reduce motion it appears and disappears at once, no scale.
 */
export function Dialog({ visible, onClose, title, icon, children, actions, testID, hero, titleStyle, intro, exitMs = DURATION, onExited }: DialogProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const m = useMotion();
  useOverlayTracking(visible);

  // The Modal stays mounted while the dialog fades out.
  const [mounted, setMounted] = useState(visible);
  const progress = useSharedValue(0);
  const titleRef = useRef<any>(null);
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); }, []);

  const focusTitle = useCallback((delay: number) => {
    if (focusTimer.current) clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      const tag = titleRef.current ? findNodeHandle(titleRef.current) : null;
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, delay);
  }, []);

  const exited = useRef(onExited);
  exited.current = onExited;
  const unmount = useCallback(() => {
    setMounted(false);
    exited.current?.();
  }, []);

  useEffect(() => {
    cancelAnimation(progress);
    if (visible) {
      if (!mounted) {
        setMounted(true);
        return;
      }
      if (m.disabled || intro) progress.value = 1;
      else progress.value = withTiming(1, { duration: DURATION, easing: m.easing });
      focusTitle(m.disabled ? 100 : DURATION + 100);
      return;
    }
    if (!mounted) return;
    if (m.disabled) {
      progress.value = 0;
      unmount();
      return;
    }
    progress.value = withTiming(0, { duration: exitMs, easing: m.easing }, (finished) => {
      if (finished) scheduleOnRN(unmount);
    });
    // Only the visible edge and the mount drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, mounted]);

  const reduce = m.disabled;
  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * (intro ? intro.scrim(intro.clock.value) : 1) }));
  const cardStyle = useAnimatedStyle(() => {
    const k = intro ? intro.card(intro.clock.value) : null;
    const scale = (k ? k.scale : 1) * (START_SCALE + (1 - START_SCALE) * progress.value);
    return {
      opacity: progress.value * (k ? k.opacity : 1),
      transform: reduce ? [] : [{ translateY: k ? k.rise * intro!.unit : 0 }, { scale }],
    };
  });

  if (!mounted) return null;

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        </Animated.View>
        <Animated.View testID={testID} accessibilityViewIsModal style={[styles.card, cardStyle]}>
          {hero}
          {icon ? (
            <View style={styles.tile}>
              <PixelIcon name={icon} size={24} color={colors.accentText} />
            </View>
          ) : null}
          <Animated.Text ref={titleRef} style={[styles.title, titleStyle]} accessibilityRole="header">
            {title}
          </Animated.Text>
          {children ? <View style={styles.content}>{children}</View> : null}
          {actions ? <View style={styles.actions}>{actions}</View> : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
    backdrop: { ...StyleSheet.absoluteFill, backgroundColor: c.overlay },
    card: {
      width: '100%',
      maxWidth: MAX_WIDTH,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.xl,
      padding: spacing.xl,
    },
    tile: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.surfaceRaised,
      marginBottom: spacing.md,
    },
    title: { ...type.bodyStrong, fontSize: 17, color: c.text },
    content: { marginTop: spacing.sm },
    actions: { marginTop: spacing.lg, gap: spacing.sm },
  });
