import React from 'react';
import { Stack } from 'expo-router';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs } from '../../utils/prefs/browser';

export default function BrowserAdvancedSettings() {
  const [prefs, setPrefs] = useBrowserPrefs();
  const c = browserSettingsCopy.advanced;

  return (
    <SettingsPage title={browserSettingsCopy.sections.advanced}>
      <Stack.Screen options={{ headerShown: false }} />

      <Card>
        <ListRow
          title={c.httpsFirst}
          subtitle={c.httpsFirstSubtitle}
          accessory={<Toggle value={prefs.httpsFirst} onValueChange={(httpsFirst) => setPrefs({ httpsFirst })} accessibilityLabel={c.httpsFirst} />}
        />
      </Card>
    </SettingsPage>
  );
}
