import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../constants/theme';
import { Button, Sheet } from '../ui';

export interface MobileDataSheetProps {
  /** The line from oneTapAddNote, or null when closed. */
  note: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** One quiet question before a one-tap add on mobile data. */
export function MobileDataSheet({ note, onConfirm, onClose }: MobileDataSheetProps) {
  return (
    <Sheet visible={!!note} onClose={onClose} title="Add on mobile data?" subtitle={note ? `${note} Add anyway?` : undefined}>
      <View style={styles.stack}>
        <Button label="Add anyway" fullWidth onPress={onConfirm} />
        <Button label="Cancel" variant="secondary" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({ stack: { gap: spacing.sm } });
