import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { TorrentTelemetry } from 'maglev-engine';
import { formatBytes, formatEta, formatSpeed, TOKENS } from '../constants/tokens';
import { useMaglevEngine } from '../context/EngineContext';

interface TransferCardProps {
  torrent: TorrentTelemetry;
}

export const TransferCard: React.FC<TransferCardProps> = ({ torrent }) => {
  const router = useRouter();
  const { pauseTorrent, resumeTorrent } = useMaglevEngine();

  const isDownloading = torrent.state === 'DOWNLOADING';
  const isSeeding = torrent.state === 'SEEDING';
  const isPaused = torrent.state === 'PAUSED';

  const handleAction = async (e: any) => {
    e.stopPropagation();
    if (isDownloading || isSeeding) {
      await pauseTorrent(torrent.id);
    } else {
      await resumeTorrent(torrent.id);
    }
  };

  const getProgressBarColor = () => {
    if (isDownloading) return TOKENS.colors.accentCyan;
    if (isSeeding) return TOKENS.colors.accentLime;
    return TOKENS.colors.statusPaused;
  };

  const renderBadge = () => {
    if (isDownloading) {
      return (
        <View style={[styles.badge, styles.badgeDownloading]}>
          <Text style={styles.badgeTextDownloading}>
            {formatEta(torrent.etaSeconds)}
          </Text>
        </View>
      );
    }
    if (isSeeding) {
      return (
        <View style={[styles.badge, styles.badgeDone]}>
          <Text style={styles.badgeTextDone}>✓ DONE</Text>
        </View>
      );
    }
    return (
      <View style={[styles.badge, styles.badgePaused]}>
        <Text style={styles.badgeTextPaused}>PAUSED</Text>
      </View>
    );
  };

  const renderMetrics = () => {
    if (isDownloading) {
      return `↓ ${formatSpeed(torrent.downloadSpeedBytes)} · ${formatBytes(torrent.downloadedBytes)} / ${formatBytes(torrent.totalSizeBytes)}`;
    }
    if (isSeeding) {
      return `↑ ${formatSpeed(torrent.uploadSpeedBytes)} · Uploaded ${formatBytes(torrent.uploadedBytes)}`;
    }
    return `Paused · ${formatBytes(torrent.downloadedBytes)} / ${formatBytes(torrent.totalSizeBytes)}`;
  };

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={0.8}
      onPress={() => router.push(`/torrent/${torrent.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`Torrent ${torrent.name}, ${torrent.progressPercent}%`}
    >
      {/* Row 1: Header */}
      <View style={styles.rowHeader}>
        <Text style={styles.filename} numberOfLines={1} ellipsizeMode="middle">
          {torrent.name}
        </Text>
        {renderBadge()}
      </View>

      {/* Row 2: Metrics */}
      <Text style={styles.metricsText}>{renderMetrics()}</Text>

      {/* Row 3: Progress Bar (Continuous 6px) */}
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressBar,
            {
              width: `${Math.min(100, Math.max(0, torrent.progressPercent))}%`,
              backgroundColor: getProgressBarColor(),
            },
          ]}
        />
      </View>

      {/* Row 4: Footer & Action */}
      <View style={styles.rowFooter}>
        <View style={styles.telemetryInfo}>
          <Text style={styles.percentText}>
            {torrent.progressPercent.toFixed(1)}%
          </Text>
          <Text style={styles.peersText}>
            ↓ {torrent.peersConnected}   ↑ {torrent.seedsConnected}
          </Text>
        </View>

        <TouchableOpacity
          style={[
            styles.actionButton,
            isPaused && styles.actionButtonPaused,
          ]}
          onPress={handleAction}
          accessibilityRole="button"
          accessibilityLabel={isPaused ? 'Resume torrent' : 'Pause torrent'}
        >
          {isDownloading && (
            <Ionicons name="pause" size={16} color={TOKENS.colors.textPrimary} />
          )}
          {isSeeding && (
            <View style={styles.stopButtonContent}>
              <View style={styles.stopSquare} />
              <Text style={styles.stopLabel}>STOP</Text>
            </View>
          )}
          {isPaused && (
            <View style={styles.resumeButtonContent}>
              <Ionicons name="play" size={12} color={TOKENS.colors.accentLime} />
              <Text style={styles.resumeLabel}>RESUME</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 12,
    marginHorizontal: 16,
    marginVertical: 6,
    padding: 14,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  filename: {
    flex: 1,
    color: TOKENS.colors.textPrimary,
    fontSize: TOKENS.typography.cardFilename.fontSize,
    fontWeight: TOKENS.typography.cardFilename.fontWeight,
    fontFamily: 'monospace',
    marginRight: 10,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeDownloading: {
    backgroundColor: 'rgba(0, 229, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(0, 229, 255, 0.4)',
  },
  badgeTextDownloading: {
    color: TOKENS.colors.accentCyan,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  badgeDone: {
    backgroundColor: 'rgba(204, 255, 0, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(204, 255, 0, 0.4)',
  },
  badgeTextDone: {
    color: TOKENS.colors.accentLime,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  badgePaused: {
    backgroundColor: 'rgba(139, 148, 158, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(139, 148, 158, 0.4)',
  },
  badgeTextPaused: {
    color: TOKENS.colors.statusPaused,
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  metricsText: {
    color: TOKENS.colors.textMuted,
    fontSize: TOKENS.typography.telemetry.fontSize,
    fontWeight: TOKENS.typography.telemetry.fontWeight,
    fontVariant: ['tabular-nums'],
    fontFamily: 'monospace',
    marginBottom: 10,
  },
  progressTrack: {
    height: 6,
    backgroundColor: '#161B22',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 10,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
  },
  rowFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  telemetryInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  percentText: {
    color: TOKENS.colors.textPrimary,
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
    fontVariant: ['tabular-nums'],
  },
  peersText: {
    color: TOKENS.colors.textMuted,
    fontSize: 11,
    fontWeight: '500',
    fontFamily: 'monospace',
  },
  actionButton: {
    minWidth: TOKENS.touchTarget.minWidth,
    minHeight: TOKENS.touchTarget.minHeight,
    backgroundColor: '#161B22',
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  actionButtonPaused: {
    borderColor: 'rgba(204, 255, 0, 0.5)',
  },
  stopButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  stopSquare: {
    width: 8,
    height: 8,
    backgroundColor: TOKENS.colors.textMuted,
  },
  stopLabel: {
    color: TOKENS.colors.textMuted,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  resumeButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  resumeLabel: {
    color: TOKENS.colors.accentLime,
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
