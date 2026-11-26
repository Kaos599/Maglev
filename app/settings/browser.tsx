import React, { useMemo } from 'react';
import { Stack, useRouter } from 'expo-router';
import { bookmarkCopy } from '../../constants/bookmarkCopy';
import { historyCopy } from '../../constants/copy';
import { browserSettingsCopy, hubSummaries } from '../../constants/browserSettingsCopy';
import { ListRow } from '../../components/ui';
import { Card, Section, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs } from '../../utils/prefs/browser';

/** Settings › Browser: grouped rows, each opening its own screen (app/settings/browser-*.tsx). */
export default function BrowserSettings() {
  const router = useRouter();
  const [prefs] = useBrowserPrefs();
  const summary = useMemo(() => hubSummaries(prefs), [prefs]);
  const { sections, groups } = browserSettingsCopy;
  const go = (route: string) => () => router.push(route as never);

  return (
    <SettingsPage title={browserSettingsCopy.hubTitle}>
      <Stack.Screen options={{ headerShown: false }} />

      <Section title={groups.browsing}>
        <Card>
          <ListRow icon="settings" title={sections.general} subtitle={summary.general} onPress={go('/settings/browser-general')} />
          <ListRow icon="grid" title={sections.startPage} subtitle={summary.startPage} onPress={go('/settings/browser-start')} />
        </Card>
      </Section>

      <Section title={groups.privacySafety}>
        <Card>
          <ListRow icon="lock" title={sections.privacy} subtitle={summary.privacy} onPress={go('/settings/browser-privacy')} />
          <ListRow icon="shield" title={sections.blocking} subtitle={summary.blocking} onPress={go('/settings/browser-blocking')} />
        </Card>
      </Section>

      <Section title={groups.downloads}>
        <Card>
          <ListRow icon="file-video" title={sections.media} subtitle={summary.media} onPress={go('/settings/browser-media')} />
        </Card>
      </Section>

      <Section title={groups.pages}>
        <Card>
          <ListRow icon="bookmark" title={bookmarkCopy.screenTitle} onPress={() => router.push('/browser-bookmarks')} />
          <ListRow icon="clock" title={historyCopy.settings.open} onPress={() => router.push('/browser-history')} />
        </Card>
      </Section>

      <Section title={groups.more}>
        <Card>
          <ListRow icon="interface" title={sections.advanced} subtitle={summary.advanced} onPress={go('/settings/browser-advanced')} />
        </Card>
      </Section>
    </SettingsPage>
  );
}
