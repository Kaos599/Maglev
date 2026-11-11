import React, { useCallback, useRef } from 'react';
import { Animated, Pressable, PressableProps, StyleProp, StyleSheet, ViewStyle } from 'react-native';
import { triggerHaptic } from '../../constants/haptics';

export interface PressableScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Style for the animated wrapper. Receives `pressed` to swap backgrounds. */
  style?: StyleProp<ViewStyle> | ((pressed: boolean) => StyleProp<ViewStyle>);
  /** Extra style for the outer Pressable (layout only). */
  containerStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  /** Pressed-state scale. Default 0.97. */
  scaleTo?: number;
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
 * Shared pressable: scales to 0.97 on press and fires a light haptic.
 * The Pressable owns the hit area; the inner Animated.View owns the look.
 */
export function PressableScale({
  style,
  containerStyle,
  children,
  scaleTo = 0.97,
  haptic = true,
  onPress,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const [pressed, setPressed] = React.useState(false);

  const to = useCallback(
    (v: number) =>
      Animated.timing(scale, { toValue: v, duration: 120, useNativeDriver: true }).start(),
    [scale],
  );

  const { outer, inner } = splitStyle(typeof style === 'function' ? style(pressed) : style);

  return (
    <Pressable
      {...rest}
      style={[outer, containerStyle]}
      disabled={disabled}
      onPressIn={(e) => {
        setPressed(true);
        to(scaleTo);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        to(1);
        onPressOut?.(e);
      }}
      onPress={(e) => {
        // A press that navigates away can lose its onPressOut; never leave the pressed look behind.
        setPressed(false);
        to(1);
        // Navigation first; the haptic must never sit in front of it.
        onPress?.(e);
        if (haptic) triggerHaptic('light');
      }}
    >
      <Animated.View
        style={[inner, styles.fill, { transform: [{ scale }] }]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({ fill: { flexGrow: 1 } });
