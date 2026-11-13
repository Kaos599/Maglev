import React, { useMemo, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, type } from '../../constants/theme';
import { PixelIcon, PixelIconName, PixelIconSize } from '../PixelIcon';
import { animateTo, duration, useReduceMotion, useSnapOnActivate } from '../motion';
import { PressableScale } from './PressableScale';

export interface IconButtonProps {
  icon: PixelIconName;
  onPress?: () => void;
  accessibilityLabel: string;
  size?: PixelIconSize;
  color?: string;
  /** Count shown in a small badge; 0 or undefined hides it. */
  badge?: number;
  /** A small lime dot in the corner: something here needs a look. */
  dot?: boolean;
  disabled?: boolean;
  /** In use (e.g. a filter is applied): the icon turns accent and grows. No box behind it. */
  selected?: boolean;
  testID?: string;
}

/**
 * Bare pixel icon button. No background box on press: the icon itself turns accent, which
 * reads cleaner on OLED black.
 *
 * Motion (native driver, only on press or selection change):
 * - press: the icon sinks 2 px and crossfades to accent (120 ms in, 160 ms out, ease-out)
 * - selected turns on: the icon grows to its larger size with one pixel snap (180 ms)
 */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 20,
  color,
  badge,
  dot = false,
  disabled = false,
  selected,
  testID,
}: IconButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduce = useReduceMotion();
  const showBadge = typeof badge === 'number' && badge > 0;
  const on = selected === true;
  const iconSize: PixelIconSize = on && size === 20 ? 24 : size;

  // 0 at rest, 1 while the finger is down: drives the accent layer's opacity.
  const press = useRef(new Animated.Value(0)).current;
  const pressOff = useRef(press.interpolate({ inputRange: [0, 1], outputRange: [1, 0] })).current;
  const snap = useSnapOnActivate(on, reduce);

  return (
    <PressableScale
      onPress={() => {
        // Same guard as PressableScale: a press that navigates away can lose its onPressOut.
        animateTo(press, 0, duration.release, reduce);
        onPress?.();
      }}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      feedback="sink"
      onPressIn={() => animateTo(press, 1, duration.press, reduce)}
      onPressOut={() => animateTo(press, 0, duration.release, reduce)}
      style={[styles.box, disabled && styles.disabled]}
    >
      <Animated.View style={{ transform: [{ scale: snap }] }}>
        {on ? (
          // Already accent, so there is nothing to crossfade.
          <PixelIcon name={icon} size={iconSize} color={colors.accent} />
        ) : (
          <>
            <Animated.View style={{ opacity: pressOff }}>
              <PixelIcon name={icon} size={iconSize} color={color ?? colors.text} />
            </Animated.View>
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: press }]}>
              <PixelIcon name={icon} size={iconSize} color={colors.accent} />
            </Animated.View>
          </>
        )}
      </Animated.View>
      {showBadge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
      {dot ? <View style={styles.dot} /> : null}
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    box: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    disabled: { opacity: 0.4 },
    badge: {
      position: 'absolute',
      top: 4,
      right: 2,
      minWidth: 16,
      height: 16,
      paddingHorizontal: 4,
      borderRadius: 4,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dot: { position: 'absolute', top: 8, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent },
    badgeText: { ...type.monoBold, fontSize: 10, color: c.onAccent },
  });
