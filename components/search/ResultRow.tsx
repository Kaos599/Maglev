import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { PixelIcon } from '../PixelIcon';
import { IconButton } from '../ui';
import { isLowShare, sharingBadge, sharingWords } from './sharing';

export interface ResultRowProps {
  name: string;
  sizeBytes?: number;
  /** undefined = the source gives no counts; shown as a dash. */
  seeders?: number;
  leechers?: number;
  age: string;
  via: string;
  /** Names of the flagged sources when every source is known for fake or harmful uploads. */
  risky?: string[] | null;
  added: boolean;
  busy?: boolean;
  onAdd: () => void;
  /** Tapping the row opens the preview. */
  onOpen: () => void;
  /** Set only for TV and anime episodes or season packs. */
  onFollow?: () => void;
}

const count = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('en-US'));

function ResultRowImpl({ name, sizeBytes, seeders, leechers, age, via, risky, added, busy, onAdd, onOpen, onFollow }: ResultRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const size = sizeBytes ? formatBytes(sizeBytes) : '—';
  const label = `${size}, ${sharingWords(seeders, leechers)}${age ? `, ${age} old` : ''}, via ${via}`;
  const badge = sharingBadge(seeders);
  return (
    <View style={[styles.row, isLowShare(seeders) && !added && styles.dim]}>
      <Pressable style={styles.text} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${name}. ${label}. Show details`}>
        <Text style={styles.name} numberOfLines={2}>
          {name}
        </Text>
        <View style={styles.meta}>
          <View style={styles.stat}>
            <PixelIcon name="storage" size={16} color={colors.textMuted} />
            <Text style={styles.metaText}>{size}</Text>
          </View>
          <View style={styles.stat}>
            <PixelIcon name="upload" size={16} color={colors.upload} />
            <Text style={styles.metaText}>{count(seeders)}</Text>
          </View>
          <View style={styles.stat}>
            <PixelIcon name="peers" size={16} color={colors.textMuted} />
            <Text style={styles.metaText}>{count(leechers)}</Text>
          </View>
          {age ? <Text style={styles.age}>{age}</Text> : null}
        </View>
        {badge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge}</Text>
          </View>
        ) : null}
        {risky ? (
          <View style={styles.risk} accessible accessibilityLabel={`Risky source: ${risky.join(', ')}`}>
            <PixelIcon name="warning" size={16} color={colors.warning} />
            <Text style={styles.riskText} numberOfLines={1}>
              Risky source: {risky.join(', ')}
            </Text>
          </View>
        ) : null}
        <Text style={styles.via} numberOfLines={1}>
          via {via}
        </Text>
      </Pressable>
      {onFollow ? <IconButton icon="bell" color={colors.textMuted} accessibilityLabel={`Follow ${name}`} onPress={onFollow} /> : null}
      {added ? (
        <IconButton icon="check" color={colors.success} accessibilityLabel={`${name}, added`} disabled />
      ) : (
        <IconButton icon="download" color={colors.accentText} accessibilityLabel={`Add ${name}`} onPress={onAdd} disabled={busy} />
      )}
    </View>
  );
}

export const ResultRow = memo(ResultRowImpl);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 72,
      paddingVertical: spacing.md,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      marginBottom: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    dim: { opacity: 0.6 },
    badge: { alignSelf: 'flex-start', paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border },
    badgeText: { ...type.body, fontSize: 11, color: c.textMuted },
    text: { flex: 1, gap: spacing.xs, minHeight: 44, justifyContent: 'center' },
    name: { ...type.mono, fontSize: 13, lineHeight: 18, color: c.text },
    meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
    stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    metaText: { ...type.mono, fontSize: 12, color: c.textMuted },
    age: { ...type.body, fontSize: 12, color: c.textMuted },
    risk: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    riskText: { ...type.body, fontSize: 12, color: c.warning, flexShrink: 1 },
    via: { ...type.body, fontSize: 11, color: c.textMuted },
  });
