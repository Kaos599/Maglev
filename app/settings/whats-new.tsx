import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { aboutExtrasCopy } from '../../constants/aboutCopy';
import { RELEASE_NOTES } from '../../constants/releaseNotes.generated';
import { plainNotes } from '../../utils/update/check';

export default function WhatsNewSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const version = Constants.expoConfig?.version ?? '';
  const raw = RELEASE_NOTES[version];
  return (
    <SettingsPage title={aboutExtrasCopy.whatsNew(version || '—')}>
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <View style={s.body}>
          <Text style={s.text} selectable>
            {raw ? plainNotes(raw, 20000) : aboutExtrasCopy.notes.none}
          </Text>
        </View>
      </Card>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { padding: spacing.lg },
    text: { ...type.body, fontSize: 15, lineHeight: 22, color: c.text },
  });
