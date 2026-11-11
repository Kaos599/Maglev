import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { Button } from '../ui';

export interface TeachingEmptyStateProps {
  /** Paste link is enabled only when the clipboard holds a magnet or .torrent link. */
  canPaste: boolean;
  onPaste: () => void;
  onOpenFile: () => void;
}

/** Shown when there are no transfers. Teaches the two ways to add one. */
export function TeachingEmptyState({ canPaste, onPaste, onOpenFile }: TeachingEmptyStateProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.root} testID="transfers-empty">
      <View style={styles.tile}>
        <PixelIcon name="transfers" size={24} color={colors.textMuted} />
      </View>
      <Text style={styles.title} accessibilityRole="header">
        Paste a magnet link or open a .torrent file
      </Text>
      <Text style={styles.body}>Links you tap in your browser open here too.</Text>
      <View style={styles.actions}>
        <Button label="Paste link" icon="clipboard" disabled={!canPaste} onPress={onPaste} />
        <Button label="Open file" icon="file" variant="secondary" onPress={onOpenFile} />
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl, paddingVertical: spacing.xxxl },
    tile: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: c.surfaceRaised,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { ...type.bodyStrong, fontSize: 17, color: c.text, marginTop: spacing.lg, textAlign: 'center' },
    body: { ...type.body, fontSize: 13, lineHeight: 19, color: c.textMuted, marginTop: spacing.sm, textAlign: 'center', maxWidth: 300 },
    actions: { marginTop: spacing.xl, alignItems: 'center', gap: spacing.sm },
  });
