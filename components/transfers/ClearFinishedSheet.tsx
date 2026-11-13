import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { Button, Sheet } from '../ui';
import { clearFinishedCopy } from './model';

export interface ClearFinishedSheetProps {
  visible: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}

/** Confirms removing finished transfers from the list. Files are never deleted. */
export function ClearFinishedSheet({ visible, count, onClose, onConfirm }: ClearFinishedSheetProps) {
  const copy = clearFinishedCopy(count);
  return (
    <Sheet visible={visible} onClose={onClose} title={copy.title} subtitle={copy.body}>
      <View style={styles.stack}>
        <Button label={copy.confirm} icon="check" fullWidth onPress={onConfirm} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({ stack: { gap: spacing.sm } });
