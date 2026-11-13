import React from 'react';
import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import { useMaglevEngine } from '../../context/EngineContext';
import { ListRow } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';

/** Live Updates (promoted notifications) exist from Android 16 (API 36). */
const LIVE_UPDATES_API = 36;

export default function NotificationSettings() {
  const { permissionStatus, openLiveUpdateSettings } = useMaglevEngine();
  const showLiveUpdates = Platform.OS === 'android' && Number(Platform.Version) >= LIVE_UPDATES_API;
  const liveUpdatesOn = permissionStatus?.liveUpdates === 'granted';

  return (
    <SettingsPage title="Notifications">
      <Stack.Screen options={{ headerShown: false }} />
      {Platform.OS === 'android' ? (
        <Card>
          <ListRow
            title="Finished-download alerts"
            subtitle="Choose sound and banners in Android settings."
            onPress={() => void maglevEngine.openNotificationSettings('completed')}
            accessibilityHint="Opens Android settings"
          />
        </Card>
      ) : null}
      {showLiveUpdates ? (
        <Card>
          <ListRow
            title="Live progress in status bar"
            subtitle="Shows download progress at the top of your screen."
            value={liveUpdatesOn ? 'On' : 'Off'}
            onPress={() => void openLiveUpdateSettings()}
            accessibilityHint="Opens Android settings"
          />
        </Card>
      ) : null}
    </SettingsPage>
  );
}
