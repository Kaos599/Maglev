import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { Button, Sheet } from '../ui';

export interface DeleteSheetProps {
  visible: boolean;
  count: number;
  /** Bytes on disk for the selected transfers, shown before files are deleted. */
  bytes: number;
  onClose: () => void;
  /** `false` removes from the list and keeps the files (undoable). `true` deletes the files. */
  onConfirm: (deleteFiles: boolean) => void;
}

/** Remove keeps files and acts at once (the screen offers Undo). Deleting files asks again, with the size. */
export function DeleteSheet({ visible, count, bytes, onClose, onConfirm }: DeleteSheetProps) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!visible) setConfirming(false);
  }, [visible]);

  const noun = count === 1 ? '1 transfer' : `${count} transfers`;
  const size = bytes > 0 ? formatBytes(bytes) : null;

  if (confirming) {
    return (
      <Sheet
        visible={visible}
        onClose={onClose}
        title={`Delete ${noun} and files?`}
        subtitle={size ? `This permanently deletes ${size} from your device.` : 'This permanently deletes the downloaded files.'}
      >
        <View style={styles.stack}>
          <Button label={size ? `Delete ${size}` : 'Delete files'} variant="danger" icon="trash" fullWidth onPress={() => onConfirm(true)} />
          <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose} title={`Remove ${noun}?`} subtitle="Downloaded files can stay on your device or be deleted too.">
      <View style={styles.stack}>
        <Button label="Remove (keep files)" variant="secondary" fullWidth onPress={() => onConfirm(false)} />
        <Button label="Remove and delete files" variant="danger" icon="trash" fullWidth onPress={() => setConfirming(true)} />
        <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({ stack: { gap: spacing.sm } });
