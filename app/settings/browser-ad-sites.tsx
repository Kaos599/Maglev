import React from 'react';
import { Stack } from 'expo-router';
import { empty } from '../../constants/copy';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { SettingsPage } from '../../components/settings/SettingsParts';
import { HostList } from '../../components/browser/HostList';
import { useBrowserPrefs } from '../../utils/prefs/browser';

/** Sites the user allowed to show ads. Search filters by host. */
export default function BrowserAdSites() {
  const [prefs, setPrefs] = useBrowserPrefs();

  return (
    <SettingsPage title={browserSettingsCopy.blocking.adSites}>
      <Stack.Screen options={{ headerShown: false }} />
      <HostList
        hosts={prefs.allowAdsHosts}
        empty={{ icon: 'shield', title: empty.browser.noAllowedSites.title, body: empty.browser.noAllowedSites.body }}
        removeLabel={(h) => `Block ads on ${h}`}
        onRemove={(h) => setPrefs({ allowAdsHosts: prefs.allowAdsHosts.filter((x) => x !== h) })}
      />
    </SettingsPage>
  );
}
