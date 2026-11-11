import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { FilePriority } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { PixelIcon } from '../PixelIcon';
import { Banner, Button, RadioCard, Sheet } from '../ui';

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Current priority, or null when several files with different priorities are selected. */
  current: FilePriority | null;
  onSelect: (priority: FilePriority) => void;
  error?: string | null;
  /** Total size of the file(s) that Skip would not download, in bytes. Omit when unknown. */
  skipBytes?: number;
  /** Free space on the download volume in bytes, from getFreeSpace(). Omit when unknown. */
  freeBytes?: number;
  /** Shows a danger "Remove file" row below the cards (single file only). The caller confirms. */
  onRemove?: () => void;
}

/**
 * Option-card sheet for file priority (UI_SPEC S11.2). "Download first" reorders downloading; it
 * does not change bandwidth, so the copy never says "faster".
 */
export function PrioritySheet({ visible, onClose, title, subtitle, current, onSelect, error, skipBytes, freeBytes, onRemove }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const hasSize = typeof skipBytes === 'number' && Number.isFinite(skipBytes) && skipBytes > 0;
  const hasFree = typeof freeBytes === 'number' && Number.isFinite(freeBytes) && freeBytes >= 0;
  const skipDesc = !hasSize
    ? 'Not downloaded.'
    : hasFree
      ? `Not downloaded. Saves ${formatBytes(skipBytes as number)}, leaves ${formatBytes(freeBytes as number)} free.`
      : `Not downloaded. Saves ${formatBytes(skipBytes as number)}.`;

  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle={subtitle}>
      {error ? <Banner tone="warning" title={error} /> : null}
      <View style={styles.cards} accessibilityRole="radiogroup">
        <RadioCard
          title="Download first"
          description="Fetched before the other files. Same speed, earlier turn."
          icon="priority-first"
          iconColor={colors.accentText}
          titleAccessory={
            <View style={styles.chip}>
              <PixelIcon name="priority-first" size={16} color={colors.firstFg} />
              <Text style={styles.chipText}>First</Text>
            </View>
          }
          selected={current === 'first'}
          onPress={() => onSelect('first')}
        />
        <RadioCard
          title="Normal"
          description="In torrent order with the rest."
          icon="file"
          selected={current === 'normal'}
          onPress={() => onSelect('normal')}
        />
        <RadioCard
          title="Skip"
          description={skipDesc}
          icon="file"
          iconColor={colors.textFaint}
          dashed
          selected={current === 'skip'}
          onPress={() => onSelect('skip')}
        />
      </View>
      {onRemove ? (
        <View style={styles.remove}>
          <Button label="Remove file" icon="trash" variant="danger" fullWidth onPress={onRemove} />
        </View>
      ) : null}
      <Text style={styles.foot}>Changes apply at once. You can change it again any time.</Text>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    cards: { gap: spacing.sm },
    remove: { marginTop: spacing.md },
    foot: { ...type.body, fontSize: type.size.sm, lineHeight: 18, color: c.textMuted, marginTop: spacing.md },
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
