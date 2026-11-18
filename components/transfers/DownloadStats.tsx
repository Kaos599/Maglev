import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { DownloadSnapshot } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { spacing } from '../../constants/theme';
import { formatBytes, formatEta, formatSpeed } from '../../constants/format';
import { StatGrid } from '../detail/StatGrid';
import { TimingRow } from '../detail/TimingRow';

/**
 * NATIVE_CONTRACT 40.2: what the download page shows about a link download's numbers. Its own component so a later
 * Compact mode can swap it. A 2x2 grid (Speed, Time left, Downloaded, Connections), then the timing row in every state.
 * Nothing is invented: a value the engine does not know, or that has no meaning right now, reads "—".
 */
export type DownloadStatsInput = Pick<
  DownloadSnapshot,
  'state' | 'downBps' | 'eta' | 'size' | 'downloaded' | 'segmentsActive' | 'activeSecs' | 'finishedAt' | 'addedAt' | 'sessionBytes' | 'bytesWifi' | 'bytesMobile'
>;

// NATIVE_CONTRACT 41.2: this is the link page's Detailed block. It takes only the fields it draws, so the Download page
// sheet can render it from fixed sample data.
export function DownloadStats({ download: d }: { download: DownloadStatsInput }) {
  const { colors } = useTheme();
  const running = d.state === 'downloading';
  return (
    <View style={styles.wrap}>
      <StatGrid
        columns={2}
        stats={[
          { label: 'Speed', value: running ? formatSpeed(d.downBps) : '—', tint: colors.download },
          // Finished: "Done" here; the average speed is already on the timing row below, so Speed stays "—".
          { label: 'Time left', value: d.state === 'finished' ? 'Done' : running && d.eta >= 0 ? formatEta(d.eta) : '—' },
          { label: 'Downloaded', value: d.size ? `${formatBytes(d.downloaded)} of ${formatBytes(d.size)}` : formatBytes(d.downloaded) },
          { label: 'Connections', value: running ? String(d.segmentsActive) : '—' },
        ]}
      />
      <TimingRow
        timing={{
          activeSecs: d.activeSecs,
          finishedAt: d.finishedAt,
          addedAt: d.addedAt,
          sessionBytes: d.sessionBytes,
          bytesWifi: d.bytesWifi,
          bytesMobile: d.bytesMobile,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // The grid's own gap.
  wrap: { gap: spacing.sm },
});
