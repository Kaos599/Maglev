import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { SettingsProvider } from '../context/SettingsContext';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import { EngineProvider } from '../context/EngineContext';
import { buildColors, DEFAULT_ACCENT, DEFAULT_MODE, fontFamily } from '../constants/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function AppNavigation() {
  const { colors, dark } = useTheme();

  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: 'slide_from_right',
          animationDuration: 200, // Snappy 200ms screen switch
          gestureEnabled: true,
        }}
      >
        <Stack.Screen
          name="(tabs)"
          options={{
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="add-torrent"
          options={{
            presentation: 'modal',
            animation: 'slide_from_bottom',
            animationDuration: 220,
            headerShown: false,
          }}
        />
        <Stack.Screen
          name="torrent/[id]"
          options={{
            animation: 'slide_from_right',
            animationDuration: 200,
            gestureEnabled: true,
            headerShown: false,
          }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    [fontFamily.brand]: require('@expo-google-fonts/silkscreen/400Regular/Silkscreen_400Regular.ttf'),
    [fontFamily.mono]: require('@expo-google-fonts/space-mono/400Regular/SpaceMono_400Regular.ttf'),
    [fontFamily.monoBold]: require('@expo-google-fonts/space-mono/700Bold/SpaceMono_700Bold.ttf'),
    [fontFamily.body]: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
    [fontFamily.bodyStrong]: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
  });

  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    const boot = buildColors(DEFAULT_MODE, DEFAULT_ACCENT);
    return (
      <View style={{ flex: 1, backgroundColor: boot.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={boot.accent} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ThemeProvider>
          <EngineProvider>
            <AppNavigation />
          </EngineProvider>
        </ThemeProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
