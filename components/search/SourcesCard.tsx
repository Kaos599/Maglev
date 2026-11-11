import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button } from '../ui';
import type { ProviderInfo } from './meta';

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Idle-state card: which sources a search will ask, with a way to change them. */
export function SourcesCard({ providers, onChange }: { providers: ProviderInfo[]; onChange: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const n = providers.length;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.title} accessibilityRole="header">
          {n === 0 ? 'No sources on' : `Searching ${n} ${n === 1 ? 'source' : 'sources'}`}
        </Text>
        <Button label="Change" variant="ghost" onPress={onChange} accessibilityLabel="Change search sources" />
      </View>
      {n > 0 ? (
        <>
          <View style={styles.marks}>
            {providers.map((p) => (
              <View key={p.id} style={styles.mark} accessible accessibilityLabel={p.name}>
                <Text style={styles.markText}>{p.abbr}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.body}>{joinNames(providers.map((p) => p.name))}. Results that point to the same torrent are shown once.</Text>
        </>
      ) : (
        <Text style={styles.body}>Turn on at least one source to search.</Text>
      )}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: { padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    title: { ...type.bodyStrong, fontSize: 13, color: c.text },
    marks: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
    mark: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm + 2,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surfaceRaised,
    },
    markText: { ...type.monoBold, fontSize: 12, color: c.accentText },
    body: { ...type.body, fontSize: 12, lineHeight: 18, color: c.textMuted, marginTop: spacing.md },
  });
