import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, spacing, type } from '../constants/theme';
import { formatSpeed } from '../constants/format';
import { Button } from './ui';

export interface SpeedTelemetryHeaderProps {
  downloadBytes: number;
  uploadBytes: number;
  /** Show Pause all when something is running, otherwise Resume all. */
  canPause: boolean;
  canResume: boolean;
  onPauseAll: () => void;
  onResumeAll: () => void;
}

export function SpeedTelemetryHeader({ downloadBytes, uploadBytes, canPause, canResume, onPauseAll, onResumeAll }: SpeedTelemetryHeaderProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.strip}>
      <View style={styles.speeds}>
        <Text style={[styles.speed, { color: colors.download }]} accessibilityLabel={`Download ${formatSpeed(downloadBytes)}`}>
          {`↓ ${formatSpeed(downloadBytes)}`}
        </Text>
        <Text style={[styles.speed, { color: colors.upload }]} accessibilityLabel={`Upload ${formatSpeed(uploadBytes)}`}>
          {`↑ ${formatSpeed(uploadBytes)}`}
        </Text>
      </View>
      {canPause ? (
        <Button label="Pause all" variant="secondary" icon="pause" onPress={onPauseAll} />
      ) : canResume ? (
        <Button label="Resume all" variant="secondary" icon="play" onPress={onResumeAll} />
      ) : null}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    strip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.bg,
    },
    speeds: { flexDirection: 'row', gap: spacing.lg, flexShrink: 1 },
    speed: { ...type.monoBold, fontSize: 13 },
  });
