import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors, radius, spacing } from '../constants/theme';
import { PixelIcon } from './PixelIcon';
import { PressableScale } from './ui';

export interface FloatingActionButtonProps {
  onPress: () => void;
  accessibilityLabel?: string;
}

export function FloatingActionButton({ onPress, accessibilityLabel = 'Add a torrent or link' }: FloatingActionButtonProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.anchor} pointerEvents="box-none">
      <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel} style={styles.fab}>
        <PixelIcon name="plus" size={24} color={colors.onAccent} />
      </PressableScale>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    anchor: { position: 'absolute', right: spacing.lg, bottom: spacing.lg },
    fab: {
      width: 56,
      height: 56,
      borderRadius: radius.lg,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
