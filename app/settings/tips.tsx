import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { spacing } from '../../constants/theme';
import type { Tip, TipAction, TipTopicId } from '../../constants/tipsCopy';
import { EndCard, TipCard } from '../../components/tips/TipCard';
import { SwipeDeck } from '../../components/tips/SwipeDeck';
import { StepsSheet, TopicPicker } from '../../components/tips/TipsSheets';
import { TipsBar, TipsHeader } from '../../components/tips/TipsChrome';
import { deckTopics, isTopicId, nextTopic, readPosition, savePosition } from '../../components/tips/tipsLogic';

/** Tabs are switched to, not pushed. Everything else opens on top of this screen. */
const TAB_ROUTES = new Set(['/', '/browse', '/search', '/feeds']);

/** Settings › Tips: one tip at a time, by topic. Swipe or use the arrows; the topic name opens the picker. */
export default function TipsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { topic: topicParam } = useLocalSearchParams<{ topic?: string }>();
  const topics = useMemo(() => deckTopics(), []);

  const start = useMemo(() => {
    const saved = readPosition();
    const asked = isTopicId(topicParam) && topics.some((t) => t.id === topicParam) ? topicParam : null;
    const id = asked ?? (saved && topics.some((t) => t.id === saved.topic) ? saved.topic : topics[0].id);
    const tips = topics.find((t) => t.id === id)?.tips.length ?? 1;
    const index = !asked && saved?.topic === id ? Math.min(saved.index, tips - 1) : 0;
    return { id, index };
    // The first render decides; later changes to the param are ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [topicId, setTopicId] = useState<TipTopicId>(start.id);
  const [index, setIndex] = useState(start.index);
  const [picker, setPicker] = useState(false);
  const [stepsTip, setStepsTip] = useState<Tip | null>(null);

  const topic = topics.find((t) => t.id === topicId) ?? topics[0];
  const count = topic.tips.length;
  const atEnd = index >= count;
  const next = nextTopic(topics, topic.id);

  useEffect(() => {
    savePosition({ topic: topic.id, index: Math.min(index, count - 1) });
  }, [topic.id, index, count]);

  const move = useCallback((d: 1 | -1) => setIndex((i) => Math.max(0, Math.min(count, i + d))), [count]);
  const pickTopic = useCallback((id: TipTopicId) => {
    setTopicId(id);
    setIndex(0);
    setPicker(false);
  }, []);

  const open = useCallback(
    (a: TipAction) => {
      if (!a.route) return;
      if (TAB_ROUTES.has(a.route)) router.navigate(a.route as never);
      else router.push((a.focus ? { pathname: a.route, params: { focus: a.focus } } : a.route) as never);
    },
    [router],
  );

  const tip = atEnd ? null : topic.tips[index];
  const onAction = useCallback(() => {
    if (!tip) return;
    if (tip.action.steps) setStepsTip(tip);
    else open(tip.action);
  }, [tip, open]);

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.bg }]} edges={['top', 'left', 'right', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <TipsHeader topic={topic} onBack={() => router.back()} onOpenPicker={() => setPicker(true)} />
      <View style={styles.body}>
        <SwipeDeck index={index} last={count} onMove={move}>
          {tip ? (
            <TipCard key={tip.id} tip={tip} topic={topic} onAction={onAction} />
          ) : (
            <EndCard key="end" topic={topic} next={next} onNext={() => pickTopic(next.id)} onPick={() => setPicker(true)} />
          )}
        </SwipeDeck>
      </View>
      <TipsBar index={index} count={count} onPrev={() => move(-1)} onNext={() => move(1)} />
      <TopicPicker visible={picker} topics={topics} current={topic.id} onPick={pickTopic} onClose={() => setPicker(false)} />
      <StepsSheet
        tip={stepsTip}
        onClose={() => setStepsTip(null)}
        onOpen={() => {
          const a = stepsTip?.action;
          setStepsTip(null);
          if (a) open(a);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // 24 dp between the header and the card.
  body: { flex: 1, paddingTop: spacing.xxl, paddingHorizontal: spacing.lg },
});

export { ErrorBoundary } from '../../components/ErrorScreen';
