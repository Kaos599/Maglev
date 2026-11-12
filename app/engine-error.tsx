import React, { useCallback, useMemo } from 'react';
import { BackHandler, Platform, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Screen, EmptyBlock } from '../components/ui';
import { useMaglevEngine } from '../context/EngineContext';
import { useTheme } from '../context/ThemeContext';
import { ThemeColors } from '../constants/theme';
import { empty } from '../constants/copy';

export default function EngineErrorScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { engineStatus } = useMaglevEngine();
  const message = engineStatus.kind === 'starting'
    ? 'The download engine took too long to start.'
    : engineStatus.message || 'The engine did not report a reason.';

  const copyDetails = useCallback(async () => {
    const details = [
      empty.engineError.title,
      message,
      `Platform: ${Platform.OS} ${String(Platform.Version)}`,
    ].join('\n');
    try {
      await Clipboard.setStringAsync(details);
    } catch {
      // Clipboard unavailable; nothing else to do.
    }
  }, [message]);

  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} testID="engine-error">
      <View style={styles.center}>
        <EmptyBlock
          icon="warning"
          error
          title={empty.engineError.title}
          body={message}
          primary={{ label: 'Copy details', icon: 'copy', onPress: copyDetails }}
          secondary={{ label: 'Close app', onPress: () => BackHandler.exitApp() }}
        />
      </View>
    </Screen>
  );
}

const makeStyles = (_c: ThemeColors) => StyleSheet.create({ center: { flex: 1, justifyContent: 'center' } });
