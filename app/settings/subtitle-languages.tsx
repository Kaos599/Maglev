import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { IconButton, ListRow, SectionHeader, TextField } from '../../components/ui';
import { Caption, Card, SettingsPage } from '../../components/settings/SettingsParts';
import { useSubtitleSettings } from '../../components/subtitles-settings/useSubtitleSettings';
import { languageInfo, languageName } from '../../utils/subtitles/languages';
import { moveLanguage, phoneLanguageLabel, pickableLanguages, toggleLanguage } from '../../utils/subtitleSettings';
import { subtitleSettingsCopy } from '../../constants/copy';

const copy = subtitleSettingsCopy.languages;

export default function SubtitleLanguagesSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [sub, patch] = useSubtitleSettings();
  const [query, setQuery] = useState('');
  const chosen = sub.languages;
  const pickable = useMemo(() => pickableLanguages(chosen, query), [chosen, query]);
  const set = (languages: string[]) => patch({ languages });

  return (
    <SettingsPage title={copy.title}>
      <Stack.Screen options={{ headerShown: false }} />
      <Caption>{copy.caption}</Caption>

      <View style={s.section}>
        <SectionHeader title={copy.yours} />
        <Card>
          {chosen.length === 0 ? (
            <ListRow icon="peers" title={phoneLanguageLabel()} subtitle={copy.followsPhone} />
          ) : (
            chosen.map((code, i) => {
              const name = languageName(code);
              return (
                <View key={code} style={[s.row, i > 0 && s.divider]}>
                  <Text style={s.position} accessibilityElementsHidden importantForAccessibility="no">
                    {i + 1}
                  </Text>
                  <View style={s.texts}>
                    <Text style={s.name} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={s.native} numberOfLines={1}>
                      {languageInfo(code)?.native ?? code}
                    </Text>
                  </View>
                  <IconButton icon="arrow-up" accessibilityLabel={copy.moveUp(name)} disabled={i === 0} onPress={() => set(moveLanguage(chosen, code, -1))} />
                  <IconButton icon="arrow-down" accessibilityLabel={copy.moveDown(name)} disabled={i === chosen.length - 1} onPress={() => set(moveLanguage(chosen, code, 1))} />
                  <IconButton icon="close" accessibilityLabel={copy.remove(name)} onPress={() => set(toggleLanguage(chosen, code))} />
                </View>
              );
            })
          )}
        </Card>
      </View>

      <View style={s.section}>
        <SectionHeader title={copy.all} />
        <TextField
          leadingIcon="search"
          clearable
          clearLabel="Clear search"
          size="lg"
          value={query}
          onChangeText={setQuery}
          placeholder={copy.search}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={copy.search}
        />
        {pickable.length === 0 ? (
          <Text style={s.empty}>{copy.noMatch(query.trim())}</Text>
        ) : (
          <Card>
            {pickable.map((l) => (
              <ListRow key={l.code} title={l.name} subtitle={l.native !== l.name ? l.native : undefined} icon="plus" onPress={() => set(toggleLanguage(chosen, l.code))} accessibilityLabel={`Add ${l.name}`} />
            ))}
          </Card>
        )}
      </View>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    section: { gap: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: spacing.md, gap: spacing.xs },
    divider: { borderTopWidth: 1, borderTopColor: c.border },
    position: { ...type.mono, width: 18, fontSize: type.size.sm, color: c.textMuted, textAlign: 'center' },
    texts: { flex: 1, gap: 2, marginLeft: spacing.xs },
    name: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text },
    native: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    empty: { ...type.body, fontSize: type.size.md, color: c.textMuted, padding: spacing.lg },
  });
