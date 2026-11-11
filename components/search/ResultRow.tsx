import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { PixelIcon } from '../PixelIcon';
import { IconButton } from '../ui';

export interface ResultRowProps {
  name: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  added: boolean;
  busy?: boolean;
  onAdd: () => void;
}

function ResultRowImpl({ name, sizeBytes, seeds, peers, added, busy, onAdd }: ResultRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={2}>
          {name}
        </Text>
        <View style={styles.meta} accessible accessibilityLabel={`${formatBytes(sizeBytes)}, ${seeds} seeds, ${peers} peers`}>
          <Text style={styles.metaText}>{formatBytes(sizeBytes)}</Text>
          <View style={styles.stat}>
            <PixelIcon name="upload" size={16} color={colors.upload} />
            <Text style={styles.metaText}>{seeds}</Text>
          </View>
          <View style={styles.stat}>
            <PixelIcon name="peers" size={16} color={colors.textMuted} />
            <Text style={styles.metaText}>{peers}</Text>
          </View>
        </View>
      </View>
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
    text: { flex: 1, gap: spacing.xs },
    name: { ...type.mono, fontSize: 13, lineHeight: 18, color: c.text },
    meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    stat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    metaText: { ...type.mono, fontSize: 12, color: c.textMuted },
  });
