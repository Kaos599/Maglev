import React, { useMemo } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { IconButton, ListRow } from '../ui';
import { Card } from './SettingsParts';
import { SettingEntry, searchSettings } from '../../utils/settingsIndex';

/** Search field for the Settings tab. */
export function SettingsSearchField({ query, onChangeQuery }: { query: string; onChangeQuery: (q: string) => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.field}>
      <PixelIcon name="search" size={20} color={colors.textMuted} />
      <TextInput
        style={s.input}
        value={query}
        onChangeText={onChangeQuery}
        placeholder="Search settings"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Search settings"
      />
      {query.length > 0 ? <IconButton icon="close" size={16} onPress={() => onChangeQuery('')} accessibilityLabel="Clear search" /> : null}
    </View>
  );
}

/** Results for a non-empty query: one row per matching setting, opening the page that holds it. */
export function SettingsSearchResults({ query }: { query: string }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const results = useMemo(() => searchSettings(query), [query]);
  if (results.length === 0) {
    return <Text style={s.empty}>{`No settings match "${query.trim()}".`}</Text>;
  }
  return (
    <Card>
      {results.map((entry) => (
        <ResultRow key={entry.id} entry={entry} />
      ))}
    </Card>
  );
}

function ResultRow({ entry }: { entry: SettingEntry }) {
  const router = useRouter();
  const subtitle = entry.section ? `${entry.pageTitle} · ${entry.section}` : entry.pageTitle;
  const onPress = () =>
    router.push({
      pathname: `/settings/${entry.page}` as never,
      params: { focus: entry.id },
    });
  return <ListRow title={entry.title} subtitle={subtitle} onPress={onPress} />;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    field: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 48,
      paddingLeft: spacing.lg,
      paddingRight: spacing.xs,
      gap: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
    },
    input: {
      ...type.body,
      flex: 1,
      minHeight: 48,
      fontSize: 15,
      color: c.text,
    },
    empty: {
      ...type.body,
      fontSize: 14,
      color: c.textMuted,
      paddingHorizontal: spacing.xs,
    },
  });
