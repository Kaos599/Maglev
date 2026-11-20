import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { clipboardCopy, clipboardLabel } from '../../constants/clipboardCopy';
import { Button } from '../ui';

export interface ClipboardChipProps {
  /** The copied text. Its host, file name or magnet name is shown under the title. */
  link?: string;
  onAdd: () => void;
  onDismiss: () => void;
}

/** "Download the copied link?" prompt card on Transfers. */
export function ClipboardChip({ link, onAdd, onDismiss }: ClipboardChipProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap}>
      <View style={styles.card} accessibilityRole="alert">
        <Text style={styles.title}>{clipboardCopy.title}</Text>
        <Text style={styles.name} numberOfLines={1}>
          {clipboardLabel(link ?? "")}
        </Text>
        <View style={styles.actions}>
          <View style={styles.action}>
            <Button label={clipboardCopy.download} fullWidth onPress={onAdd} />
          </View>
          <View style={styles.action}>
            <Button label={clipboardCopy.notNow} variant="secondary" fullWidth onPress={onDismiss} />
          </View>
        </View>
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    card: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    title: { ...type.heading, fontSize: type.size.md, color: c.text },
    name: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
    action: { flex: 1 },
  });
