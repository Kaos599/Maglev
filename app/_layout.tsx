import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { EngineProvider } from '../context/EngineContext';
import { TOKENS } from '../constants/tokens';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <EngineProvider>
        <StatusBar style="light" backgroundColor={TOKENS.colors.bgOled} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: TOKENS.colors.bgOled },
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
      </EngineProvider>
    </SafeAreaProvider>
  );
}
