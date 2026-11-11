import React, { useCallback, useRef } from 'react';
import { Animated, Pressable, PressableProps, StyleProp, ViewStyle } from 'react-native';
import { triggerHaptic } from '../../constants/haptics';

export interface PressableScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  /** Style for the animated wrapper. Receives `pressed` to swap backgrounds. */
  style?: StyleProp<ViewStyle> | ((pressed: boolean) => StyleProp<ViewStyle>);
  children: React.ReactNode;
  /** Pressed-state scale. Default 0.97. */
  scaleTo?: number;
  haptic?: boolean;
}

/**
 * Shared pressable: scales to 0.97 on press and fires a light haptic.
 * The Pressable owns the hit area; the inner Animated.View owns the look.
 */
export function PressableScale({
  style,
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

  return (
    <Pressable
      {...rest}
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
        if (haptic) triggerHaptic('light');
        onPress?.(e);
      }}
    >
      <Animated.View
        style={[typeof style === 'function' ? style(pressed) : style, { transform: [{ scale }] }]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
