import React, { useMemo, useRef } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, type } from '../../constants/theme';
import { formatSpeed } from '../../constants/format';
import { formatEta } from '../../utils/rates';

export interface CompactLineProps {
  /** Download speed in bytes per second. Leave out to omit the part. */
  down?: number;
  /** Upload speed in bytes per second. Leave out to omit the part. */
  up?: number;
  /** Seconds left. Leave out, or pass a negative number, when unknown: the part is then omitted. */
  etaSecs?: number;
}

/**
 * NATIVE_CONTRACT 41.1: the one line of Compact mode, inside the progress card under the bar. Used by the torrent page,
 * the link download page and the previews in the Download page sheet, so the three cannot drift.
 * "↓ 8.4 MB/s · ↑ 140 KB/s · 3 min left": down in the download colour, up in the upload colour, the rest muted.
 * Returns nothing when no part is known.
 */
export function CompactLine({ down, up, etaSecs }: CompactLineProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const etaRef = useRef<string | null>(null);
  // The card's own wording and its steadiness: the same function, the same hysteresis.
  const eta = etaSecs != null && etaSecs >= 0 ? formatEta(etaSecs, etaRef.current) : '—';
  etaRef.current = eta === '—' ? null : eta;

  const parts: { key: string; text: string; color: string }[] = [];
  if (down != null) parts.push({ key: 'down', text: `↓ ${formatSpeed(down)}`, color: colors.download });
  if (up != null) parts.push({ key: 'up', text: `↑ ${formatSpeed(up)}`, color: colors.upload });
  if (eta !== '—') parts.push({ key: 'eta', text: `${eta} left`, color: colors.textMuted });
  if (!parts.length) return null;

  const spoken = parts
    .map((p) => (p.key === 'down' ? `Download ${formatSpeed(down!)}` : p.key === 'up' ? `Upload ${formatSpeed(up!)}` : p.text))
    .join(', ');
  return (
    <Text style={styles.line} accessibilityLabel={spoken}>
      {parts.map((p, i) => (
        <Text key={p.key} style={{ color: p.color }}>
          {i > 0 ? ' · ' : ''}
          {p.text}
        </Text>
      ))}
    </Text>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    line: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
  });
