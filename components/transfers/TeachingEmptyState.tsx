import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, touch, type } from '../../constants/theme';
import { PixelIcon, type PixelIconName } from '../PixelIcon';
import { Button, PressableScale } from '../ui';
import { empty } from '../../constants/copy';

export interface TeachingEmptyStateProps {
  /** Opens the add screen, where a link can be typed or pasted. The main button. */
  onAdd: () => void;
  onOpenFile: () => void;
  /** Opens Search. */
  onSearch: () => void;
  /** Opens the in-app Browser. */
  onBrowse: () => void;
  /** Search sources switched on, for the Search tile's subtitle. */
  searchSources: number;
}

function FinderTile({ icon, title, subtitle, onPress }: { icon: PixelIconName; title: string; subtitle: string; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      containerStyle={styles.tileOuter}
      style={styles.finder}
    >
      <PixelIcon name={icon} size={24} color={colors.download} />
      <Text style={styles.finderTitle}>{title}</Text>
      <Text style={styles.finderSub}>{subtitle}</Text>
    </PressableScale>
  );
}

/** Shown when there are no transfers. Teaches the ways to add one: a link, a .torrent file, or finding something. */
export function TeachingEmptyState({ onAdd, onOpenFile, onSearch, onBrowse, searchSources }: TeachingEmptyStateProps) {
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
        <Button label="Add a link" icon="link" fullWidth onPress={onAdd} />
        <Button label="Open a .torrent file" icon="file" variant="ghost" fullWidth onPress={onOpenFile} />
      </View>
      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.dividerLabel}>or find something</Text>
        <View style={styles.rule} />
      </View>
      <View style={styles.finders}>
        <FinderTile icon="search" title="Search" subtitle={`${searchSources} ${searchSources === 1 ? 'source' : 'sources'} at once`} onPress={onSearch} />
        <FinderTile icon="network" title="Browser" subtitle="Save videos from pages" onPress={onBrowse} />
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
    actions: { marginTop: spacing.xl, alignSelf: 'stretch', gap: spacing.sm },
    divider: { marginTop: spacing.xl, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    dividerLabel: { ...type.body, fontSize: 12, color: c.textMuted },
    finders: { marginTop: spacing.lg, alignSelf: 'stretch', flexDirection: 'row', gap: spacing.md },
    tileOuter: { flex: 1 },
    finder: {
      minHeight: touch.min,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.lg,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
    },
    finderTitle: { ...type.bodyStrong, fontSize: 14, color: c.text, textAlign: 'center' },
    finderSub: { ...type.body, fontSize: 12, lineHeight: 16, color: c.textMuted, textAlign: 'center' },
  });
