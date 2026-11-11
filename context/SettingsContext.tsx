import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DEFAULT_SETTINGS,
  MaglevSettings,
  SpeedPreset,
  ThemeMode,
  maglevEngine,
  settingsStore,
} from 'maglev-engine';
import { kvGet, kvSet } from '../utils/prefs/kv';

interface SettingsContextType {
  settings: MaglevSettings;
  theme: ThemeMode;
  isOledBlack: boolean;
  updateSettings: (updater: Partial<MaglevSettings> | ((prev: MaglevSettings) => Partial<MaglevSettings>)) => void;
  resetSettings: () => void;
  setSpeedPreset: (type: 'download' | 'upload', preset: SpeedPreset, customBps?: number) => void;
  loadIpFilter: (content: string) => Promise<number>;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

const WIFI_DEFAULT_KEY = 'maglev.defaults.wifiOnly.v1';

/**
 * A fresh install defaults to Wi-Fi only (UI_SPEC_PHASE2 S10.7). This runs once.
 * Anyone who already finished onboarding keeps their value; nothing changes silently.
 */
function readSettingsWithFreshDefaults(): MaglevSettings {
  const current = settingsStore.getSettings();
  if (kvGet(WIFI_DEFAULT_KEY)) return current;
  kvSet(WIFI_DEFAULT_KEY, '1');
  if (current.onboarded || current.network.wifiOnly) return current;
  return settingsStore.updateSettings({ network: { ...current.network, wifiOnly: true } });
}

export const SettingsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [settings, setSettings] = useState<MaglevSettings>(readSettingsWithFreshDefaults);

  useEffect(() => {
    // Subscribe to store updates (< 1ms dispatch)
    const unsubscribe = settingsStore.subscribe((newSettings) => {
      setSettings(newSettings);
      maglevEngine.applySettings(newSettings);
    });
    return () => unsubscribe();
  }, []);

  const updateSettings = useCallback(
    (updater: Partial<MaglevSettings> | ((prev: MaglevSettings) => Partial<MaglevSettings>)) => {
      const updated = settingsStore.updateSettings(updater);
      setSettings(updated);
    },
    []
  );

  const resetSettings = useCallback(() => {
    const reset = settingsStore.resetToDefaults();
    setSettings(reset);
  }, []);

  const setSpeedPreset = useCallback(
    (type: 'download' | 'upload', preset: SpeedPreset, customBps?: number) => {
      settingsStore.updateSettings((prev) => {
        if (type === 'download') {
          return {
            bandwidth: {
              ...prev.bandwidth,
              downloadPreset: preset,
              downloadLimitBytesPerSec: preset === 'CUSTOM' ? (customBps || 0) : 0,
            },
          };
        } else {
          return {
            bandwidth: {
              ...prev.bandwidth,
              uploadPreset: preset,
              uploadLimitBytesPerSec: preset === 'CUSTOM' ? (customBps || 0) : 0,
            },
          };
        }
      });
    },
    []
  );

  const loadIpFilter = useCallback(async (content: string) => {
    return await maglevEngine.loadIpFilterDat(content);
  }, []);

  const theme = settings.appearance.theme;
  const isOledBlack = theme === 'PURE_OLED';

  const contextValue = useMemo(
    () => ({
      settings,
      theme,
      isOledBlack,
      updateSettings,
      resetSettings,
      setSpeedPreset,
      loadIpFilter,
    }),
    [settings, theme, isOledBlack, updateSettings, resetSettings, setSpeedPreset, loadIpFilter]
  );

  return <SettingsContext.Provider value={contextValue}>{children}</SettingsContext.Provider>;
};

export function useSettings(): SettingsContextType {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}
