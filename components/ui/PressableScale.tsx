import React, { useCallback, useRef } from 'react';
import { Animated, Pressable, PressableProps, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { triggerHaptic } from '../../constants/haptics';
import { PRESS_SINK, animateTo, duration, useReduceMotion } from '../motion';

export interface PressableScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Style for the animated wrapper. Receives `pressed` to swap backgrounds. */
  style?: StyleProp<ViewStyle> | ((pressed: boolean) => StyleProp<ViewStyle>);
  /** Extra style for the outer Pressable (layout only). */
  containerStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  /** Pressed-state scale for `feedback="scale"`. Default 0.97. */
  scaleTo?: number;
  /**
   * How the press looks. `scale` (default) shrinks the whole surface, for buttons and rows.
   * `sink` moves it down 2 whole pixels, for bare pixel icons, which blur when scaled.
   */
  feedback?: 'scale' | 'sink';
  haptic?: boolean;
}

const OUTER_KEYS = new Set([
  'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'width', 'height', 'minWidth', 'minHeight',
  'maxWidth', 'maxHeight', 'margin', 'marginHorizontal', 'marginVertical', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'marginStart', 'marginEnd', 'position', 'top', 'bottom', 'left', 'right',
  'zIndex', 'aspectRatio',
]);

/** Splits layout props (which must live on the outer Pressable) from visual props. */
function splitStyle(style: StyleProp<ViewStyle>): { outer: ViewStyle; inner: ViewStyle } {
  const flat = (StyleSheet.flatten(style) ?? {}) as Record<string, unknown>;
  const outer: Record<string, unknown> = {};
  const inner: Record<string, unknown> = {};
  for (const k of Object.keys(flat)) (OUTER_KEYS.has(k) ? outer : inner)[k] = flat[k];
  return { outer: outer as ViewStyle, inner: inner as ViewStyle };
}

/**
 * Shared pressable: a short press response (scale or sink) and a light haptic.
 * The Pressable owns the hit area; the inner Animated.View owns the look.
 * Press in is 120 ms, release is 160 ms, both ease-out on the native driver.
 * With reduce motion on, the pressed state is applied instantly instead of tweened.
 */
export function PressableScale({
  style,
  containerStyle,
  children,
  scaleTo = 0.97,
  feedback = 'scale',
  haptic = true,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const reduce = useReduceMotion();
  // 0 at rest, 1 fully pressed. At rest every transform is exactly identity.
  const press = useRef(new Animated.Value(0)).current;
  const transform = useRef({
    scale: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, scaleTo] }) }],
    sink: [{ translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, PRESS_SINK] }) }],
  }).current;
  const [pressed, setPressed] = React.useState(false);
  // Only a style function reads `pressed`; skip the re-render otherwise.
  const tracksPressed = typeof style === 'function';

  const to = useCallback(
    (v: 0 | 1) => animateTo(press, v, v ? duration.press : duration.release, reduce),
    [press, reduce],
  );

  const { outer, inner } = splitStyle(typeof style === 'function' ? style(pressed) : style);

  return (
    <Pressable
      {...rest}
      style={[outer, containerStyle]}
      disabled={disabled}
      onPressIn={(e) => {
        if (tracksPressed) setPressed(true);
        to(1);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        if (tracksPressed) setPressed(false);
        to(0);
        onPressOut?.(e);
      }}
      onPress={(e) => {
        // A press that navigates away can lose its onPressOut; never leave the pressed look behind.
        if (tracksPressed) setPressed(false);
        to(0);
        // Navigation first; the haptic must never sit in front of it.
        onPress?.(e);
        if (haptic) triggerHaptic('light');
      }}
    >
      <Animated.View style={[inner, styles.fill, { transform: transform[feedback] }]}>{children}</Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({ fill: { flexGrow: 1 } });
