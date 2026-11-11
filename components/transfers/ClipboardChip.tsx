import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { Banner } from '../ui';

export interface ClipboardChipProps {
  onAdd: () => void;
  onDismiss: () => void;
}

export function ClipboardChip({ onAdd, onDismiss }: ClipboardChipProps) {
  return (
    <View style={styles.wrap}>
      <Banner tone="info" title="Magnet in clipboard" actionLabel="Add" onAction={onAdd} onDismiss={onDismiss} />
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm } });
