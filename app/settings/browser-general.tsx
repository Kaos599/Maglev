import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { textSizeCopy, browserTabs } from '../../constants/copy';
import { browserSettingsCopy, searchEngineNames } from '../../constants/browserSettingsCopy';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { ListRow, RadioCard, Toggle } from '../../components/ui';
import { Card, ChipGroup, Section, SettingsPage } from '../../components/settings/SettingsParts';
import { FocusAnchor, rowKey } from '../../components/settings/settingsFocus';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { SEARCH_URLS, hostOf, type SearchEngine } from '../../utils/browserUrl';

const ENGINES: SearchEngine[] = ['duckduckgo', 'google', 'bing', 'brave'];

/** Exact sizes in percent. normalizeTextZoom keeps every one of them as it is. */
const TEXT_SIZES = [80, 90, 100, 115, 130, 150, 175, 200].map((v) => ({ value: v, label: textSizeCopy.value(v) }));

export default function BrowserGeneralSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [prefs, setPrefs] = useBrowserPrefs();
  const h = browserSettingsCopy.headers;

  return (
    <SettingsPage title={browserSettingsCopy.sections.general}>
      <Stack.Screen options={{ headerShown: false }} />

      <Section title={h.searchEngine} caption={browserSettingsCopy.general.engineCaption}>
        {ENGINES.map((e) => (
          <FocusAnchor key={e} anchorKey={rowKey(searchEngineNames[e])}>
            <RadioCard
              icon="search"
              title={searchEngineNames[e]}
              description={hostOf(SEARCH_URLS[e])}
              selected={prefs.searchEngine === e}
              onPress={() => setPrefs({ searchEngine: e })}
            />
          </FocusAnchor>
        ))}
      </Section>

      <Section title={h.textSize}>
        <Card>
          <ChipGroup label={textSizeCopy.settingsLabel} options={TEXT_SIZES} value={prefs.browserTextZoom} onChange={(browserTextZoom) => setPrefs({ browserTextZoom })} />
          <View style={s.preview}>
            <Text style={[s.previewText, { fontSize: Math.round((type.size.base * prefs.browserTextZoom) / 100) }]}>{browserSettingsCopy.textPreview}</Text>
          </View>
        </Card>
      </Section>

      <Section title={h.pages}>
        <Card>
          <ListRow
            title={browserTabs.settings.darkPages}
            subtitle={browserTabs.settings.darkPagesSubtitle}
            accessory={<Toggle value={prefs.darkPages} onValueChange={(darkPages) => setPrefs({ darkPages })} accessibilityLabel={browserTabs.settings.darkPages} />}
          />
          <ListRow
            title={browserSettingsCopy.general.desktopSite}
            subtitle={browserSettingsCopy.general.desktopSiteSubtitle}
            accessory={<Toggle value={prefs.desktopMode} onValueChange={(desktopMode) => setPrefs({ desktopMode })} accessibilityLabel={browserSettingsCopy.general.desktopSite} />}
          />
        </Card>
      </Section>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    // Fixed height so the card does not jump while the size changes; long lines wrap inside it.
    preview: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, minHeight: 64 },
    previewText: { ...type.body, color: c.textMuted },
  });
