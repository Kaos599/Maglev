import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, AppState, StyleSheet, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { spacing } from '../../constants/theme';
import { watchCopy } from '../../constants/copy';
import { Button, ListRow, Toggle } from '../../components/ui';
import { Caption, Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';
import { INTERVALS, filtersLine, lastCheckedText, type IntervalHours, type Watch } from '../../utils/watch/logic';
import { refreshWatches, removeWatchFromStore, updateWatchInStore, useWatches } from '../../utils/watch/store';

function subtitleOf(w: Watch, now: number): string {
  const last = w.lastNewAt > 0 && w.lastNewName ? watchCopy.lastNew(w.lastNewName) : watchCopy.noneNew;
  return `${filtersLine(w)}\n${lastCheckedText(w.lastCheckedAt, now)}\n${last}`;
}

export default function WatchSettings() {
  useTheme();
  const watches = useWatches();
  const [now, setNow] = useState(() => Date.now());
  const styles = useMemo(() => StyleSheet.create({ block: { gap: spacing.sm } }), []);

  // The background job writes from another JS context. Read fresh when this screen opens and when the app returns.
  useEffect(() => {
    refreshWatches();
    setNow(Date.now());
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        refreshWatches();
        setNow(Date.now());
      }
    });
    return () => sub.remove();
  }, []);

  const confirmDelete = useCallback((w: Watch) => {
    Alert.alert(watchCopy.deleteTitle, watchCopy.deleteBody, [
      { text: 'Cancel', style: 'cancel' },
      { text: watchCopy.delete, style: 'destructive', onPress: () => removeWatchFromStore(w.id) },
    ]);
  }, []);

  return (
    <SettingsPage title={watchCopy.title}>
      <Stack.Screen options={{ headerShown: false }} />
      <Caption>{watchCopy.intro}</Caption>
      {watches.length === 0 ? <Caption>{watchCopy.empty}</Caption> : null}
      {watches.map((w) => (
        <View key={w.id} style={styles.block}>
          <Card>
            <ListRow
              title={w.paused ? `${w.query} · ${watchCopy.paused}` : w.query}
              subtitle={subtitleOf(w, now)}
            />
            <ListRow
              title={watchCopy.mobileData}
              subtitle={watchCopy.mobileDataHint}
              accessory={
                <Toggle
                  value={w.mobileData}
                  onValueChange={(mobileData) => updateWatchInStore(w.id, { mobileData })}
                  accessibilityLabel={`${watchCopy.mobileData} for ${w.query}`}
                />
              }
            />
          </Card>
          <ChipGroup
            label={watchCopy.every}
            options={INTERVALS.map((h) => ({ value: h, label: `${h} h` }))}
            value={w.intervalHours}
            onChange={(intervalHours: IntervalHours) => updateWatchInStore(w.id, { intervalHours })}
          />
          <Button
            label={w.paused ? watchCopy.resume : watchCopy.pause}
            icon={w.paused ? 'play' : 'pause'}
            variant="secondary"
            onPress={() => updateWatchInStore(w.id, { paused: !w.paused })}
          />
          <Button label={watchCopy.delete} icon="trash" variant="danger" onPress={() => confirmDelete(w)} />
        </View>
      ))}
      <Caption>{watchCopy.backgroundNote}</Caption>
    </SettingsPage>
  );
}
