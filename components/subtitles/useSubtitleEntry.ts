import { useMemo } from 'react';
import { useSettings } from '../../context/SettingsContext';
import { enabledProviders } from '../../utils/subtitles/providers';
import { listSubtitleEntries } from '../../utils/lists';
import { useListsVersion } from '../../utils/lists/hooks';

/** The two facts every entry point depends on: the master switch and how many sources are on (signed list included). */
export function useSubtitleAvailability(): { master: boolean; sourcesOn: number } {
  const { settings } = useSettings();
  const listsVersion = useListsVersion();
  const sub = settings.subtitles;
  return useMemo(
    () => ({ master: sub.enabled, sourcesOn: enabledProviders(sub, listSubtitleEntries()).length }),
    // The signed list can change without the settings changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sub, listsVersion],
  );
}
