import { useCallback } from 'react';
import { useSettings } from '../../context/SettingsContext';
import type { SubtitleSettings } from '../../utils/subtitles/prefs';

/** The subtitle section of the settings and a patch function. UI only: never reaches the native config. */
export function useSubtitleSettings(): [SubtitleSettings, (patch: Partial<SubtitleSettings>) => void] {
  const { settings, updateSettings } = useSettings();
  const patch = useCallback(
    (p: Partial<SubtitleSettings>) => updateSettings((prev) => ({ subtitles: { ...prev.subtitles, ...p } })),
    [updateSettings],
  );
  return [settings.subtitles, patch];
}
