import React from 'react';
import { Stack } from 'expo-router';
import { SectionHeader } from '../../components/ui';
import { SettingsPage } from '../../components/settings/SettingsParts';
import { SpeedSection } from '../../components/settings/SpeedSection';
import { QueueSection } from '../../components/settings/QueueSection';
import { RetrySection } from '../../components/settings/RetrySection';
import { PartsSection } from '../../components/settings/PartsSection';

export default function SpeedSettings() {
  return (
    <SettingsPage title="Speed & queue">
      <Stack.Screen options={{ headerShown: false }} />
      <SectionHeader title="Speed" />
      <SpeedSection />
      <SectionHeader title="Queue" />
      <QueueSection />
      <SectionHeader title="Parts" />
      <PartsSection />
      <SectionHeader title="Retry" />
      <RetrySection />
    </SettingsPage>
  );
}
