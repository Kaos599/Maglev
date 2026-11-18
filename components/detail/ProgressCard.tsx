import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { ProgressBar, type ProgressTone } from '../ui';

/** A state badge in a tint: the same box as the torrent page's StateBadge. */
export function ProgressBadge({ label, tint }: { label: string; tint: string }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.badge, { borderColor: tint, backgroundColor: alpha(tint, 0.12) }]}>
      <Text style={[styles.badgeText, { color: tint }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export interface ProgressCardProps {
  badge: React.ReactNode;
  percent: string;
  /** Read instead of the percent text. */
  percentLabel?: string;
  progress: number;
  tone: ProgressTone;
  barLabel: string;
  /** When set, the whole card reads as this one label. */
  accessibilityLabel?: string;
  /** Under the bar: the Compact line, or the torrent's limit row. */
  children?: React.ReactNode;
}

/** The progress card both transfer pages (and the previews in the Download page sheet) draw: badge and percent, the bar, then what is under it. */
export function ProgressCard({ badge, percent, percentLabel, progress, tone, barLabel, accessibilityLabel, children }: ProgressCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.summary} accessible={accessibilityLabel ? true : undefined} accessibilityLabel={accessibilityLabel}>
      <View style={styles.summaryTop}>
        {badge}
        <Text style={styles.percent} accessibilityLabel={percentLabel}>
          {percent}
        </Text>
      </View>
      <ProgressBar progress={progress} tone={tone} accessibilityLabel={barLabel} />
      {children}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    summary: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
      marginBottom: spacing.md,
      gap: spacing.md,
    },
    summaryTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
    badge: { flexShrink: 1, alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1 },
    badgeText: { ...type.bodyStrong, fontSize: type.size.sm },
    percent: { ...type.monoBold, fontSize: type.size.xxl, color: c.text },
  });
