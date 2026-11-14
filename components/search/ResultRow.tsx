import React, { memo, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { MEDIA_WORD, mediaKind, type MediaKind } from '../../utils/search/mediaType';
import { IconButton } from '../ui';
import { useSearchPrefs } from '../../utils/prefs/search';
import { isLowShare, sharingBadge } from './sharing';

export interface ResultRowProps {
  name: string;
  /** The search category the result came from, when known. */
  category?: string;
  sizeBytes?: number;
  /** undefined = the source gives no counts; shown as a dash. */
  seeders?: number;
  leechers?: number;
  /** Age written out, e.g. "3 months ago". Empty when unknown. */
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

const KIND_ICON: Record<MediaKind, PixelIconName> = {
  video: 'file-video',
  audio: 'file-audio',
  book: 'file-doc',
  app: 'file-app',
  game: 'file-disc',
  archive: 'file-archive',
  image: 'file-image',
  unknown: 'file',
};

function ResultRowImpl({ name, category, sizeBytes, seeders, leechers, age, via, risky, added, busy, onAdd, onOpen, onFollow }: ResultRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [{ resultNameLines }] = useSearchPrefs();
  const size = sizeBytes ? formatBytes(sizeBytes) : '—';
  const kind = mediaKind({ name, category });
  const seedWords = seeders === undefined ? 'seeders unknown' : `${seeders.toLocaleString('en-US')} seeding`;
  const leechWords = leechers === undefined ? 'downloaders unknown' : `${leechers.toLocaleString('en-US')} downloading`;
  const label = `${MEDIA_WORD[kind]}, ${size}, ${seedWords}, ${leechWords}${age ? `, uploaded ${age}` : ''}, via ${via}`;
  const badge = sharingBadge(seeders);
  return (
    <View style={[styles.row, isLowShare(seeders) && !added && styles.dim]}>
      <Pressable style={styles.main} onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${name}. ${label}. Show details`}>
        <View style={styles.tile} importantForAccessibility="no-hide-descendants">
          <PixelIcon name={KIND_ICON[kind]} size={20} color={colors.text} />
        </View>
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={resultNameLines === 0 ? undefined : resultNameLines}>
            {name}
          </Text>
          <View style={styles.meta}>
            <Text style={styles.metaText}>{size}</Text>
            <View style={styles.stat}>
              <PixelIcon name="upload" size={16} color={colors.accentText} />
              <Text style={styles.metaText}>{count(seeders)}</Text>
            </View>
            <View style={styles.stat}>
              <PixelIcon name="download" size={16} color={colors.textMuted} />
              <Text style={styles.metaText}>{count(leechers)}</Text>
            </View>
          </View>
          <View style={styles.meta}>
            {age ? (
              <View style={styles.stat}>
                <PixelIcon name="clock" size={16} color={colors.textMuted} />
                <Text style={styles.age}>{age}</Text>
              </View>
            ) : null}
            <Text style={[styles.age, styles.via]} numberOfLines={1}>
              {age ? '· ' : ''}
              {via}
            </Text>
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
        </View>
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
      paddingLeft: spacing.md,
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
    main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
    tile: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
    },
    text: { flex: 1, gap: spacing.xs, justifyContent: 'center' },
    name: { ...type.mono, fontSize: 13, lineHeight: 18, color: c.text },
    meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    metaText: { ...type.mono, fontSize: 12, color: c.textMuted },
    age: { ...type.body, fontVariant: ['tabular-nums'], fontSize: 11, color: c.textMuted },
    via: { flexShrink: 1 },
    risk: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    riskText: { ...type.body, fontSize: 12, color: c.warning, flexShrink: 1 },
  });
