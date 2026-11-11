import { useMemo } from 'react';
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatSpeed } from '../constants/format';
import { useMaglevEngine } from '../context/EngineContext';
import { useTheme } from '../context/ThemeContext';
import { fonts, touch, ThemeColors } from '../constants/theme';

export const SpeedTelemetryHeader: React.FC = () => {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
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
            color={isAnyActive ? colors.textMuted : colors.accent}
          />
          <Text
            style={[
              styles.actionButtonText,
              { color: isAnyActive ? colors.textMuted : colors.accent },
            ]}
          >
            {isAnyActive ? 'PAUSE ALL' : 'RESUME ALL'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
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
    color: colors.download,
    fontSize: 14,
    fontWeight: '700',
    marginRight: 4,
  },
  speedValueDown: {
    color: colors.download,
    fontSize: 11,
    ...fonts.mono,
  },
  speedDivider: {
    width: 1,
    height: 16,
    backgroundColor: colors.border,
    marginHorizontal: 12,
  },
  speedLabelUp: {
    color: colors.accentText,
    fontSize: 14,
    fontWeight: '700',
    marginRight: 4,
  },
  speedValueUp: {
    color: colors.accentText,
    fontSize: 11,
    ...fonts.mono,
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actionButton: {
    minHeight: touch.min,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionButtonText: {
    fontSize: 10,
    ...fonts.monoBold,
    marginLeft: 6,
    letterSpacing: 0.5,
  },
});
