import React, { useMemo } from 'react';
import { Keyboard, StyleSheet, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { ListRow, TextField } from '../ui';
import { Card } from './SettingsParts';
import { SettingEntry, searchSettings } from '../../utils/settingsIndex';

/** Search field for the Settings tab. */
export function SettingsSearchField({ query, onChangeQuery }: { query: string; onChangeQuery: (q: string) => void }) {
  return (
    <TextField
      leadingIcon="search"
      clearable
      clearLabel="Clear search"
      size="lg"
      value={query}
      onChangeText={onChangeQuery}
      placeholder="Search settings"
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="search"
      accessibilityLabel="Search settings"
    />
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
  const onPress = () => {
    Keyboard.dismiss();
    router.push({
      pathname: `/settings/${entry.page}` as never,
      params: { focus: entry.id },
    });
  };
  return <ListRow title={entry.title} subtitle={subtitle} onPress={onPress} />;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    empty: {
      ...type.body,
      fontSize: type.size.base,
      color: c.textMuted,
      paddingHorizontal: spacing.xs,
    },
  });
