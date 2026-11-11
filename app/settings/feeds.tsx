import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { Screen, EmptyBlock } from '../../components/ui';

export default function FeedsSettings() {
  const router = useRouter();
  return (
    <Screen title="FEEDS" onBack={() => router.back()} edges={['top', 'left', 'right', 'bottom']}>
      <Stack.Screen options={{ headerShown: false }} />
      <EmptyBlock
        icon="feeds"
        title="Feeds are managed in the Feeds tab"
        body="Add, remove and refresh feeds there."
        primary={{ label: 'Open Feeds', onPress: () => router.navigate('/(tabs)/feeds') }}
      />
    </Screen>
  );
}
