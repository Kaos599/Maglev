import React from 'react';
import { Stack } from 'expo-router';
import { textSizeCopy, browserTabs } from '../../constants/copy';
import { browserSettingsCopy, searchEngineNames } from '../../constants/browserSettingsCopy';
import { ListRow, RadioCard, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { SEARCH_URLS, hostOf, type SearchEngine } from '../../utils/browserUrl';

const ENGINES: SearchEngine[] = ['duckduckgo', 'google', 'bing', 'brave'];

/** Exact sizes in percent. normalizeTextZoom keeps every one of them as it is. */
const TEXT_SIZES = [80, 90, 100, 115, 130, 150, 175, 200].map((v) => ({ value: v, label: textSizeCopy.value(v) }));

export default function BrowserGeneralSettings() {
  const [prefs, setPrefs] = useBrowserPrefs();

  return (
    <SettingsPage title={browserSettingsCopy.sections.general}>
      <Stack.Screen options={{ headerShown: false }} />

      <SectionHeader title="Search engine" />
      {ENGINES.map((e) => (
        <RadioCard
          key={e}
          icon="search"
          title={searchEngineNames[e]}
          description={hostOf(SEARCH_URLS[e])}
          selected={prefs.searchEngine === e}
          onPress={() => setPrefs({ searchEngine: e })}
        />
      ))}
      <Caption>{browserSettingsCopy.general.engineCaption}</Caption>

      <ChipGroup label={textSizeCopy.settingsLabel} options={TEXT_SIZES} value={prefs.browserTextZoom} onChange={(browserTextZoom) => setPrefs({ browserTextZoom })} />

      <Card>
        <ListRow
          title={browserTabs.settings.darkPages}
          subtitle={browserTabs.settings.darkPagesSubtitle}
          accessory={<Toggle value={prefs.darkPages} onValueChange={(darkPages) => setPrefs({ darkPages })} accessibilityLabel={browserTabs.settings.darkPages} />}
        />
        <ListRow
          title={browserSettingsCopy.general.desktopSite}
          subtitle={browserSettingsCopy.general.desktopSiteSubtitle}
          accessory={<Toggle value={prefs.desktopMode} onValueChange={(desktopMode) => setPrefs({ desktopMode })} accessibilityLabel={browserSettingsCopy.general.desktopSite} />}
        />
      </Card>
    </SettingsPage>
  );
}
