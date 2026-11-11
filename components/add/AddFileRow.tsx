import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { MetadataFile } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { fileGlyph } from '../../utils/fileKind';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { Checkbox } from '../detail/Checkbox';

interface Props {
  file: MetadataFile;
  checked: boolean;
  /** "Download first" priority. */
  first: boolean;
  onToggle: (index: number, next: boolean) => void;
  /** Long-press opens the priority sheet (UI_SPEC S9.3). */
  onLongPress: (index: number) => void;
}

function AddFileRowBase({ file, checked, first, onToggle, onLongPress }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.row, !checked && styles.rowSkipped]}>
      <Checkbox
        checked={checked}
        onChange={(next) => onToggle(file.index, next)}
        accessibilityLabel={`Include ${file.path}, ${formatBytes(file.length)}`}
      />
      <PressableScale
        style={styles.press}
        scaleTo={0.99}
        onPress={() => onToggle(file.index, !checked)}
        onLongPress={() => onLongPress(file.index)}
        accessibilityRole="button"
        accessibilityLabel={`${file.path}, ${formatBytes(file.length)}`}
        accessibilityHint="Press and hold to change priority"
      >
        <PixelIcon name={fileGlyph(file.path)} size={20} color={checked ? colors.textMuted : colors.textFaint} />
        <View style={styles.body}>
          <Text style={[styles.name, !checked && styles.off]} numberOfLines={1} ellipsizeMode="middle">
            {file.path}
          </Text>
          <Text style={styles.size}>{checked ? formatBytes(file.length) : `Skipped · ${formatBytes(file.length)}`}</Text>
        </View>
        {first && checked ? (
          <View style={styles.chip}>
            <PixelIcon name="priority-first" size={16} color={colors.firstFg} />
            <Text style={styles.chipText}>First</Text>
          </View>
        ) : null}
      </PressableScale>
    </View>
  );
}

export const AddFileRow = memo(AddFileRowBase);

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
    },
    rowSkipped: { backgroundColor: 'transparent', borderStyle: 'dashed', opacity: 0.6 },
    press: {
      flex: 1,
      minHeight: touch.min,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingRight: spacing.md,
      paddingVertical: spacing.sm,
    },
    body: { flex: 1 },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
    off: { color: c.textMuted },
    size: { ...type.mono, fontSize: type.size.xs, color: c.textMuted, marginTop: 2 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderWidth: 1,
      borderColor: c.firstBorder,
      backgroundColor: c.firstBg,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    chipText: { ...type.mono, fontSize: type.size.xs, color: c.firstFg },
  });
