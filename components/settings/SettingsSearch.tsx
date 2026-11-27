import React, { useEffect, useMemo, useState } from 'react';
import { Keyboard, StyleSheet, Text } from 'react-native';
import { useRootNavigationState, useRouter } from 'expo-router';
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
  // On a cold start a tap can land before the root layout has mounted; pushing then throws. Wait for it.
  const ready = Boolean(useRootNavigationState()?.key);
  const [pending, setPending] = useState(false);
  const subtitle = entry.section ? `${entry.pageTitle} · ${entry.section}` : entry.pageTitle;
  const open = () => {
    Keyboard.dismiss();
    router.push({
      pathname: `/settings/${entry.page}` as never,
      params: { focus: entry.id },
    });
  };
  useEffect(() => {
    if (pending && ready) {
      setPending(false);
      open();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, ready]);
  const onPress = () => {
    if (ready) open();
    else setPending(true);
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
