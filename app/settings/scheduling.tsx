import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Screen, EmptyBlock } from '../../components/ui';

export default function SchedulingSettings() {
  const router = useRouter();
  return (
    <Screen title="SCHEDULING" onBack={() => router.back()} edges={['top', 'left', 'right', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <EmptyBlock icon="schedule" title="Coming soon" body="Scheduled downloads and speed limits by time of day aren't available yet." />
    </Screen>
  );
}
