import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, SplashScreen, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useFonts } from 'expo-font';
import { SettingsProvider, useSettings } from '../context/SettingsContext';
import { ThemeProvider, useTheme } from '../context/ThemeContext';
import { EngineProvider, useMaglevEngine } from '../context/EngineContext';
import { FONT_NAMES } from '../constants/fontStyles';
import NavigationBarSync from '../components/NavigationBarSync';
import { NoticeHost } from '../components/ui/NoticeHost';
import { syncScheduleToNative } from '../utils/prefs/schedule';
import { syncFeedAutomationToNative } from '../utils/prefs/feedAutomation';
import { initHistory } from '../utils/history';
import { installGlobalHandler, setCurrentRoute } from '../utils/crashLog';

// Record uncaught JS errors on this phone, then let React Native handle them as before.
installGlobalHandler();

/** A route crash anywhere keeps the tab bar only if the tab has its own boundary; this one is the last resort. */
export { ErrorBoundary } from '../components/ErrorScreen';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Safety net: if init never settles, stop waiting on the splash and show the engine error. */
const ENGINE_RESOLVE_TIMEOUT_MS = 15000;

/**
 * Screens a launch link can open that call the engine as soon as they mount (a shared magnet or
 * .torrent, a shared web link, a notification's torrent). Launched straight into one of these, the
 * app waits for the engine as before instead of painting the cached shell, so the link is handled
 * once the engine can answer rather than failing with "Engine not started" (the bridge does not
 * queue calls made before start).
 */
const ENGINE_FIRST_ROUTE = /^\/(add-torrent|add-download|torrent\/)/;

function AppNavigation() {
  const { colors, dark } = useTheme();
  const { settings } = useSettings();
  const { engineStatus, hasCachedList } = useMaglevEngine();
  const [timedOut, setTimedOut] = useState(false);
  // Decided once, from the route the app was launched into: a later link must never unmount the shell.
  const pathname = usePathname();
  useEffect(() => setCurrentRoute(pathname ?? ''), [pathname]);
  const [launchNeedsEngine] = useState(() => ENGINE_FIRST_ROUTE.test(pathname ?? ''));

  // The bridge reports 'starting' until init settles to 'ready' or 'unavailable'.
  const starting = engineStatus.kind === 'starting';
  // UI spec S10.3: an onboarded user with a saved list (even an empty one) sees it at once while the
  // engine starts; EngineProvider starts the engine right after that first frame.
  const cachedBoot = starting && !timedOut && settings.onboarded && hasCachedList && !launchNeedsEngine;
  const resolved = !starting || timedOut || cachedBoot;

  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => setTimedOut(true), ENGINE_RESOLVE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [starting]);

  useEffect(() => {
    if (resolved) SplashScreen.hideAsync().catch(() => {});
  }, [resolved]);

  // H4 cold start: open history, then wipe or prune. Never blocks render; the History screen waits on it itself.
  useEffect(() => {
    initHistory().catch(() => {});
  }, []);

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
          {/*
            Every other route is declared here too, with the Stack defaults. A route left out of every
            guard is never guarded, and expo-router sends a blocked launch to the first unguarded route
            in file order (not this order): on a fresh install that opened the browser instead of
            onboarding (0.12). scripts/test-route-guards.js keeps every route inside a guard.
          */}
          <Stack.Screen name="add-download" />
          <Stack.Screen name="browser" />
          <Stack.Screen name="browser-history" />
          <Stack.Screen name="free-space" />
          <Stack.Screen name="settings/about" />
          <Stack.Screen name="settings/assistant" />
          <Stack.Screen name="settings/backup" />
          <Stack.Screen name="settings/bandwidth" />
          <Stack.Screen name="settings/browser" />
          <Stack.Screen name="settings/feeds" />
          <Stack.Screen name="settings/interface" />
          <Stack.Screen name="settings/network" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="settings/power" />
          <Stack.Screen name="settings/queue" />
          <Stack.Screen name="settings/scheduling" />
          <Stack.Screen name="settings/search-providers" />
          <Stack.Screen name="settings/speed" />
          <Stack.Screen name="settings/storage" />
          <Stack.Screen name="settings/watch" />
        </Stack.Protected>
      </Stack>
      {main ? <NoticeHost /> : null}
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    [FONT_NAMES.silkscreen]: require('@expo-google-fonts/silkscreen/400Regular/Silkscreen_400Regular.ttf'),
    [FONT_NAMES.spaceMono]: require('@expo-google-fonts/space-mono/400Regular/SpaceMono_400Regular.ttf'),
    [FONT_NAMES.spaceMonoBold]: require('@expo-google-fonts/space-mono/700Bold/SpaceMono_700Bold.ttf'),
    [FONT_NAMES.inter]: require('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
    [FONT_NAMES.interMedium]: require('@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf'),
    [FONT_NAMES.interSemiBold]: require('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
    [FONT_NAMES.interBold]: require('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf'),
  });

  // Native splash stays visible until fonts load; AppNavigation hides it once the engine resolves.
  // A font that fails to load must not keep the splash up forever: carry on with the system font.
  if (!fontsLoaded && !fontError) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SettingsProvider>
          <ThemeProvider>
            <EngineProvider>
              <AppNavigation />
            </EngineProvider>
          </ThemeProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
