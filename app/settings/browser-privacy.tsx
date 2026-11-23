import React, { useRef, useState } from 'react';
import { Stack } from 'expo-router';
import { historyCopy } from '../../constants/copy';
import { haptic } from '../../constants/haptics';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { ClearHistorySheet, type ClearMode } from '../../components/browser/ClearHistorySheet';
import { useBrowserPrefs } from '../../utils/prefs/browser';

export default function BrowserPrivacySettings() {
  const [prefs, setPrefs] = useBrowserPrefs();
  const [clearMode, setClearMode] = useState<ClearMode | null>(null);
  // The sheet keeps its last mode while it slides out.
  const lastMode = useRef<ClearMode>('browsing-data');
  if (clearMode) lastMode.current = clearMode;

  return (
    <SettingsPage title={browserSettingsCopy.sections.privacy}>
      <Stack.Screen options={{ headerShown: false }} />

      <SectionHeader title={historyCopy.settings.section} />
      <Card>
        <ListRow
          title={historyCopy.settings.private}
          subtitle={historyCopy.settings.privateSubtitle}
          accessory={<Toggle value={prefs.privateBrowsing} onValueChange={(privateBrowsing) => setPrefs({ privateBrowsing })} accessibilityLabel={historyCopy.settings.private} />}
        />
        <ListRow
          title={historyCopy.settings.save}
          subtitle={historyCopy.settings.saveSubtitle}
          accessory={<Toggle value={prefs.saveHistory} onValueChange={(saveHistory) => setPrefs({ saveHistory })} accessibilityLabel={historyCopy.settings.save} />}
        />
        <ListRow
          title={historyCopy.settings.suggest}
          subtitle={historyCopy.settings.suggestSubtitle}
          accessory={<Toggle value={prefs.suggestFromHistory} onValueChange={(suggestFromHistory) => setPrefs({ suggestFromHistory })} accessibilityLabel={historyCopy.settings.suggest} />}
        />
        <ListRow
          title={historyCopy.settings.clearOnClose}
          subtitle={historyCopy.settings.clearOnCloseSubtitle}
          accessory={<Toggle value={prefs.clearHistoryOnClose} onValueChange={(clearHistoryOnClose) => setPrefs({ clearHistoryOnClose })} accessibilityLabel={historyCopy.settings.clearOnClose} />}
        />
      </Card>

      <Card>
        <ListRow
          title={browserSettingsCopy.privacy.blockCookies}
          subtitle={browserSettingsCopy.privacy.blockCookiesSubtitle}
          accessory={<Toggle value={prefs.blockThirdPartyCookies} onValueChange={(blockThirdPartyCookies) => setPrefs({ blockThirdPartyCookies })} accessibilityLabel={browserSettingsCopy.privacy.blockCookies} />}
        />
      </Card>

      <Card>
        <ListRow
          icon="trash"
          title={historyCopy.settings.clear}
          destructive
          onPress={() => {
            haptic('warn');
            setClearMode('range');
          }}
        />
      </Card>

      <Card>
        <ListRow
          icon="trash"
          title="Clear browsing data"
          destructive
          onPress={() => {
            haptic('warn');
            setClearMode('browsing-data');
          }}
        />
      </Card>

      <ClearHistorySheet visible={clearMode != null} mode={lastMode.current} onClose={() => setClearMode(null)} />
    </SettingsPage>
  );
}
