import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ActiveBlock } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { useMinuteTick } from '../../utils/blocks/useMinuteTick';
import { reasonsForItem, type HeldItem } from '../../utils/blocks/reasons';
import { Button } from '../ui';

export interface WhyHeldProps {
  item: HeldItem;
  blocks: readonly ActiveBlock[];
  queueLimit?: number;
  /** Runs before a setting button navigates, for example to close the sheet it sits in. */
  onNavigate?: () => void;
}

/** "Why it's paused": every rule that holds this item, each with the setting that changes it (NATIVE_CONTRACT 35.4). */
export function WhyHeld({ item, blocks, queueLimit, onNavigate }: WhyHeldProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const now = useMinuteTick(blocks.some((b) => b.tag === 'schedule'));
  const reasons = useMemo(() => reasonsForItem(item, blocks, queueLimit, now), [item, blocks, queueLimit, now]);
  if (reasons.length === 0) return null;
  return (
    <View style={styles.wrap} testID="why-held">
      <Text style={styles.heading} accessibilityRole="header">
        Why it's paused
      </Text>
      {reasons.map((r) => (
        <View key={r.key} style={styles.item}>
          <Text style={styles.title}>{r.title}</Text>
          <Text style={styles.body}>{r.body}</Text>
          {r.setting ? (
            <View style={styles.action}>
              <Button
                label={r.setting.label}
                variant="secondary"
                onPress={() => {
                  onNavigate?.();
                  router.push(r.setting!.route as never);
                }}
              />
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { gap: spacing.md },
    heading: { ...type.heading, fontSize: type.size.xl, color: c.text },
    item: { gap: 2 },
    title: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    body: { ...type.body, fontSize: type.size.md, color: c.textMuted, lineHeight: 18 },
    action: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  });
