import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { Button, Sheet } from '../ui';
import { sharingBadge, sharingWords } from './sharing';

export interface ResultPreview {
  name: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  age: string;
  via: string;
  detailUrl?: string;
  added: boolean;
}

export interface ResultPreviewSheetProps {
  result: ResultPreview | null;
  onClose: () => void;
  onAdd: () => void;
  onOpenInBrowser: () => void;
}

/** A closer look at one result before adding it. */
export function ResultPreviewSheet({ result, onClose, onAdd, onOpenInBrowser }: ResultPreviewSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const badge = result ? sharingBadge(result.seeders) : null;
  const lines: [string, string][] = result
    ? [
        ['Size', result.sizeBytes ? formatBytes(result.sizeBytes) : 'Unknown'],
        ['People', sharingWords(result.seeders, result.leechers)],
        ['Source', result.via],
        ['Added', result.age ? `${result.age} ago` : 'Unknown'],
      ]
    : [];
  return (
    <Sheet visible={!!result} onClose={onClose} title={result?.name ?? ''}>
      <View style={styles.stack}>
        {lines.map(([k, v]) => (
          <View key={k} style={styles.line}>
            <Text style={styles.key}>{k}</Text>
            <Text style={styles.value}>{v}</Text>
          </View>
        ))}
        {badge ? <Text style={styles.warn}>{badge}. This may be slow or never finish.</Text> : null}
        <Button label={result?.added ? 'Already added' : 'Add'} icon="download" fullWidth disabled={result?.added} onPress={onAdd} />
        {result?.detailUrl ? <Button label="Open in browser" icon="network" variant="secondary" fullWidth onPress={onOpenInBrowser} /> : null}
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    line: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    key: { ...type.body, fontSize: 13, color: c.textMuted },
    value: { ...type.mono, fontSize: 13, color: c.text, flexShrink: 1, textAlign: 'right' },
    warn: { ...type.body, fontSize: 13, color: c.warning },
  });
