import React from 'react';
import { StyleSheet, View } from 'react-native';
import { spacing } from '../../../constants/theme';
import { Button } from '../../ui';

/** The Test model button. While the test runs it shows the blinking dots and ignores taps. */
export function TestModelRow({ testing, onTest }: { testing: boolean; onTest: () => void }) {
  return (
    <View style={styles.row}>
      <Button label={testing ? 'Testing' : 'Test model'} onPress={onTest} loading={testing} fullWidth testID="assistant-test-model" />
    </View>
  );
}

const styles = StyleSheet.create({ row: { marginTop: spacing.xs } });
