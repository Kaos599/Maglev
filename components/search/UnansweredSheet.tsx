import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type, touch } from '../../constants/theme';
import type { UnansweredSource } from '../../utils/search/answered';
import { Button, Sheet } from '../ui';

export interface UnansweredSheetProps {
  /** Sources that did not answer, or null when closed. */
  sources: UnansweredSource[] | null;
  onClose: () => void;
  returnFocusRef?: React.RefObject<any>;
}

/** Which sources did not respond, each with a plain reason. */
export function UnansweredSheet({ sources, onClose, returnFocusRef }: UnansweredSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Sheet visible={!!sources} onClose={onClose} title="Didn't respond" subtitle="These sources gave no results this time." returnFocusRef={returnFocusRef}>
      <View style={styles.stack}>
        {(sources ?? []).map((s) => (
          <View key={s.providerId} style={styles.row} accessible accessibilityLabel={`${s.name}: ${s.reason}`}>
            <Text style={styles.name}>{s.name}</Text>
            <Text style={styles.reason}>{s.reason}</Text>
          </View>
        ))}
        <Button label="Close" variant="secondary" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    row: { minHeight: touch.min, justifyContent: 'center' },
    name: { ...type.body, fontSize: type.size.lg, color: c.text },
    reason: { ...type.body, fontSize: type.size.md, color: c.textMuted },
  });
