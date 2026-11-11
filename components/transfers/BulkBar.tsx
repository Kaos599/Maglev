import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing } from '../../constants/theme';
import { Button } from '../ui';

export interface BulkBarProps {
  disabled: boolean;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
}

export function BulkBar({ disabled, onPause, onResume, onDelete }: BulkBarProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      <View style={styles.cell}>
        <Button label="Pause" icon="pause" variant="secondary" disabled={disabled} fullWidth onPress={onPause} />
      </View>
      <View style={styles.cell}>
        <Button label="Resume" icon="play" variant="secondary" disabled={disabled} fullWidth onPress={onResume} />
      </View>
      <View style={styles.cell}>
        <Button label="Delete…" icon="trash" variant="danger" disabled={disabled} fullWidth onPress={onDelete} />
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    bar: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      backgroundColor: c.surface,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    cell: { flex: 1 },
  });
