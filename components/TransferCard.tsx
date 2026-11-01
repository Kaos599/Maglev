import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { TorrentTelemetry } from 'maglev-engine';
import { formatBytes, formatEta, formatSpeed, TOKENS } from '../constants/tokens';
import { useMaglevEngine } from '../context/EngineContext';
import {
  PixelClockIcon,
  PixelCheckDoneIcon,
  PixelPauseBarsIcon,
  PixelStopSquareIcon,
  PixelPlayTriangleIcon,
  PixelArrowDownIcon,
  PixelArrowUpIcon,
} from './PixelIcons';

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
    e.stopPropagation?.();
    if (isDownloading || isSeeding) {
      await pauseTorrent(torrent.id);
    } else {
      await resumeTorrent(torrent.id);
    }
  };

  const getProgressBarColor = () => {
    if (isDownloading) return TOKENS.colors.accentCyan;
    if (isSeeding) return TOKENS.colors.accentLime;
    return '#6B7280';
  };

  const renderBadge = () => {
    if (isDownloading) {
      return (
        <View style={styles.badgeDownloading}>
          <PixelClockIcon size={9} color={TOKENS.colors.accentCyan} />
          <Text style={styles.badgeTextDownloading}>
            {formatEta(torrent.etaSeconds)}
          </Text>
        </View>
      );
    }
    if (isSeeding) {
      return (
        <View style={styles.badgeDone}>
          <PixelCheckDoneIcon size={9} color={TOKENS.colors.accentLime} />
          <Text style={styles.badgeTextDone}>DONE</Text>
        </View>
      );
    }
    return (
      <View style={styles.badgePaused}>
        <Text style={styles.badgeTextPaused}>[PAUSED]</Text>
      </View>
    );
  };

  const renderSpeedMetrics = () => {
    if (isDownloading) {
      return (
        <View style={styles.metricsRow}>
          <Text style={styles.speedTextDown}>
            {`↓ ${formatSpeed(torrent.downloadSpeedBytes)}`}
          </Text>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bytesText}>
            {`${formatBytes(torrent.downloadedBytes)} / ${formatBytes(torrent.totalSizeBytes)}`}
          </Text>
        </View>
      );
    }
    if (isSeeding) {
      return (
        <View style={styles.metricsRow}>
          <Text style={styles.speedTextUp}>
            {`↑ ${formatSpeed(torrent.uploadSpeedBytes)}`}
          </Text>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bytesText}>
            {`Uploaded ${formatBytes(torrent.uploadedBytes)}`}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.metricsRow}>
        <Text style={styles.speedTextPaused}>Paused</Text>
        <Text style={styles.bulletDot}>•</Text>
        <Text style={styles.bytesText}>
          {`${formatBytes(torrent.downloadedBytes)} / ${formatBytes(torrent.totalSizeBytes)}`}
        </Text>
      </View>
    );
  };

  const renderBottomStats = () => {
    if (isDownloading) {
      return (
        <View style={styles.bottomStatsRight}>
          <View style={styles.statItem}>
            <PixelArrowDownIcon size={11} color={TOKENS.colors.accentCyan} />
            <Text style={styles.statCount}>{torrent.peersConnected || 28}</Text>
          </View>
          <View style={styles.statItem}>
            <PixelArrowUpIcon size={11} color={TOKENS.colors.accentLime} />
            <Text style={styles.statCount}>{torrent.seedsConnected || 6}</Text>
          </View>
        </View>
      );
    }
    if (isSeeding) {
      return (
        <View style={styles.bottomStatsRight}>
          <View style={styles.statItem}>
            <PixelArrowUpIcon size={11} color={TOKENS.colors.accentLime} />
            <Text style={styles.statCount}>{`${torrent.peersConnected || 14} peers`}</Text>
          </View>
          <Text style={styles.ratioText}>{`${(torrent.ratio || 2.82).toFixed(2)}x`}</Text>
        </View>
      );
    }
    return (
      <View style={styles.bottomStatsRight}>
        <Text style={styles.pausedRateText}>0 KB/s</Text>
      </View>
    );
  };

  const renderActionButton = () => {
    let icon = <PixelPlayTriangleIcon size={12} color={TOKENS.colors.accentLime} />;
    let label = 'START';
    let labelColor = TOKENS.colors.accentLime;

    if (isDownloading) {
      icon = <PixelPauseBarsIcon size={12} color="#D1D5DB" />;
      label = 'PAUSE';
      labelColor = '#8B949E';
    } else if (isSeeding) {
      icon = <PixelStopSquareIcon size={11} color="#FF007F" />;
      label = 'STOP';
      labelColor = '#FF007F';
    }

    return (
      <TouchableOpacity
        style={styles.actionColumn}
        onPress={handleAction}
        accessibilityRole="button"
        accessibilityLabel={`${label} ${torrent.name}`}
        activeOpacity={0.7}
      >
        <View style={styles.actionIconWrapper}>
          {icon}
        </View>
        <Text style={[styles.actionLabel, { color: labelColor }]}>{label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.card}>
      {/* Left Main Content Area - Tap to view detail */}
      <TouchableOpacity
        style={styles.mainContent}
        activeOpacity={0.85}
        onPress={() => router.push(`/torrent/${torrent.id}` as any)}
        accessibilityRole="button"
        accessibilityLabel={`View detail for ${torrent.name}`}
      >
        {/* Row 1: Title + Badge */}
        <View style={styles.rowTitle}>
          <Text style={styles.titleText} numberOfLines={1} ellipsizeMode="middle">
            {torrent.name}
          </Text>
          {renderBadge()}
        </View>

        {/* Row 2: Speed + Transfer Metrics */}
        {renderSpeedMetrics()}

        {/* Row 3: Progress Bar */}
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${Math.min(100, Math.max(0, torrent.progressPercent))}%`,
                backgroundColor: getProgressBarColor(),
              },
            ]}
          />
        </View>

        {/* Row 4: Percent + Bottom Meta Stats */}
        <View style={styles.bottomRow}>
          <Text style={styles.percentText}>{`${torrent.progressPercent.toFixed(1)}%`}</Text>
          {renderBottomStats()}
        </View>
      </TouchableOpacity>

      {/* Dedicated Full-Height Vertical Action Bar */}
      {renderActionButton()}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#0D1117',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1F2937',
    marginHorizontal: 16,
    marginBottom: 12,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  mainContent: {
    flex: 1,
    padding: 14,
    justifyContent: 'space-between',
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  titleText: {
    flex: 1,
    fontFamily: 'SpaceMono',
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: -0.2,
  },
  badgeDownloading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0, 229, 255, 0.1)',
    borderColor: 'rgba(0, 229, 255, 0.3)',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeTextDownloading: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: '700',
    color: TOKENS.colors.accentCyan,
  },
  badgeDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(204, 255, 0, 0.15)',
    borderColor: 'rgba(204, 255, 0, 0.3)',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    shadowColor: TOKENS.colors.accentLime,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
  },
  badgeTextDone: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    fontWeight: '700',
    color: TOKENS.colors.accentLime,
  },
  badgePaused: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeTextPaused: {
    fontFamily: 'Silkscreen',
    fontSize: 8,
    fontWeight: '700',
    color: '#D1D5DB',
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  speedTextDown: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: TOKENS.colors.accentCyan,
  },
  speedTextUp: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '700',
    color: TOKENS.colors.accentLime,
  },
  speedTextPaused: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '500',
    color: '#8B949E',
  },
  bulletDot: {
    color: '#8B949E',
    fontSize: 10,
  },
  bytesText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: '#D1D5DB',
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#161D28',
    overflow: 'hidden',
    marginVertical: 4,
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(22, 29, 40, 0.7)',
  },
  percentText: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  bottomStatsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statCount: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: '#9CA3AF',
  },
  ratioText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    color: '#9CA3AF',
  },
  pausedRateText: {
    fontFamily: 'SpaceMono',
    fontSize: 10,
    color: '#8B949E',
  },
  actionColumn: {
    width: 64,
    backgroundColor: '#121722',
    borderLeftWidth: 1,
    borderLeftColor: '#1F2937',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionIconWrapper: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: '#1A2230',
    borderWidth: 1,
    borderColor: '#2D3A4E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionLabel: {
    fontFamily: 'Silkscreen',
    fontSize: 7,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
});
