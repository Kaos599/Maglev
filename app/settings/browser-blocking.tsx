import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { browserTabs } from '../../constants/copy';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs, type PopupPolicy } from '../../utils/prefs/browser';

const POPUP_CHOICES: { value: PopupPolicy; title: string }[] = [
  { value: 'ask', title: browserTabs.settings.ask },
  { value: 'block', title: browserTabs.settings.block },
  { value: 'allow', title: browserTabs.settings.allow },
];

/** Trailing text for a site list row: the count, or None. */
const countText = (n: number) => (n === 0 ? 'None' : String(n));

export default function BrowserBlockingSettings() {
  const router = useRouter();
  const [prefs, setPrefs] = useBrowserPrefs();
  const copy = browserSettingsCopy.blocking;

  return (
    <SettingsPage title={browserSettingsCopy.sections.blocking}>
      <Stack.Screen options={{ headerShown: false }} />

      <Card>
        <ListRow
          title="Ad blocking"
          subtitle="Blocks ads and trackers on the pages you open."
          accessory={<Toggle value={prefs.adBlock} onValueChange={(adBlock) => setPrefs({ adBlock })} accessibilityLabel="Ad blocking" />}
        />
      </Card>

      <Card>
        <ListRow title={copy.blocklists} subtitle={copy.blocklistsSubtitle} onPress={() => router.push('/settings/browser-blocklists' as never)} />
        <ListRow
          title={copy.adSites}
          value={countText(prefs.allowAdsHosts.length)}
          onPress={() => router.push('/settings/browser-ad-sites' as never)}
        />
      </Card>

      <SectionHeader title={browserTabs.settings.section} />
      <Card>
        {POPUP_CHOICES.map((c) => (
          <ListRow
            key={c.value}
            title={c.title}
            selected={prefs.popupPolicy === c.value}
            accessibilityLabel={c.title}
            onPress={() => setPrefs({ popupPolicy: c.value })}
          />
        ))}
      </Card>
      <Card>
        <ListRow
          title={browserTabs.settings.allowedSites}
          value={countText(prefs.popupAllowHosts.length)}
          onPress={() => router.push('/settings/browser-popup-sites' as never)}
        />
      </Card>
    </SettingsPage>
  );
}
