import { useEffect } from 'react';
import { Platform } from 'react-native';
import { NavigationBar } from 'expo-navigation-bar';
import { useTheme } from '../context/ThemeContext';

/**
 * Keeps the Android system navigation buttons readable against the app theme.
 *
 * SDK 58 runs Android in edge-to-edge mode, so the navigation bar is
 * transparent and the app's own background shows through it. The
 * expo-navigation-bar API in this SDK has no background-colour setter (the
 * old setBackgroundColorAsync is gone), so the bar colour comes from the root
 * background, and this component only sets the button style:
 * 'light' buttons on dark themes, 'dark' buttons on the light theme.
 *
 * Render it once near the root (no-op on iOS and web). It renders nothing.
 */
export default function NavigationBarSync() {
  const { dark } = useTheme();

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    try {
      NavigationBar.setStyle(dark ? 'light' : 'dark');
    } catch {
      // Native module unavailable (e.g. Expo Go without the module); keep the default style.
    }
  }, [dark]);

  return null;
}
