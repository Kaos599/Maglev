import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatSpeed, TOKENS } from '../constants/tokens';
import { useMaglevEngine } from '../context/EngineContext';

export const SpeedTelemetryHeader: React.FC = () => {
  const { telemetry, pauseAll, resumeAll } = useMaglevEngine();

  const isAnyActive = telemetry.activeDownloads > 0 || telemetry.activeUploads > 0;

  return (
    <View style={styles.container}>
      <View style={styles.speedsRow}>
        <View style={styles.speedBlock}>
          <Text style={styles.speedLabelDown}>↓</Text>
          <Text style={styles.speedValueDown}>
            {formatSpeed(telemetry.totalDownloadSpeedBytes)}
          </Text>
        </View>

        <View style={styles.speedDivider} />

        <View style={styles.speedBlock}>
          <Text style={styles.speedLabelUp}>↑</Text>
          <Text style={styles.speedValueUp}>
            {formatSpeed(telemetry.totalUploadSpeedBytes)}
          </Text>
        </View>
      </View>

      <View style={styles.controlsRow}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={isAnyActive ? pauseAll : resumeAll}
          accessibilityRole="button"
          accessibilityLabel={isAnyActive ? 'Pause all transfers' : 'Resume all transfers'}
        >
          <Ionicons
            name={isAnyActive ? 'pause' : 'play'}
            size={14}
            color={isAnyActive ? TOKENS.colors.textMuted : TOKENS.colors.accentLime}
          />
          <Text
            style={[
              styles.actionButtonText,
              { color: isAnyActive ? TOKENS.colors.textMuted : TOKENS.colors.accentLime },
            ]}
          >
            {isAnyActive ? 'PAUSE ALL' : 'RESUME ALL'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: TOKENS.colors.surfaceCard,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
    borderRadius: 12,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  speedsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  speedBlock: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  speedLabelDown: {
    color: TOKENS.colors.accentCyan,
    fontSize: 14,
    fontWeight: '700',
    marginRight: 4,
  },
  speedValueDown: {
    color: TOKENS.colors.accentCyan,
    fontSize: TOKENS.typography.telemetry.fontSize,
    fontWeight: TOKENS.typography.telemetry.fontWeight,
    fontVariant: ['tabular-nums'],
    fontFamily: 'monospace',
  },
  speedDivider: {
    width: 1,
    height: 16,
    backgroundColor: TOKENS.colors.surfaceBorder,
    marginHorizontal: 12,
  },
  speedLabelUp: {
    color: TOKENS.colors.accentLime,
    fontSize: 14,
    fontWeight: '700',
    marginRight: 4,
  },
  speedValueUp: {
    color: TOKENS.colors.accentLime,
    fontSize: TOKENS.typography.telemetry.fontSize,
    fontWeight: TOKENS.typography.telemetry.fontWeight,
    fontVariant: ['tabular-nums'],
    fontFamily: 'monospace',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    minHeight: TOKENS.touchTarget.minHeight,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: TOKENS.colors.surfacePill,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: TOKENS.colors.surfaceBorder,
  },
  actionButtonText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginLeft: 6,
    letterSpacing: 0.5,
  },
});
