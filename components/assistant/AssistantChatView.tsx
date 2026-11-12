import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import type { TokenKey } from '../../utils/assistant/glossary';
import type { AssistantChat, ChatGate, ChatItem, ScreenTarget } from '../../utils/assistant/runtime';
import { modelChipText, tokensLine } from '../../utils/assistant/chatView';
import { Button, EmptyBlock, Screen, Sheet } from '../ui';
import { Composer } from './Composer';
import { JargonSheet } from './JargonSheet';
import { Message } from './Message';
import { Questionnaire } from './Questionnaire';
import { routeForTarget } from '../../utils/assistant/chatView';
import { Suggestions } from './Suggestions';
import { Trace } from './Trace';
import { ProposalCard } from './ProposalCard';
import { ResultCard } from './ResultCard';
import { useChatAnnouncements } from './useChatAnnouncements';
import { useKeyboardInset } from './useKeyboardInset';

export interface AssistantChatViewProps {
  chat: AssistantChat;
  onOpenSettings(): void;
  /** Open the Add sheet for a magnet or .torrent URL. */
  onChooseFiles(source: string): void;
  /** Open a screen the Assistant offered with a link button. Defaults to router.push of routeForTarget. */
  onOpenTarget?(target: ScreenTarget): void;
}

const GATE_LINE: Record<Exclude<ChatGate, 'ready'>, string> = {
  noKey: 'Add an API key in Settings → Assistant.',
  disabled: 'The Assistant is turned off. Turn it on in Settings → Assistant.',
  notAccepted: 'Read and accept the Assistant notice in Settings → Assistant to start.',
};

/** The chat screen. Renders an AssistantChat and calls its methods; never talks to the model, the engine or search. */
export function AssistantChatView({ chat, onOpenSettings, onChooseFiles, onOpenTarget }: AssistantChatViewProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [term, setTerm] = useState<TokenKey | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const { items, gate, send } = chat;
  useChatAnnouncements(items);
  const kb = useKeyboardInset();

  // Newest first, because the list is inverted: it stays pinned to the latest message while text streams in.
  const data = useMemo(() => [...items].reverse(), [items]);

  // Re-runs the last turn without adding the user's message again.
  const retry = useCallback(() => chat.retry(), [chat]);

  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => {
      switch (item.kind) {
        case 'progress':
          return <Trace steps={item.steps} />;
        case 'results':
          return (
            <View style={styles.stack}>
              {item.results.map((r) => (
                <ResultCard
                  key={r.handle}
                  view={r}
                  canChoose={!!chat.sourceFor(r.handle)}
                  onChooseFiles={() => {
                    const src = chat.sourceFor(r.handle);
                    if (src) onChooseFiles(src);
                  }}
                  onAskAbout={() => chat.askAbout(r.handle)}
                  onChip={setTerm}
                />
              ))}
            </View>
          );
        case 'card':
          return (
            <ProposalCard
              view={item.view}
              state={item.state}
              onConfirm={() => chat.confirm(item.view.cardId)}
              onDismiss={() => chat.dismiss(item.view.cardId)}
            />
          );
        case 'question':
          return (
            <Questionnaire
              question={item.question}
              options={item.options}
              answered={item.answered}
              onAnswer={(o) => chat.answer?.(item.id, o)}
            />
          );
        case 'link':
          return (
            <View style={styles.link}>
              <Button
                label={item.label}
                variant="secondary"
                icon="chevron-right"
                fullWidth
                onPress={() => (onOpenTarget ? onOpenTarget(item.target) : router.push(routeForTarget(item.target) as never))}
              />
            </View>
          );
        default:
          return <Message item={item} onTerm={setTerm} onOpenSettings={onOpenSettings} onRetry={retry} />;
      }
    },
    [chat, onChooseFiles, onOpenSettings, onOpenTarget, retry, styles.stack, styles.link],
  );

  const clearAction =
    items.length > 0 ? (
      <Pressable
        onPress={() => (items.length > 0 ? setConfirmClear(true) : chat.clear())}
        style={styles.clear}
        accessibilityRole="button"
        accessibilityLabel="Clear chat"
      >
        <Text style={styles.clearText}>Clear</Text>
      </Pressable>
    ) : null;

  const ready = gate === 'ready';
  const gateLine = ready ? '' : GATE_LINE[gate];

  let body: React.ReactNode;
  if (!ready && items.length === 0) {
    body = (
      <EmptyBlock
        icon="assistant"
        title={gateLine}
        primary={{ label: 'Open settings', onPress: onOpenSettings }}
      />
    );
  } else if (items.length === 0) {
    body = (
      <ScrollView contentContainerStyle={styles.empty} keyboardShouldPersistTaps="handled">
        <Suggestions onPick={send} />
        <Text style={styles.privacy}>Your messages and the names of your downloads go to {chat.providerName}.</Text>
        <Text style={styles.privacy}>Chats aren't saved. Leaving Maglev or tapping Clear ends this chat.</Text>
      </ScrollView>
    );
  } else {
    body = (
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={data}
        inverted
        keyExtractor={(it) => it.id}
        renderItem={renderItem}
        ItemSeparatorComponent={Separator}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
    );
  }

  return (
    <Screen title="ASSISTANT" actions={clearAction}>
      <View ref={kb.ref} style={[styles.fill, { paddingBottom: kb.inset }]} collapsable={false}>
        {body}
        {ready ? (
          <Composer
            busy={chat.busy}
            onSend={send}
            onStop={chat.stop}
            modelText={modelChipText(chat.modelName, chat.providerName)}
            onOpenModel={onOpenSettings}
            contextText={tokensLine(chat.tokensUsed)}
          />
        ) : items.length > 0 ? (
          <View style={styles.gate}>
            <Text style={styles.gateText}>{gateLine}</Text>
            <Button label="Open settings" variant="secondary" onPress={onOpenSettings} />
          </View>
        ) : null}
      </View>
      <Sheet visible={confirmClear} onClose={() => setConfirmClear(false)} title="Clear this chat?" subtitle="Messages and cards go. Downloads stay.">
        <View style={styles.sheetActions}>
          <Button
            label="Clear"
            variant="danger"
            fullWidth
            onPress={() => {
              setConfirmClear(false);
              chat.clear();
            }}
          />
          <Button label="Cancel" variant="secondary" fullWidth onPress={() => setConfirmClear(false)} />
        </View>
      </Sheet>
      <JargonSheet termKey={term} onClose={() => setTerm(null)} />
    </Screen>
  );
}

const Separator = () => <View style={{ height: spacing.md }} />;

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    list: { flex: 1 },
    listContent: { padding: spacing.lg },
    stack: { gap: spacing.md },
    link: { alignSelf: 'stretch' },
    empty: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.lg },
    sheetActions: { gap: spacing.sm },
    privacy: { ...type.body, fontSize: type.size.md, lineHeight: 18, color: c.textMuted },
    clear: { minWidth: 56, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm },
    clearText: { ...type.bodyStrong, fontSize: 14, color: c.textMuted },
    gate: { gap: spacing.md, padding: spacing.lg, borderTopWidth: 1, borderTopColor: c.border, alignItems: 'flex-start' },
    gateText: { ...type.body, fontSize: 14, lineHeight: 20, color: c.text },
  });
