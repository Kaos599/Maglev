import React from 'react';
import { Stack } from 'expo-router';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs } from '../../utils/prefs/browser';

export default function BrowserGesturesSettings() {
  const [prefs, setPrefs] = useBrowserPrefs();
  const c = browserSettingsCopy.gestures;

  return (
    <SettingsPage title={browserSettingsCopy.sections.gestures}>
      <Stack.Screen options={{ headerShown: false }} />

      <Card>
        <ListRow
          title={c.swipeTabs}
          subtitle={c.swipeTabsSubtitle}
          accessory={<Toggle value={prefs.swipeTabs} onValueChange={(swipeTabs) => setPrefs({ swipeTabs })} accessibilityLabel={c.swipeTabs} />}
        />
        <ListRow
          title={c.pullToRefresh}
          subtitle={c.pullToRefreshSubtitle}
          accessory={<Toggle value={prefs.pullToRefresh} onValueChange={(pullToRefresh) => setPrefs({ pullToRefresh })} accessibilityLabel={c.pullToRefresh} />}
        />
      </Card>
    </SettingsPage>
  );
}
