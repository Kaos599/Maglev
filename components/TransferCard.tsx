import { useMemo } from 'react';
import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { TorrentTelemetry } from 'maglev-engine';
import { formatBytes, formatEta, formatSpeed } from '../constants/format';
import { triggerHaptic } from '../constants/haptics';
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
import { useTheme } from '../context/ThemeContext';
import { alpha, fonts, touch, ThemeColors } from '../constants/theme';

interface TransferCardProps {
  torrent: TorrentTelemetry;
}

export const TransferCard: React.FC<TransferCardProps> = ({ torrent }) => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { pauseTorrent, resumeTorrent, startHttpStream } = useMaglevEngine();

  const buttonScale = useRef(new Animated.Value(1)).current;

  const isDownloading = torrent.state === 'DOWNLOADING';
  const isSeeding = torrent.state === 'SEEDING';
  const isPaused = torrent.state === 'PAUSED';
  const isQueued = torrent.state === 'QUEUED';

  const handleOpenPlay = async (e: any) => {
    e.stopPropagation?.();
    triggerHaptic('medium');
    try {
      const streamUrl = await startHttpStream(torrent.id, 0);
      if (streamUrl) {
        await Linking.openURL(streamUrl);
      }
    } catch {
      // Stream launch fallback
    }
  };

  const handleAction = async (e: any) => {
    e.stopPropagation?.();
    triggerHaptic(isDownloading ? 'light' : 'medium');
    if (isDownloading || isSeeding) {
      await pauseTorrent(torrent.id);
    } else {
      await resumeTorrent(torrent.id);
    }
  };

  const handleButtonPressIn = () => {
    Animated.spring(buttonScale, {
      toValue: 0.88,
      useNativeDriver: true,
      friction: 7,
      tension: 220,
    }).start();
  };

  const handleButtonPressOut = () => {
    Animated.spring(buttonScale, {
      toValue: 1,
      useNativeDriver: true,
      friction: 4,
      tension: 200,
    }).start();
  };

  const getProgressBarColor = () => {
    if (isDownloading) return colors.download;
    if (isSeeding) return colors.accent;
    return colors.borderStrong;
  };

  const renderBadge = () => {
    if (isDownloading) {
      return (
        <View style={styles.badgeDownloading}>
          <PixelClockIcon size={9} color={colors.download} />
          <Text style={styles.badgeTextDownloading}>
            {formatEta(torrent.etaSeconds)}
          </Text>
        </View>
      );
    }
    if (isSeeding) {
      return (
        <View style={styles.badgeDone}>
          <PixelCheckDoneIcon size={9} color={colors.accentText} />
          <Text style={styles.badgeTextDone}>DONE</Text>
        </View>
      );
    }
    if (isQueued) {
      return (
        <View style={styles.badgeQueued}>
          <Text style={styles.badgeTextQueued}>[QUEUED]</Text>
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
      const hasUploadSpeed = torrent.uploadSpeedBytes > 0;
      return (
        <View style={styles.metricsRow}>
          {hasUploadSpeed && (
            <>
              <Text style={styles.speedTextUp}>
                {`↑ ${formatSpeed(torrent.uploadSpeedBytes)}`}
              </Text>
              <Text style={styles.bulletDot}>•</Text>
            </>
          )}
          <Text style={styles.bytesText}>
            {formatBytes(torrent.totalSizeBytes)}
          </Text>
        </View>
      );
    }
    if (isQueued) {
      return (
        <View style={styles.metricsRow}>
          <Text style={styles.speedTextQueued}>Waiting in queue</Text>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bytesText}>
            {formatBytes(torrent.totalSizeBytes)}
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
            <PixelArrowDownIcon size={11} color={colors.download} />
            <Text style={styles.statCount}>{torrent.peersConnected || 28}</Text>
          </View>
          <View style={styles.statItem}>
            <PixelArrowUpIcon size={11} color={colors.accentText} />
            <Text style={styles.statCount}>{torrent.seedsConnected || 6}</Text>
          </View>
        </View>
      );
    }
    if (isSeeding) {
      return (
        <View style={styles.bottomStatsRight}>
          <View style={styles.statItem}>
            <PixelArrowUpIcon size={11} color={colors.accentText} />
            <Text style={styles.statCount}>{`${torrent.peersConnected || 14} peers`}</Text>
          </View>
        </View>
      );
    }
    if (isQueued) {
      return (
        <View style={styles.bottomStatsRight}>
          <Text style={styles.pausedRateText}>Slot pending</Text>
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
    if (isSeeding) {
      return (
        <View style={styles.actionColumnDual}>
          <TouchableOpacity
            style={styles.actionIconWrapper}
            onPress={handleOpenPlay}
            accessibilityRole="button"
            accessibilityLabel={`Open or Play ${torrent.name}`}
            activeOpacity={0.85}
          >
            <PixelPlayTriangleIcon size={14} color={colors.accentText} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionIconWrapper}
            onPress={handleAction}
            accessibilityRole="button"
            accessibilityLabel={`Stop seeding ${torrent.name}`}
            activeOpacity={0.85}
          >
            <PixelStopSquareIcon size={12} color={colors.danger} />
          </TouchableOpacity>
        </View>
      );
    }

    let icon = <PixelPlayTriangleIcon size={14} color={colors.accentText} />;
    let actionLabel = 'Resume';

    if (isDownloading) {
      icon = <PixelPauseBarsIcon size={14} color={colors.text} />;
      actionLabel = 'Pause';
    }

    return (
      <View style={styles.actionColumn}>
        <TouchableOpacity
          style={styles.actionIconWrapper}
          onPress={handleAction}
          onPressIn={handleButtonPressIn}
          onPressOut={handleButtonPressOut}
          accessibilityRole="button"
          accessibilityLabel={`${actionLabel} ${torrent.name}`}
          activeOpacity={0.85}
        >
          <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
            {icon}
          </Animated.View>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.card}>
      {/* Left Main Content Area - Tap to view detail */}
      <TouchableOpacity
        style={styles.mainContent}
        activeOpacity={0.85}
        onPress={() => {
          triggerHaptic('light');
          router.push(`/torrent/${torrent.id}` as any);
        }}
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

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
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
    ...fonts.monoBold,
    fontSize: 13,
    color: colors.text,
    letterSpacing: -0.2,
  },
  badgeDownloading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: alpha(colors.download, 0.1),
    borderColor: alpha(colors.download, 0.3),
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeTextDownloading: {
    ...fonts.monoBold,
    fontSize: 10,
    color: colors.download,
  },
  badgeDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: alpha(colors.accent, 0.15),
    borderColor: alpha(colors.accent, 0.3),
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
  },
  badgeTextDone: {
    ...fonts.monoBold,
    fontSize: 10,
    color: colors.accentText,
  },
  badgePaused: {
    backgroundColor: alpha(colors.text, 0.1),
    borderColor: alpha(colors.text, 0.2),
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeQueued: {
    backgroundColor: alpha(colors.download, 0.08),
    borderColor: alpha(colors.download, 0.25),
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeTextQueued: {
    ...fonts.brand,
    fontSize: 8,
    color: colors.download,
  },
  badgeTextPaused: {
    ...fonts.brand,
    fontSize: 8,
    color: colors.text,
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  speedTextDown: {
    ...fonts.monoBold,
    fontSize: 11,
    color: colors.download,
  },
  speedTextUp: {
    ...fonts.monoBold,
    fontSize: 11,
    color: colors.accentText,
  },
  speedTextPaused: {
    ...fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  speedTextQueued: {
    ...fonts.mono,
    fontSize: 11,
    color: colors.download,
  },
  bulletDot: {
    color: colors.textMuted,
    fontSize: 10,
  },
  bytesText: {
    ...fonts.mono,
    fontSize: 11,
    color: colors.text,
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.surfaceRaised,
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
    borderTopColor: alpha(colors.border, 0.7),
  },
  percentText: {
    ...fonts.monoBold,
    fontSize: 13,
    color: colors.text,
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
    ...fonts.mono,
    fontSize: 11,
    color: colors.textMuted,
  },
  pausedRateText: {
    ...fonts.mono,
    fontSize: 10,
    color: colors.textMuted,
  },
  actionColumn: {
    width: 60,
    backgroundColor: colors.surfaceRaised,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touch.min,
  },
  actionColumnDual: {
    width: 60,
    backgroundColor: colors.surfaceRaised,
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
    minHeight: touch.min,
  },
  actionIconWrapper: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
