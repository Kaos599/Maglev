import React, { useCallback, useEffect, useState } from 'react';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { getBlocklistInfo } from 'maglev-engine';
import { browserTabs } from '../../constants/copy';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, RadioCard, Toggle } from '../../components/ui';
import { Card, Section, SettingsPage } from '../../components/settings/SettingsParts';
import { FocusAnchor, rowKey } from '../../components/settings/settingsFocus';
import type { PixelIconName } from '../../components/PixelIcon';
import { blockedSiteRows, loadPopupLog, type PopupLog } from '../../utils/browser/popupLog';
import { relativeTime } from '../../utils/feeds';
import { useBrowserPrefs, type PopupPolicy } from '../../utils/prefs/browser';

const POPUP_CHOICES: { value: PopupPolicy; title: string; line: string; icon: PixelIconName }[] = [
  { value: 'ask', title: browserTabs.settings.ask, line: browserSettingsCopy.popupLines.ask, icon: 'bell' },
  { value: 'block', title: browserTabs.settings.block, line: browserSettingsCopy.popupLines.block, icon: 'shield' },
  { value: 'allow', title: browserTabs.settings.allow, line: browserSettingsCopy.popupLines.allow, icon: 'external' },
];

/** Trailing text for a site list row: the count, or None. */
const countText = (n: number) => (n === 0 ? 'None' : String(n));

/** Subtitle of the Blocked pop-ups row: "None", "1 site" or "N sites". */
const siteCountText = (n: number) => (n === 0 ? browserSettingsCopy.blockedPopups.none : n === 1 ? '1 site' : `${n} sites`);

export default function BrowserBlockingSettings() {
  const router = useRouter();
  const [prefs, setPrefs] = useBrowserPrefs();
  const [log, setLog] = useState<PopupLog>(() => loadPopupLog());
  const [listUpdated, setListUpdated] = useState<number | null>(null);
  const copy = browserSettingsCopy.blocking;
  // The log changes on the list and detail screens, so read it again whenever this screen comes back.
  useFocusEffect(useCallback(() => setLog(loadPopupLog()), []));
  // When the block list was last updated; unknown (no native engine, built-in list) keeps the plain subtitle.
  useEffect(() => {
    let live = true;
    void getBlocklistInfo().then((res) => {
      if (live && res.ok) setListUpdated(res.updatedAt ?? null);
    });
    return () => {
      live = false;
    };
  }, []);
  const blockedSites = blockedSiteRows(prefs.popupBlockHosts, log).length;
  const h = browserSettingsCopy.headers;

  return (
    <SettingsPage title={browserSettingsCopy.sections.blocking}>
      <Stack.Screen options={{ headerShown: false }} />

      <Section title={h.ads}>
        <Card>
          <ListRow
            title="Ad blocking"
            subtitle="Blocks ads and trackers on the pages you open."
            accessory={<Toggle value={prefs.adBlock} onValueChange={(adBlock) => setPrefs({ adBlock })} accessibilityLabel="Ad blocking" />}
          />
          <ListRow
            title={copy.blocklists}
            subtitle={listUpdated != null ? undefined : copy.blocklistsSubtitle}
            value={listUpdated != null ? `Updated ${relativeTime(listUpdated)}` : undefined}
            onPress={() => router.push('/settings/browser-blocklists' as never)}
          />
          <ListRow
            title={copy.adSites}
            value={countText(prefs.allowAdsHosts.length)}
            onPress={() => router.push('/settings/browser-ad-sites' as never)}
          />
        </Card>
      </Section>

      <Section title={h.popups}>
        {POPUP_CHOICES.map((c) => (
          <FocusAnchor key={c.value} anchorKey={rowKey(c.title)}>
            <RadioCard
              icon={c.icon}
              title={c.title}
              description={c.line}
              selected={prefs.popupPolicy === c.value}
              onPress={() => setPrefs({ popupPolicy: c.value })}
            />
          </FocusAnchor>
        ))}
        <Card>
          <ListRow
            title={browserSettingsCopy.blockedPopups.row}
            subtitle={siteCountText(blockedSites)}
            onPress={() => router.push('/settings/browser-blocked-popups' as never)}
          />
          <ListRow
            title={browserTabs.settings.allowedSites}
            value={countText(prefs.popupAllowHosts.length)}
            onPress={() => router.push('/settings/browser-popup-sites' as never)}
          />
        </Card>
      </Section>
    </SettingsPage>
  );
}
