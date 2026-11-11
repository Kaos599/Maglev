import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { SettingsProvider, useSettings } from '../context/SettingsContext';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import { EngineProvider, useMaglevEngine } from '../context/EngineContext';
import { fontFamily } from '../constants/theme';
import NavigationBarSync from '../components/NavigationBarSync';
import { syncScheduleToNative } from '../utils/prefs/schedule';
import { syncFeedAutomationToNative } from '../utils/prefs/feedAutomation';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Safety net: if init never settles, stop waiting on the splash and show the engine error. */
const ENGINE_RESOLVE_TIMEOUT_MS = 15000;

function AppNavigation() {
  const { colors, dark } = useTheme();
  const { settings } = useSettings();
  const { engineStatus, telemetry } = useMaglevEngine();
  const [timedOut, setTimedOut] = useState(false);

  // The bridge reports 'starting' until init settles to 'ready' or 'unavailable'.
  const starting = engineStatus.kind === 'starting';
  // UI spec S10.3: an onboarded user with a cached list sees it at once while the engine starts.
  const cachedBoot = starting && !timedOut && settings.onboarded && telemetry.torrents.some((t) => t.lastKnown);
  const resolved = !starting || timedOut || cachedBoot;

  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => setTimedOut(true), ENGINE_RESOLVE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [starting]);

  useEffect(() => {
    if (resolved) SplashScreen.hideAsync().catch(() => {});
  }, [resolved]);

  // Push the saved schedule and feed rules to Kotlin once the engine is up.
  const engineReady = engineStatus.kind === 'ready';
  useEffect(() => {
    if (!engineReady) return;
    void syncScheduleToNative();
    void syncFeedAutomationToNative();
  }, [engineReady]);

  // Native splash stays up (see preventAutoHideAsync); render the background only, no navigator, until resolved.
  if (!resolved) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;

  const unavailable = engineStatus.kind === 'unavailable' || (starting && !cachedBoot);
  const onboarding = !unavailable && !settings.onboarded;
  const main = !unavailable && settings.onboarded;

  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <NavigationBarSync />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          // Android duration is fixed by the animation XML (animationDuration is iOS-only in react-native-screens 4.30).
          // 'ios_from_right' is directional and uses config_shortAnimTime (~200 ms); 'slide_from_right' uses config_mediumAnimTime (~400 ms).
          animation: 'ios_from_right',
          gestureEnabled: true,
        }}
      >
        <Stack.Protected guard={unavailable}>
          <Stack.Screen name="engine-error" options={{ gestureEnabled: false, animation: 'none' }} />
        </Stack.Protected>
        <Stack.Protected guard={onboarding}>
          <Stack.Screen name="onboarding" options={{ gestureEnabled: false, animation: 'fade' }} />
        </Stack.Protected>
        <Stack.Protected guard={main}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="add-torrent"
            options={{
              presentation: 'modal',
              animation: 'slide_from_bottom',
              headerShown: false,
            }}
          />
          <Stack.Screen
            name="torrent/[id]"
            options={{
              animation: 'ios_from_right',
              gestureEnabled: true,
              headerShown: false,
            }}
          />
        </Stack.Protected>
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

  // Native splash stays visible until fonts load; AppNavigation hides it once the engine resolves.
  if (!fontsLoaded) return null;

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
