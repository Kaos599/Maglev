import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsProvider, useSettings } from '../context/SettingsContext';
import { EngineProvider } from '../context/EngineContext';
import { TOKENS } from '../constants/tokens';

function AppNavigation() {
  const { backgroundColor } = useSettings();

  return (
    <>
      <StatusBar style="light" backgroundColor={backgroundColor} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="add-torrent"
          options={{
            presentation: 'modal',
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="torrent/[id]"
          options={{
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <EngineProvider>
          <AppNavigation />
        </EngineProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
