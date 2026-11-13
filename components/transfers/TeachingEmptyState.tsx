import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { Button } from '../ui';
import { empty } from '../../constants/copy';

export interface TeachingEmptyStateProps {
  /** Paste link is enabled only when the clipboard holds a link, magnet or .torrent link. */
  canPaste: boolean;
  /** Opens the add screen with an empty field. The main button. */
  onType: () => void;
  onPaste: () => void;
  onOpenFile: () => void;
  /** Opens Search. The quiet "Search" button shows only when this is given. */
  onSearch?: () => void;
  /** Opens the in-app Browser. The quiet "Browser" button shows only when this is given. */
  onBrowse?: () => void;
}

/** Shown when there are no transfers. Teaches the ways to add one: paste a link, open a file, or find something. */
export function TeachingEmptyState({ canPaste, onType, onPaste, onOpenFile, onSearch, onBrowse }: TeachingEmptyStateProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.root} testID="transfers-empty">
      <View style={styles.tile}>
        <PixelIcon name="transfers" size={24} color={colors.textMuted} />
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {empty.transfers.none.title}
      </Text>
      <Text style={styles.body}>{empty.transfers.none.body}</Text>
      <View style={styles.actions}>
        <Button label="Type a link" icon="link" onPress={onType} />
        <Button label="Paste link" icon="clipboard" variant="secondary" disabled={!canPaste} onPress={onPaste} />
        {canPaste ? null : <Text style={styles.hint}>Copy a link first to paste it.</Text>}
        <Button label="Open file" icon="file" variant="secondary" onPress={onOpenFile} />
      </View>
      {onSearch || onBrowse ? (
        <View style={styles.finders}>
          {onSearch ? <Button label="Search" icon="search" variant="ghost" onPress={onSearch} /> : null}
          {onBrowse ? <Button label="Browser" icon="network" variant="ghost" onPress={onBrowse} /> : null}
        </View>
      ) : null}
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
    hint: { ...type.body, fontSize: 12, lineHeight: 16, color: c.textMuted, textAlign: 'center' },
    finders: { marginTop: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    actions: { marginTop: spacing.xl, alignItems: 'center', gap: spacing.sm },
  });
