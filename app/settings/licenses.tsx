import React, { useMemo } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { ListRow, SectionHeader } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { LICENCE_URL, aboutExtrasCopy } from '../../constants/aboutCopy';
import { LICENSES } from '../../constants/licenses.generated';

const copy = aboutExtrasCopy.licences;

export default function LicencesSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <SettingsPage title={copy.title}>
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <View style={s.intro}>
          <Text style={s.introText}>{copy.intro}</Text>
        </View>
        <ListRow
          title={copy.read}
          icon="file"
          onPress={() => void Linking.openURL(LICENCE_URL)}
          accessibilityHint={copy.readHint}
        />
      </Card>
      <SectionHeader title={copy.builtWith} />
      <Card>
        {LICENSES.map((l) => (
          <ListRow
            key={l.name}
            title={l.name}
            value={l.license}
            onPress={l.url ? () => void Linking.openURL(l.url) : undefined}
            accessibilityHint={l.url ? copy.rowHint : undefined}
          />
        ))}
      </Card>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    intro: { padding: spacing.lg },
    introText: { ...type.body, fontSize: type.size.lg, color: c.text },
  });
