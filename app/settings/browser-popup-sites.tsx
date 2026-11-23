import React from 'react';
import { Stack } from 'expo-router';
import { browserTabs } from '../../constants/copy';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { SettingsPage } from '../../components/settings/SettingsParts';
import { HostList } from '../../components/browser/HostList';
import { useBrowserPrefs } from '../../utils/prefs/browser';

/** Sites allowed to open pop-ups and redirects. Always reachable, even when empty. Search filters by host. */
export default function BrowserPopupSites() {
  const [prefs, setPrefs] = useBrowserPrefs();

  return (
    <SettingsPage title={browserTabs.settings.allowedSites}>
      <Stack.Screen options={{ headerShown: false }} />
      <HostList
        hosts={prefs.popupAllowHosts}
        empty={{ icon: 'shield', title: browserSettingsCopy.sites.popupEmpty.title, body: browserSettingsCopy.sites.popupEmpty.body }}
        removeLabel={(h) => `${browserTabs.settings.remove} ${h}`}
        onRemove={(h) => setPrefs({ popupAllowHosts: prefs.popupAllowHosts.filter((x) => x !== h) })}
      />
    </SettingsPage>
  );
}
