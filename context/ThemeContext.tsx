import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { useSettings } from './SettingsContext';
import {
  AccentName,
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  Radius,
  Spacing,
  ThemeColors,
  ThemeMode,
  Type,
  accents,
  buildColors,
  isDarkMode,
  radius,
  spacing,
  touch,
  type,
} from '../constants/theme';

export interface Theme {
  colors: ThemeColors;
  mode: ThemeMode;
  accent: AccentName;
  dark: boolean;
  spacing: Spacing;
  radius: Radius;
  type: Type;
  touch: typeof touch;
}

/**
 * Appearance fields the settings schema does not carry yet. Until the engine
 * types gain them, they are read defensively and fall back to oled + lime.
 */
interface ExtendedAppearance {
  mode?: ThemeMode | 'system';
  accent?: AccentName;
}

const ThemeContext = createContext<Theme | null>(null);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { settings } = useSettings();
  const system = useColorScheme();
  const appearance = settings.appearance as typeof settings.appearance & ExtendedAppearance;
  const legacyTheme = appearance.theme;
  const rawMode = appearance.mode;
  const rawAccent = appearance.accent;

  const value = useMemo<Theme>(() => {
    const mode: ThemeMode =
      rawMode === 'system'
        ? system === 'light'
          ? 'light'
          : DEFAULT_MODE
        : rawMode && rawMode in { oled: 1, dim: 1, light: 1 }
          ? rawMode
          : DEFAULT_MODE;
    const accent: AccentName = rawAccent && rawAccent in accents ? rawAccent : DEFAULT_ACCENT;
    // PURE_OLED keeps its true-black backdrop; TACTICAL_DARK is the standard oled palette.
    const pureBlack = !rawMode && legacyTheme === 'PURE_OLED';
    return {
      colors: buildColors(mode, accent, pureBlack),
      mode,
      accent,
      dark: isDarkMode(mode),
      spacing,
      radius,
      type,
      touch,
    };
  }, [rawMode, rawAccent, legacyTheme, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
