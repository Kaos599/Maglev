import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { PressableScale, Toggle } from '../ui';
import type { ProviderInfo } from '../search/meta';

export function Monogram({ abbr, dashed, tint }: { abbr: string; dashed?: boolean; tint?: boolean }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.mono, dashed && styles.monoOff]} accessible={false} importantForAccessibility="no-hide-descendants">
      <Text style={[styles.monoText, { color: dashed ? colors.textMuted : tint ? colors.accentText : colors.text }]}>{abbr}</Text>
    </View>
  );
}

export interface ProviderRowProps {
  provider: ProviderInfo;
  enabled: boolean;
  /** 1-based priority in the On list; omitted for Off rows. */
  position?: number;
  note: string;
  noteTone?: 'normal' | 'warning' | 'danger';
  first: boolean;
  onOpen: () => void;
  onToggle: (next: boolean) => void;
}

export function ProviderRow({ provider, enabled, position, note, noteTone = 'normal', first, onOpen, onToggle }: ProviderRowProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const noteColor = noteTone === 'danger' ? colors.danger : noteTone === 'warning' ? colors.warning : colors.textMuted;
  const unsafe = !!provider.unsafeReason;
  return (
    <View style={[styles.row, !first && styles.divider]}>
      {position !== undefined ? (
        <Text style={styles.position} accessibilityElementsHidden importantForAccessibility="no">
          {position}
        </Text>
      ) : null}
      <PressableScale
        onPress={onOpen}
        containerStyle={styles.main}
        style={styles.mainInner}
        accessibilityRole="button"
        accessibilityLabel={`${provider.name}${unsafe ? ', unsafe' : ''}${position !== undefined ? `, priority ${position}` : ''}, ${note}`}
        accessibilityHint="Opens details"
      >
        <Monogram abbr={provider.abbr} dashed={!enabled} tint={enabled} />
        <View style={styles.texts}>
          <View style={styles.nameLine}>
            <Text style={[styles.name, !enabled && { color: colors.textMuted }]} numberOfLines={1}>
              {provider.name}
            </Text>
            {unsafe ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Unsafe</Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.note, { color: noteColor }]} numberOfLines={2}>
            {note}
          </Text>
        </View>
      </PressableScale>
      <Toggle value={enabled} onValueChange={onToggle} accessibilityLabel={`Use ${provider.name} for search`} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingHorizontal: spacing.md, gap: spacing.sm },
    divider: { borderTopWidth: 1, borderTopColor: c.border },
    position: { ...type.mono, width: 18, fontSize: 12, color: c.textMuted, textAlign: 'center' },
    main: { flex: 1, minHeight: 56 },
    mainInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 56 },
    texts: { flex: 1, gap: 3 },
    nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    name: { ...type.bodyStrong, fontSize: 15, color: c.text, flexShrink: 1 },
    note: { ...type.body, fontSize: 12, lineHeight: 16 },
    badge: {
      paddingHorizontal: spacing.sm - 2,
      paddingVertical: 1,
      borderRadius: radius.sm - 2,
      borderWidth: 1,
      borderColor: c.warning,
      backgroundColor: alpha(c.warning, 0.12),
    },
    badgeText: { ...type.bodyStrong, fontSize: 11, color: c.warning },
    mono: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm + 2,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
    },
    monoOff: { backgroundColor: 'transparent', borderColor: c.borderStrong, borderStyle: 'dashed' },
    monoText: { ...type.monoBold, fontSize: 12 },
  });
