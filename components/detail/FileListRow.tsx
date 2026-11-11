import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DetailFile } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { fileGlyph } from '../../utils/fileKind';
import { PixelIcon } from '../PixelIcon';
import { PressableScale, ProgressBar } from '../ui';
import { Checkbox } from './Checkbox';

interface Props {
  file: DetailFile;
  /** Multi-select mode: the leading glyph becomes a checkbox and tap toggles. */
  selecting: boolean;
  selected: boolean;
  /** True for finished or playable files that have Open / Share. */
  hasActions: boolean;
  /** The torrent is paused: unfinished files show the paused colour and label. */
  paused?: boolean;
  /** SM-32: the file was deleted outside Maglev. */
  missing?: boolean;
  onPress: (file: DetailFile) => void;
  onLongPress: (file: DetailFile) => void;
  onOpenActions: (file: DetailFile) => void;
}

/**
 * One file in the Files tab. The progress bar sits on its own line across the full card width so a
 * finished file reads as 100%, with the options button above it.
 */
function FileListRowBase({ file, selecting, selected, hasActions, paused = false, missing = false, onPress, onLongPress, onOpenActions }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const skipped = file.priority === 'skip';
  const done = file.length > 0 && file.progressBytes >= file.length;
  const frac = file.length > 0 ? Math.min(1, file.progressBytes / file.length) : 0;
  const pct = Math.floor(frac * 100);
  const size = formatBytes(file.length);
  const iconColor = skipped ? colors.textFaint : done ? colors.success : paused ? colors.paused : colors.download;
  const priorityWord = file.priority === 'first' ? 'download first' : skipped ? 'skipped' : 'normal priority';

  return (
    <PressableScale
      onPress={() => onPress(file)}
      onLongPress={() => onLongPress(file)}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityLabel={`${file.path}, ${formatBytes(file.length)}, ${skipped ? 'skipped' : missing ? 'missing' : `${pct} percent`}, ${priorityWord}`}
      accessibilityHint={selecting ? undefined : 'Change priority'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      scaleTo={0.99}
      style={[styles.card, skipped && styles.cardSkipped, selected && styles.cardSelected]}
    >
      <View style={styles.top}>
        {selecting ? (
          <Checkbox checked={selected} onChange={() => onPress(file)} accessibilityLabel={`Select ${file.path}`} />
        ) : (
          <View style={styles.glyph}>
            <PixelIcon name={done && !skipped ? 'check' : fileGlyph(file.path)} size={20} color={iconColor} />
          </View>
        )}
        <View style={styles.main}>
          <Text style={[styles.name, skipped && styles.nameSkipped]} numberOfLines={1} ellipsizeMode="middle">
            {file.path}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {skipped ? (
              `Skipped · ${size}`
            ) : missing ? (
              `Missing · ${size}`
            ) : done ? (
              <>
                <Text style={styles.metaDone}>Done</Text>
                {` · ${size}`}
              </>
            ) : paused ? (
              <>
                {`${pct}% · `}
                <Text style={styles.metaPaused}>Paused</Text>
                {` · ${size}`}
              </>
            ) : (
              `${pct}% · ${size}`
            )}
          </Text>
        </View>
        {file.priority === 'first' ? (
          <View style={styles.chipFirst}>
            <PixelIcon name="priority-first" size={16} color={colors.firstFg} />
            <Text style={styles.chipFirstText}>First</Text>
          </View>
        ) : null}
        {hasActions && !selecting && !skipped ? (
          <PressableScale
            onPress={() => onOpenActions(file)}
            accessibilityRole="button"
            accessibilityLabel={`File options for ${file.path}`}
            style={styles.kebab}
          >
            <PixelIcon name="more" size={20} color={colors.textMuted} />
          </PressableScale>
        ) : null}
      </View>
      {!skipped && !done && !missing ? (
        <View style={styles.bar}>
          <ProgressBar progress={frac} tone={paused ? 'paused' : 'download'} accessibilityLabel={`${pct} percent`} />
        </View>
      ) : null}
    </PressableScale>
  );
}

export const FileListRow = memo(FileListRowBase);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.sm,
      paddingTop: spacing.xs,
      paddingBottom: spacing.sm,
    },
    cardSkipped: { backgroundColor: 'transparent', borderStyle: 'dashed', opacity: 0.6 },
    cardSelected: { borderColor: c.accent },
    top: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: touch.min },
    glyph: { width: 28, alignItems: 'center', justifyContent: 'center' },
    main: { flex: 1 },
    name: { ...type.mono, fontSize: type.size.md, color: c.text },
    nameSkipped: { color: c.textMuted },
    meta: { ...type.mono, fontSize: type.size.xs, color: c.textMuted, marginTop: 2 },
    metaDone: { color: c.success },
    metaPaused: { color: c.paused },
    chipFirst: {
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
    chipFirstText: { ...type.mono, fontSize: type.size.xs, color: c.firstFg },
    kebab: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
    bar: { paddingHorizontal: spacing.xs, paddingTop: spacing.xs },
  });
