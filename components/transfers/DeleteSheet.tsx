import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { Button, Sheet } from '../ui';

export interface DeleteSheetProps {
  visible: boolean;
  count: number;
  onClose: () => void;
  onConfirm: (deleteFiles: boolean) => void;
}

export function DeleteSheet({ visible, count, onClose, onConfirm }: DeleteSheetProps) {
  const noun = count === 1 ? '1 transfer' : `${count} transfers`;
  return (
    <Sheet visible={visible} onClose={onClose} title={`Delete ${noun}?`} subtitle="Downloaded files can stay on your device or be deleted too.">
      <View style={styles.stack}>
        <Button label="Remove from list" variant="secondary" fullWidth onPress={() => onConfirm(false)} />
        <Button label="Delete with files" variant="danger" icon="trash" fullWidth onPress={() => onConfirm(true)} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({ stack: { gap: spacing.sm } });
