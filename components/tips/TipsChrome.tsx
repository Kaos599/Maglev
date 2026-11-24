import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { tipsCopy } from '../../constants/tipsCopy';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import type { DeckTopic } from './tipsLogic';

/** 64 dp header: Back, the topic name with a chevron (opens the picker), the topic's tip count. */
export function TipsHeader({ topic, onBack, onOpenPicker }: { topic: DeckTopic; onBack: () => void; onOpenPicker: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={s.header}>
      <PressableScale onPress={onBack} accessibilityRole="button" accessibilityLabel="Go back" feedback="sink" style={s.back} testID="tips-back">
        <PixelIcon name="back" size={24} color={colors.text} />
      </PressableScale>
      <PressableScale
        onPress={onOpenPicker}
        accessibilityRole="button"
        accessibilityLabel={tipsCopy.topicLabel(topic.name, topic.tips.length)}
        style={s.topicButton}
        containerStyle={s.topicOuter}
        testID="tips-topic-button"
      >
        <PixelIcon name={topic.icon} size={20} color={colors.accent} />
        <Text style={s.topicName} numberOfLines={1}>
          {topic.name}
        </Text>
        <PixelIcon name="chevron-down" size={20} color={colors.textMuted} />
      </PressableScale>
      <Text style={s.count}>{tipsCopy.tipCount(topic.tips.length)}</Text>
    </View>
  );
}

/** Previous and next buttons (the way to move without swiping), the position, and one tick per card. */
export function TipsBar({
  index,
  count,
  onPrev,
  onNext,
}: {
  /** 0-based; equal to `count` on the end card. */
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const atEnd = index >= count;
  const ticks = Array.from({ length: count }, (_, i) => i);
  return (
    <View style={s.bar}>
      <PressableScale
        onPress={onPrev}
        disabled={index === 0}
        accessibilityRole="button"
        accessibilityLabel={tipsCopy.prev}
        accessibilityState={{ disabled: index === 0 }}
        style={[s.nav, index === 0 && s.navOff]}
        testID="tips-prev"
      >
        <PixelIcon name="back" size={24} color={colors.text} />
      </PressableScale>
      <View style={s.position}>
        <Text style={s.counter} accessibilityLiveRegion="polite">
          {atEnd ? tipsCopy.done : tipsCopy.position(index + 1, count)}
        </Text>
        <View style={s.ticks} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {ticks.map((i) => (
            <View key={i} style={[s.tick, { backgroundColor: atEnd || i < index ? colors.textMuted : i === index ? colors.accent : colors.borderStrong }]} />
          ))}
        </View>
      </View>
      <PressableScale
        onPress={onNext}
        disabled={atEnd}
        accessibilityRole="button"
        accessibilityLabel={tipsCopy.next}
        accessibilityState={{ disabled: atEnd }}
        style={[s.nav, atEnd && s.navOff]}
        testID="tips-next"
      >
        <PixelIcon name="forward" size={24} color={colors.text} />
      </PressableScale>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    header: {
      height: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingLeft: spacing.xs,
      paddingRight: spacing.lg,
      backgroundColor: c.bg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    back: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    topicOuter: { flexShrink: 1 },
    topicButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md },
    topicName: { ...type.heading, fontSize: 20, color: c.text, flexShrink: 1 }, // design-exception: the contract sets the topic title at 20, between the 17 and 22 steps
    count: { ...type.mono, fontSize: type.size.md, color: c.textMuted, marginLeft: 'auto' },
    bar: { height: 88, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg },
    nav: {
      width: touch.min + 4,
      height: touch.min + 4,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    navOff: { opacity: 0.35 },
    position: { alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
    counter: { ...type.mono, fontSize: type.size.md, color: c.text },
    ticks: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.xs, maxWidth: 200 },
    tick: { width: 8, height: 8 },
  });
