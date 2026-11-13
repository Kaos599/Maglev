import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';
import { DEFAULT_ACCENT, ThemeColors, buildColors, radius, spacing } from '../constants/theme';
import { errorScreenCopy } from '../constants/copy';
import { ICON_PATHS, ICON_VIEWBOX } from './icons.generated';
import { copyCrashReport, recordCrash } from '../utils/crashLog';

/**
 * Fallback for a route that crashed. expo-router renders it in place of the route (see
 * https://docs.expo.dev/router/error-handling/), so it can run outside the app's providers:
 * it reads the system colour scheme itself and draws its own icon instead of reading the theme context.
 */
const crisp = { shapeRendering: 'crispEdges' } as object;

export function ErrorScreen({ error, retry }: { error: Error; retry: () => void | Promise<void> }) {
  const scheme = useColorScheme();
  const colors = useMemo(() => buildColors(scheme === 'light' ? 'light' : 'oled', DEFAULT_ACCENT), [scheme]);
  const s = useMemo(() => makeStyles(colors), [colors]);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const logged = useRef<Error | null>(null);

  useEffect(() => {
    if (logged.current === error) return;
    logged.current = error;
    recordCrash(error, { source: 'boundary' });
  }, [error]);

  const onCopy = async () => setCopied((await copyCrashReport()) ? 'done' : 'failed');

  return (
    <SafeAreaView style={s.root} testID="error-screen">
      <View style={s.tile}>
        <Svg width={48} height={48} viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} {...crisp}>
          <Path d={ICON_PATHS.warning} fill={colors.danger} />
        </Svg>
      </View>
      <Text style={s.title} accessibilityRole="header">{errorScreenCopy.title}</Text>
      <Text style={s.body}>{errorScreenCopy.body}</Text>
      <Button colors={colors} label={errorScreenCopy.reload} primary onPress={() => void retry()} />
      <Button
        colors={colors}
        label={copied === 'done' ? errorScreenCopy.copied : copied === 'failed' ? errorScreenCopy.copyFailed : errorScreenCopy.copy}
        onPress={onCopy}
      />
    </SafeAreaView>
  );
}

function Button({ colors, label, onPress, primary }: { colors: ThemeColors; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minHeight: 44,
        minWidth: 200,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.xl,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: primary ? colors.accent : colors.border,
        backgroundColor: primary ? colors.accent : colors.surface,
      }}
    >
      <Text style={{ color: primary ? colors.onAccent : colors.text, fontSize: 15, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.md },
    tile: { width: 80, height: 80, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, borderRadius: radius.lg, marginBottom: spacing.sm },
    title: { color: c.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
    body: { color: c.textMuted, fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: spacing.md },
  });

/** The export expo-router looks for in a route file. */
export const ErrorBoundary = ErrorScreen;

export default ErrorScreen;
