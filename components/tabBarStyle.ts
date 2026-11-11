import { useMemo } from 'react';
import type { ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';

export const TAB_BAR_HEIGHT = 64;

/** Shared bottom tab bar style, so a screen can hide the bar and restore it exactly. */
export function useTabBarStyle(): ViewStyle {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return useMemo(
    () => ({
      backgroundColor: colors.bg,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      height: TAB_BAR_HEIGHT + insets.bottom,
      paddingBottom: insets.bottom,
      paddingTop: 0,
    }),
    [colors, insets.bottom],
  );
}
