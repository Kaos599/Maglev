import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { EmptyBlock, SectionHeader } from '../../components/ui';
import { Caption, Card, SettingsPage } from '../../components/settings/SettingsParts';
import { ProviderRow } from '../../components/search-providers/ProviderRow';
import { SourceSheet } from '../../components/subtitles-settings/SourceSheet';
import { useSubtitleSettings } from '../../components/subtitles-settings/useSubtitleSettings';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists/store';
import { useListPrefs } from '../../utils/prefs/lists';
import { relativeTime } from '../../utils/feeds';
import { SUBTITLE_PROVIDERS } from '../../utils/subtitles/providers';
import { withSourceEnabled } from '../../utils/subtitles/prefs';
import { TURNED_OFF_BY_MAGLEV } from '../../utils/subtitles/copy';
import { sourceRows, type SourceRow } from '../../utils/subtitleSettings';
import { listsCopy, subtitleSettingsCopy } from '../../constants/copy';

const copy = subtitleSettingsCopy.sources;

/** Same shape as Search sources: a caption, On and Off sections of source rows, and a closing note. */
export default function SubtitleSourcesSettings() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [sub, patch] = useSubtitleSettings();
  const [listPrefs] = useListPrefs();
  const [openId, setOpenId] = useState<string | null>(null);

  // A new source list changes mirrors and which sources are turned off.
  const listsVersion = useListsVersion();
  const rows = useMemo(() => sourceRows(SUBTITLE_PROVIDERS, sub, listSubtitleEntries()), [sub, listsVersion]);
  const onList = rows.filter((r) => r.on);
  const offList = rows.filter((r) => !r.on);
  const open = rows.find((r) => r.id === openId) ?? null;

  const stamp = listPrefs.sourcesFile ? Date.parse(listPrefs.sourcesFile.generatedAt) || listPrefs.lastListCheckAt : null;
  const listLine = listPrefs.appliedSerial > 0 && stamp ? listsCopy.sources.updated(relativeTime(stamp)) : listsCopy.sources.builtIn;

  const setEnabled = (id: string, on: boolean) => patch({ sourceEnabled: withSourceEnabled(sub, id, on) });
  const note = (r: SourceRow): { text: string; tone: 'normal' | 'warning' } =>
    r.turnedOff
      ? { text: r.turnedOff.note ? listsCopy.providers.turnedOffWithNote(r.turnedOff.note) : TURNED_OFF_BY_MAGLEV, tone: 'warning' }
      : { text: `${r.matches} · ${r.languages}`, tone: 'normal' };

  const renderRow = (r: SourceRow, i: number) => {
    const n = note(r);
    return (
      <ProviderRow
        key={r.id}
        provider={r}
        enabled={r.on}
        note={n.text}
        noteTone={n.tone}
        first={i === 0}
        locked={!!r.turnedOff}
        toggleLabel={copy.toggle(r.name)}
        onOpen={() => setOpenId(r.id)}
        onToggle={(on) => setEnabled(r.id, on)}
      />
    );
  };

  return (
    <SettingsPage title={copy.pageTitle}>
      <Stack.Screen options={{ headerShown: false }} />
      <Caption>{copy.caption}</Caption>
      <Caption>{copy.listLine(listLine)}</Caption>

      {rows.length === 0 ? (
        <EmptyBlock icon="subtitles" title={copy.empty} body={copy.emptyBody} />
      ) : (
        <>
          <View style={styles.section}>
            <SectionHeader title={copy.on(onList.length)} />
            <Card>
              {onList.length === 0 ? <Text style={styles.empty}>{copy.nothingOn}</Text> : null}
              {onList.map(renderRow)}
            </Card>
          </View>
          {offList.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title={copy.off} />
              <Card>{offList.map(renderRow)}</Card>
            </View>
          ) : null}
          <Caption>{copy.footer}</Caption>
        </>
      )}

      <SourceSheet source={open} onClose={() => setOpenId(null)} />
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    section: { gap: spacing.sm },
    empty: { ...type.body, fontSize: type.size.md, color: c.textMuted, padding: spacing.lg },
  });
