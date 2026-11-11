import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MetadataFile } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { Checkbox } from '../detail/Checkbox';

interface Props {
  file: MetadataFile;
  checked: boolean;
  onToggle: (index: number, next: boolean) => void;
}

function PreviewFileRowBase({ file, checked, onToggle }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      <Checkbox
        checked={checked}
        onChange={(next) => onToggle(file.index, next)}
        accessibilityLabel={`Include ${file.path}, ${formatBytes(file.length)}`}
      />
      <View style={styles.body}>
        <Text style={[styles.name, !checked && styles.off]} numberOfLines={2} ellipsizeMode="middle">
          {file.path}
        </Text>
        <Text style={styles.size}>{formatBytes(file.length)}</Text>
      </View>
    </View>
  );
}

export const PreviewFileRow = memo(PreviewFileRowBase);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 56,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      paddingLeft: spacing.xs,
      paddingRight: spacing.md,
    },
    body: { flex: 1, paddingVertical: spacing.sm },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
    off: { color: c.textMuted },
    size: { ...type.mono, fontSize: type.size.xs, color: c.textMuted, marginTop: 2 },
  });
