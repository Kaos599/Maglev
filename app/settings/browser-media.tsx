import React from 'react';
import { Stack } from 'expo-router';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { ListRow, Toggle } from '../../components/ui';
import { Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';
import { STREAM_QUALITIES, useBrowserPrefs } from '../../utils/prefs/browser';

const QUALITY_CHOICES = STREAM_QUALITIES.map((q) => ({ value: q, label: browserSettingsCopy.media.qualities[q] }));

/** Found files and video streams: the same "hide small files" setting the Find videos list uses. */
export default function BrowserMediaSettings() {
  const [prefs, setPrefs] = useBrowserPrefs();
  const c = browserSettingsCopy.media;

  return (
    <SettingsPage title={browserSettingsCopy.sections.media}>
      <Stack.Screen options={{ headerShown: false }} />

      <Card>
        <ListRow
          title={c.hideSmall}
          subtitle={c.hideSmallSubtitle}
          accessory={<Toggle value={prefs.hideSmallFiles} onValueChange={(hideSmallFiles) => setPrefs({ hideSmallFiles })} accessibilityLabel={c.hideSmall} />}
        />
      </Card>

      <ChipGroup
        label={c.streamQuality}
        caption={c.streamQualityCaption}
        options={QUALITY_CHOICES}
        value={prefs.streamQuality}
        onChange={(streamQuality) => setPrefs({ streamQuality })}
      />
    </SettingsPage>
  );
}
