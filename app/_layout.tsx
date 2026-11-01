import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
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
  const [fontsLoaded] = useFonts({
    Silkscreen: require('@expo-google-fonts/silkscreen/400Regular/Silkscreen_400Regular.ttf'),
    SilkscreenBold: require('@expo-google-fonts/silkscreen/700Bold/Silkscreen_700Bold.ttf'),
    SpaceMono: require('@expo-google-fonts/space-mono/400Regular/SpaceMono_400Regular.ttf'),
    SpaceMonoBold: require('@expo-google-fonts/space-mono/700Bold/SpaceMono_700Bold.ttf'),
    JetBrainsMono: require('@expo-google-fonts/jetbrains-mono/400Regular/JetBrainsMono_400Regular.ttf'),
    JetBrainsMonoBold: require('@expo-google-fonts/jetbrains-mono/700Bold/JetBrainsMono_700Bold.ttf'),
    Inter: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
    InterBold: require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
  });

  if (!fontsLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: TOKENS.colors.bgOled, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={TOKENS.colors.accentLime} size="large" />
      </View>
    );
  }

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
