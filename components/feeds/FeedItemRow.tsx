import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { relativeTime } from '../../utils/feeds';
import { IconButton } from '../ui';

export interface FeedItemRowProps {
  title: string;
  feedName: string;
  sizeBytes: number | null;
  publishedAt: number | null;
  hasSource: boolean;
  added: boolean;
  busy?: boolean;
  onAdd: () => void;
  /** Not seen yet: stays marked until the user acts on it or taps Mark all seen. */
  isNew?: boolean;
}

function FeedItemRowImpl({ title, feedName, sizeBytes, publishedAt, hasSource, added, busy, onAdd, isNew }: FeedItemRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meta = [sizeBytes ? formatBytes(sizeBytes) : null, relativeTime(publishedAt) || null, feedName]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {isNew ? <Text style={styles.newTag}>New</Text> : null}
        <Text style={styles.meta} numberOfLines={1}>
          {hasSource ? meta : `${meta} · No torrent link`}
        </Text>
      </View>
      {added ? (
        <IconButton icon="check" color={colors.success} accessibilityLabel={`${title}, added`} disabled />
      ) : (
        <IconButton
          icon="download"
          color={colors.accentText}
          accessibilityLabel={hasSource ? `Add ${title}` : `${title}, no torrent link`}
          onPress={onAdd}
          disabled={!hasSource || busy}
        />
      )}
    </View>
  );
}

export const FeedItemRow = memo(FeedItemRowImpl);

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
    text: { flex: 1, gap: spacing.xs },
    title: { ...type.bodyStrong, fontSize: 14, lineHeight: 19, color: c.text },
    newTag: { ...type.bodyStrong, fontSize: 11, color: c.accentText },
    meta: { ...type.body, fontSize: 12, color: c.textMuted },
  });
