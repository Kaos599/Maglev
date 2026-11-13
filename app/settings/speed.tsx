import React from 'react';
import { Stack } from 'expo-router';
import { SectionHeader } from '../../components/ui';
import { SettingsPage } from '../../components/settings/SettingsParts';
import { SpeedSection } from '../../components/settings/SpeedSection';
import { QueueSection } from '../../components/settings/QueueSection';

export default function SpeedSettings() {
  return (
    <SettingsPage title="Speed & queue">
      <Stack.Screen options={{ headerShown: false }} />
      <SectionHeader title="Speed" />
      <SpeedSection />
      <SectionHeader title="Queue" />
      <QueueSection />
    </SettingsPage>
  );
}
