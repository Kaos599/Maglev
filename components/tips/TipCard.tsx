import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { tipsCopy, type Tip } from '../../constants/tipsCopy';
import { PixelIcon } from '../PixelIcon';
import { Button } from '../ui';
import type { DeckTopic } from './tipsLogic';

/** The picture area is shorter on small phones so the text and the button always fit. */
function usePictureHeight(): number {
  const { height } = useWindowDimensions();
  return Math.round(Math.min(240, Math.max(140, height * 0.26)));
}

function Picture({ children, height }: { children: React.ReactNode; height: number }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return <View style={[s.picture, { height }]}>{children}</View>;
}

/** One tip: picture, topic, title, two lines, where it lives, one action. */
export function TipCard({ tip, topic, onAction }: { tip: Tip; topic: DeckTopic; onAction: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const pictureHeight = usePictureHeight();
  const explains = !!tip.action.steps;
  return (
    <View style={s.card}>
      <Picture height={pictureHeight}>
        <View style={s.tile}>
          <PixelIcon name={tip.icon} size={48} color={colors.accent} />
        </View>
      </Picture>
      <ScrollView style={s.textArea} contentContainerStyle={s.text} showsVerticalScrollIndicator={false}>
        <Text style={s.topic}>{topic.name}</Text>
        <Text style={s.title} accessibilityRole="header">
          {tip.title}
        </Text>
        <Text style={s.body}>{tip.body}</Text>
        <Text style={s.where}>{`${tipsCopy.whereLabel}: ${tip.where}`}</Text>
      </ScrollView>
      <View style={s.actionBar}>
        <Button label={tip.action.label} variant={explains ? 'secondary' : 'primary'} size="lg" fullWidth onPress={onAction} testID="tip-action" />
      </View>
    </View>
  );
}

/** After the last tip of a topic: the next topic is the main button. */
export function EndCard({
  topic,
  next,
  onNext,
  onPick,
}: {
  topic: DeckTopic;
  next: DeckTopic;
  onNext: () => void;
  onPick: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const pictureHeight = usePictureHeight();
  const n = topic.tips.length;
  return (
    <View style={s.card} testID="tips-end">
      <Picture height={pictureHeight}>
        <View style={s.ticks} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {topic.tips.map((t) => (
            <View key={t.id} style={s.endTick} />
          ))}
        </View>
        <Text style={s.endCount}>{tipsCopy.tipCount(n)}</Text>
      </Picture>
      <View style={[s.textArea, s.text]}>
        <Text style={s.title} accessibilityRole="header">
          {tipsCopy.endTitle(topic.name)}
        </Text>
        <Text style={s.body}>{tipsCopy.endBody(next.tips.length, next.name)}</Text>
      </View>
      <View style={s.actionBar}>
        <Button label={tipsCopy.endNext(next.name)} size="lg" fullWidth onPress={onNext} testID="tips-next-topic" />
        <Button label={tipsCopy.pickTopic} variant="secondary" fullWidth onPress={onPick} testID="tips-pick-topic" />
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      flex: 1,
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
    },
    picture: {
      backgroundColor: c.bg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.lg,
    },
    tile: {
      width: 96,
      height: 96,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    textArea: { flex: 1 },
    text: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, gap: spacing.sm },
    topic: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    title: { ...type.heading, fontSize: type.size.xxl, lineHeight: 28, color: c.text },
    body: { ...type.body, fontSize: type.size.lg, lineHeight: 22, color: c.textMuted },
    where: { ...type.mono, fontSize: type.size.sm, lineHeight: 18, color: c.textMuted, marginTop: spacing.sm },
    actionBar: { padding: spacing.lg, gap: spacing.sm },
    ticks: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 5, maxWidth: 260 }, // design-exception: pixel ticks sit on a 5 px grid, like the bar ticks
    endTick: { width: 14, height: 14, backgroundColor: c.accent },
    endCount: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
  });
