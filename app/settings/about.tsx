import React, { useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import { maglevEngine } from 'maglev-engine';
import { ThemeColors, spacing } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { ListRow } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { Wordmark } from '../../components/settings/Wordmark';
import { MaglevMark } from '../../components/brand/MaglevMark';

const REPO_URL = 'https://github.com/Kaos599/Maglev';

type Extra = { license?: string; homepage?: string; sourceUrl?: string; privacyUrl?: string };

export default function AboutSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [engine, setEngine] = useState<string>('—');
  const appVersion = Constants.expoConfig?.version ?? '—';
  const extra = (Constants.expoConfig?.extra ?? {}) as Extra;

  useEffect(() => {
    let alive = true;
    maglevEngine
      .version()
      .then((v) => {
        if (!alive) return;
        setEngine(v.engine === 'unavailable' || !v.version ? 'Unavailable' : `${v.engine} ${v.version}`);
      })
      .catch(() => alive && setEngine('Unavailable'));
    return () => {
      alive = false;
    };
  }, []);

  const links = [
    extra.homepage && { title: 'Website', url: extra.homepage },
    extra.sourceUrl && extra.sourceUrl !== REPO_URL && { title: 'Source code', url: extra.sourceUrl },
    extra.privacyUrl && { title: 'Privacy policy', url: extra.privacyUrl },
  ].filter(Boolean) as { title: string; url: string }[];

  return (
    <SettingsPage title="ABOUT">
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.brand}>
        <MaglevMark height={64} cruising tappable />
        <Wordmark />
      </View>
      <Card>
        <ListRow title="App version" value={appVersion} />
        <ListRow title="Engine" value={engine} />
        {extra.license ? <ListRow title="License" value={extra.license} /> : null}
        <ListRow
          title="Made with love by Kaos"
          subtitle="github.com/Kaos599/Maglev"
          icon="github"
          onPress={() => void Linking.openURL(REPO_URL)}
          accessibilityHint="Opens the Maglev source code on GitHub"
        />
        {links.map((l) => (
          <ListRow key={l.url} title={l.title} onPress={() => void Linking.openURL(l.url)} />
        ))}
      </Card>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    brand: { alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.xxl },
  });
