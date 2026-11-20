import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import Constants from 'expo-constants';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { useTheme } from '../../context/ThemeContext';
import { SectionHeader } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { aboutExtrasCopy } from '../../constants/aboutCopy';
import { RELEASE_NOTES } from '../../constants/releaseNotes.generated';
import { parseReleaseNotes } from '../../utils/releaseNotesParse';

/** The bundled notes for the installed version: one card per heading, one row per change. */
export default function WhatsNewSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const version = Constants.expoConfig?.version ?? '';
  const sections = useMemo(() => parseReleaseNotes(RELEASE_NOTES[version] ?? ''), [version]);
  return (
    <SettingsPage title={aboutExtrasCopy.releaseNotesFor(version || '—')}>
      <Stack.Screen options={{ headerShown: false }} />
      {sections.length === 0 ? (
        <Card>
          <Text style={[s.text, s.empty]}>{aboutExtrasCopy.notes.none}</Text>
        </Card>
      ) : (
        sections.map((section, si) => (
          <View key={`${si}-${section.title}`}>
            {section.title ? <SectionHeader title={section.title} /> : null}
            <Card>
              {section.items.map((item, i) => (
                <View key={i} style={[s.item, i > 0 && s.divider]}>
                  <View style={s.bullet} />
                  <Text style={s.text} selectable>
                    {item}
                  </Text>
                </View>
              ))}
            </Card>
          </View>
        ))
      )}
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    item: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    // A small square in the accent colour, in keeping with the pixel style; centred on the first line of text.
    bullet: { width: 6, height: 6, marginTop: spacing.sm, backgroundColor: c.accent },
    text: { ...type.body, flex: 1, fontSize: type.size.lg, lineHeight: 22, color: c.text },
    empty: { padding: spacing.lg },
  });
