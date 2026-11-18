import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { spacing } from '../../constants/theme';
import { formatBytes, formatEta, formatSpeed } from '../../constants/format';
import type { TimingInput } from '../../utils/stats/format';
import { StatGrid } from './StatGrid';
import { TimingRow } from './TimingRow';

export interface TorrentStatsProps {
  downBps: number;
  upBps: number;
  etaSecs: number;
  ratio: number;
  peersLive: number;
  peersSeen: number;
  totalBytes: number;
  timing: TimingInput;
}

/**
 * NATIVE_CONTRACT 41.2: the torrent page's Detailed numbers (the six boxes and the Timing row), as one component so the
 * page and the preview in the Download page sheet draw the same thing. The row sits under the grid with the grid's own gap.
 */
export function TorrentStats(p: TorrentStatsProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <StatGrid
        stats={[
          { label: 'Download', value: formatSpeed(p.downBps), tint: colors.download },
          { label: 'Upload', value: formatSpeed(p.upBps), tint: colors.upload },
          { label: 'ETA', value: p.etaSecs > 0 ? formatEta(p.etaSecs) : '—' },
          { label: 'Ratio', value: p.ratio >= 0 ? p.ratio.toFixed(2) : '—' },
          { label: 'Peers', value: `${p.peersLive}/${p.peersSeen}` },
          { label: 'Size', value: p.totalBytes > 0 ? formatBytes(p.totalBytes) : '—' },
        ]}
      />
      <TimingRow timing={p.timing} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
});
