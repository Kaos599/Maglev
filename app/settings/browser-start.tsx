import React from 'react';
import { Stack } from 'expo-router';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, Toggle } from '../../components/ui';
import { Card, Section, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs } from '../../utils/prefs/browser';

/** What a blank tab shows: the frequent sites and the bookmark tiles. Recent pages follow history settings. */
export default function BrowserStartSettings() {
  const [prefs, setPrefs] = useBrowserPrefs();
  const c = browserSettingsCopy.startPage;

  return (
    <SettingsPage title={browserSettingsCopy.sections.startPage}>
      <Stack.Screen options={{ headerShown: false }} />

      <Section title={browserSettingsCopy.headers.blankTab} caption={c.caption}>
        <Card>
          <ListRow
            title={c.showFrequent}
            subtitle={c.showFrequentSubtitle}
            accessory={<Toggle value={prefs.showFrequentSites} onValueChange={(showFrequentSites) => setPrefs({ showFrequentSites })} accessibilityLabel={c.showFrequent} />}
          />
          <ListRow
            title={c.showBookmarks}
            subtitle={c.showBookmarksSubtitle}
            accessory={<Toggle value={prefs.showBookmarksOnStart} onValueChange={(showBookmarksOnStart) => setPrefs({ showBookmarksOnStart })} accessibilityLabel={c.showBookmarks} />}
          />
        </Card>
      </Section>
    </SettingsPage>
  );
}
