import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, touch, type } from '../../constants/theme';
import { tipsCopy, type Tip, type TipTopicId } from '../../constants/tipsCopy';
import { PixelIcon } from '../PixelIcon';
import { Button, PressableScale, Sheet } from '../ui';
import type { DeckTopic } from './tipsLogic';

/** Every topic with its icon and tip count. The current one is marked. */
export function TopicPicker({
  visible,
  topics,
  current,
  onPick,
  onClose,
}: {
  visible: boolean;
  topics: readonly DeckTopic[];
  current: TipTopicId;
  onPick: (id: TipTopicId) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const total = topics.reduce((sum, t) => sum + t.tips.length, 0);
  return (
    <Sheet visible={visible} onClose={onClose} title={tipsCopy.topicsTitle} subtitle={tipsCopy.tipCount(total)} testID="tips-topics">
      <ScrollView style={s.list} contentContainerStyle={s.listContent}>
        {topics.map((t) => {
          const on = t.id === current;
          return (
            <PressableScale
              key={t.id}
              onPress={() => onPick(t.id)}
              accessibilityRole="button"
              accessibilityLabel={`${t.name}, ${tipsCopy.tipCount(t.tips.length)}`}
              accessibilityState={{ selected: on }}
              style={[s.topicRow, on && s.topicRowOn]}
            >
              <PixelIcon name={t.icon} size={24} color={on ? colors.accent : colors.textMuted} />
              <Text style={s.topicName}>{t.name}</Text>
              <Text style={s.topicCount}>{t.tips.length}</Text>
            </PressableScale>
          );
        })}
      </ScrollView>
    </Sheet>
  );
}

/** The numbered steps for a card that explains something outside Maglev. */
export function StepsSheet({
  tip,
  onClose,
  onOpen,
}: {
  tip: Tip | null;
  onClose: () => void;
  onOpen: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  // Keep the last tip's text while the sheet slides out.
  const last = React.useRef<Tip | null>(null);
  if (tip) last.current = tip;
  const shown = tip ?? last.current;
  const steps = shown?.action.steps ?? [];
  return (
    <Sheet visible={tip != null} onClose={onClose} title={shown?.title ?? ''} testID="tips-steps">
      <ScrollView style={s.list} contentContainerStyle={s.stepsContent}>
        {steps.map((text, i) => (
          <View key={text} style={s.step}>
            <View style={s.stepNumber}>
              <Text style={s.stepNumberText}>{i + 1}</Text>
            </View>
            <Text style={s.stepText}>{text}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={s.stepsActions}>
        {shown?.action.route ? <Button label={shown.action.routeLabel ?? shown.action.label} onPress={onOpen} /> : null}
        <Button label="Got it" variant={shown?.action.route ? 'ghost' : 'primary'} onPress={onClose} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    list: { flexGrow: 0 },
    listContent: { gap: spacing.xs },
    topicRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 52,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    topicRowOn: { borderColor: c.accent, backgroundColor: alpha(c.accent, 0.08) },
    topicName: { ...type.bodyStrong, fontSize: type.size.xl, color: c.text, flex: 1 },
    topicCount: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
    stepsContent: { gap: spacing.md },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    stepNumber: {
      width: 28,
      height: 28,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.borderStrong,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNumberText: { ...type.monoBold, fontSize: type.size.md, color: c.accentText },
    stepText: { ...type.body, fontSize: type.size.lg, lineHeight: 22, color: c.text, flex: 1, paddingTop: spacing.xs },
    stepsActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg, minHeight: touch.min },
  });
