import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { spacing } from '../../constants/theme';
import { ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';
import { FocusAnchor, rowKey } from '../../components/settings/settingsFocus';
import { useSubtitleSettings } from '../../components/subtitles-settings/useSubtitleSettings';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists/store';
import { SUBTITLE_PROVIDERS } from '../../utils/subtitles/providers';
import { AUTO_NEW_VIDEOS_SUBTITLE, HEARING_OPTIONS, PRIVACY_LINE, SAF_UNAVAILABLE, SETTINGS_SWITCH_SUBTITLE, SETTINGS_TITLE } from '../../utils/subtitles/copy';
import { useSubtitleConsent } from '../../components/subtitles/useSubtitleConsent';
import { hasOpenSubtitlesKey, languagesValue, sourceRows, sourcesValue } from '../../utils/subtitleSettings';
import { subtitleSettingsCopy as copy } from '../../constants/copy';

const HEARING = (Object.keys(HEARING_OPTIONS) as (keyof typeof HEARING_OPTIONS)[]).map((value) => ({ value, label: HEARING_OPTIONS[value] }));

export default function SubtitlesSettings() {
  const router = useRouter();
  const [sub, patch] = useSubtitleSettings();
  const consent = useSubtitleConsent();
  const listsVersion = useListsVersion();
  const sources = React.useMemo(() => sourcesValue(sourceRows(SUBTITLE_PROVIDERS, sub, listSubtitleEntries())), [sub, listsVersion]);
  const off = !sub.enabled;

  return (
    <SettingsPage title={SETTINGS_TITLE}>
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <ListRow
          title="Subtitles"
          subtitle={SETTINGS_SWITCH_SUBTITLE}
          accessory={<Toggle value={sub.enabled} onValueChange={(enabled) => patch({ enabled })} accessibilityLabel={SETTINGS_TITLE} />}
        />
      </Card>

      <View style={off && styles.dim} pointerEvents={off ? 'none' : 'auto'} accessibilityState={{ disabled: off }}>
        {/* NATIVE_CONTRACT 44.6 */}
        <View style={[styles.group, styles.below]}>
          <Card>
            <ListRow
              title="Get subtitles for new videos"
              subtitle={AUTO_NEW_VIDEOS_SUBTITLE}
              accessory={<Toggle value={sub.autoNewVideos} onValueChange={(autoNewVideos) => {
                  // NATIVE_CONTRACT 44.15 D10 and 45.4: the switch stays off until Turn on; the sheet always shows.
                  if (autoNewVideos) consent.require(() => patch({ autoNewVideos: true }), { autoNewVideos: true }, { confirm: true });
                  else patch({ autoNewVideos: false });
                }} accessibilityLabel="Get subtitles for new videos" />}
            />
          </Card>
        </View>

        <View style={styles.group}>
          <SectionHeader title="Looking for" />
          <Card>
            <ListRow
              icon="peers"
              title={copy.languages.title}
              value={languagesValue(sub.languages)}
              disabled={off}
              onPress={() => router.push('/settings/subtitle-languages' as never)}
            />
            <ChipGroup
              label={copy.hearing.title}
              options={HEARING}
              value={sub.hearingImpaired}
              onChange={(hearingImpaired) => patch({ hearingImpaired })}
            />
          </Card>
          <Caption>{copy.hearing.caption}</Caption>
        </View>

        <View style={[styles.group, styles.gap]}>
          <SectionHeader title="Where from" />
          <Card>
            <ListRow icon="network" title={copy.sources.title} value={sources} disabled={off} onPress={() => router.push('/settings/subtitle-sources' as never)} />
            {hasOpenSubtitlesKey() ? (
              <ListRow
                icon="lock"
                title={copy.account.title}
                subtitle={copy.account.subtitle}
                disabled={off}
                onPress={() => router.push('/settings/opensubtitles' as never)}
              />
            ) : null}
          </Card>
        </View>
      </View>

      {consent.node}

      {/* NATIVE_CONTRACT 39.1 S6: the same line the menu rows show for a folder picked with the file picker. */}
      <Caption>{SAF_UNAVAILABLE}.</Caption>

      {/* The privacy line is searchable as "Subtitle privacy". */}
      <FocusAnchor anchorKey={rowKey('Subtitle privacy')}>
        <Caption>{PRIVACY_LINE}</Caption>
      </FocusAnchor>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  dim: { opacity: 0.45 },
  group: { gap: spacing.sm },
  gap: { marginTop: spacing.lg },
  below: { marginBottom: spacing.lg },
});
