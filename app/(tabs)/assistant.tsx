import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { PixelIcon, PixelIconName } from '../../components/PixelIcon';
import { Button, Screen } from '../../components/ui';
import { AssistantChatView } from '../../components/assistant/AssistantChatView';
import type { ToolRunner } from '../../utils/assistant/runtime';
import { createAppToolRunner } from '../../utils/assistantApp/appToolRunner';
import { useAssistantChat } from '../../utils/assistantApp/useAssistantChat';
import { assistantPrefs, useAssistantPrefs } from '../../utils/prefs/assistantApp';

/** The usage notice: shown until accepted (Settings > Assistant can show it again). */
const NOTICE: { icon: PixelIconName; title: string; body: string }[] = [
  {
    icon: 'external',
    title: 'What gets sent',
    body: 'Your messages, and the torrent names, sizes and search results the Assistant looks at, go to the AI provider you choose. Your files never leave the phone.',
  },
  {
    icon: 'shield',
    title: 'Your key stays here',
    body: "Your API key is kept in this phone's secure storage and only sent to that provider.",
  },
  {
    icon: 'warning',
    title: 'It can be wrong',
    body: 'Check the name, size and source on every card before you confirm.',
  },
  {
    icon: 'check',
    title: 'Nothing happens without your tap',
    body: 'It only suggests. Adding, removing and changing anything needs you to press Confirm.',
  },
  {
    icon: 'bandwidth',
    title: 'Your provider may charge',
    body: 'Each message uses tokens on your provider account. Maglev shows the count, not the cost.',
  },
];

/** One runner for the app's lifetime: the chat controller is keyed by it, so the chat survives leaving the tab. */
let runner: ToolRunner | null = null;
const appRunner = () => (runner ??= createAppToolRunner());

export default function AssistantTab() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const prefs = useAssistantPrefs();
  const chat = useAssistantChat(appRunner());
  const openSettings = useCallback(() => router.push('/settings/assistant' as never), []);
  const chooseFiles = useCallback((source: string) => router.push({ pathname: '/add-torrent', params: { source } }), []);

  if (!prefs.warningAcceptedAt) {
    return (
      <Screen title="ASSISTANT">
        <ScrollView contentContainerStyle={styles.notice}>
          <Text style={styles.lead}>Before you start</Text>
          {NOTICE.map((n) => (
            <View key={n.title} style={styles.point}>
              <PixelIcon name={n.icon} size={20} color={colors.accentText} />
              <View style={styles.pointText}>
                <Text style={styles.pointTitle}>{n.title}</Text>
                <Text style={styles.pointBody}>{n.body}</Text>
              </View>
            </View>
          ))}
          <Text style={styles.legal}>Only download what you have the right to.</Text>
          <View style={styles.actions}>
            <Button label="I understand" fullWidth onPress={() => assistantPrefs.update({ warningAcceptedAt: Date.now() })} />
            <Button label="Not now" variant="ghost" fullWidth onPress={() => router.navigate('/')} />
          </View>
        </ScrollView>
      </Screen>
    );
  }

  return <AssistantChatView chat={chat} onOpenSettings={openSettings} onChooseFiles={chooseFiles} />;
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    notice: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl },
    lead: { ...type.heading, fontSize: type.size.xl, color: c.text },
    point: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    pointText: { flex: 1, gap: spacing.xs },
    pointTitle: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text },
    pointBody: { ...type.body, fontSize: type.size.md, color: c.textMuted, lineHeight: 19 },
    legal: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    actions: { gap: spacing.sm, marginTop: spacing.sm },
  });

export { ErrorBoundary } from '../../components/ErrorScreen';
