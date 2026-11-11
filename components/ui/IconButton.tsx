import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, type } from '../../constants/theme';
import { PixelIcon, PixelIconName, PixelIconSize } from '../PixelIcon';
import { PressableScale } from './PressableScale';

export interface IconButtonProps {
  icon: PixelIconName;
  onPress?: () => void;
  accessibilityLabel: string;
  size?: PixelIconSize;
  color?: string;
  /** Count shown in a small badge; 0 or undefined hides it. */
  badge?: number;
  disabled?: boolean;
  selected?: boolean;
  testID?: string;
}

export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  size = 20,
  color,
  badge,
  disabled = false,
  selected,
  testID,
}: IconButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const showBadge = typeof badge === 'number' && badge > 0;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      style={(pressed) => [styles.box, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <PixelIcon name={icon} size={size} color={color ?? colors.text} />
      {showBadge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    box: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    pressed: { backgroundColor: c.surfaceRaised },
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
    badgeText: { ...type.monoBold, fontSize: 10, color: c.onAccent },
  });
