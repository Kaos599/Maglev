import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { ThemeColors, spacing, type } from '../constants/theme';
import { highlightCopy } from '../constants/copy';
import type { Highlight } from '../constants/highlights';
import { Button, Sheet } from './ui';
import { PixelIcon } from './PixelIcon';
import { highlightPlan, isPlainLaunch } from '../utils/highlights';
import { getLastSeenVersion, setLastSeenVersion } from '../utils/prefs/highlights';
import { useUpdatePrefs } from '../utils/prefs/update';

const INSTALLED = Constants.expoConfig?.version ?? '';

/**
 * Tells whether this process started from a plain launch. A share, magnet, file or deep link hands the app a URL
 * at start (or while it runs): the highlight then waits for the next plain launch (docs/NATIVE_CONTRACT.md 37.2).
 * `null` while the start URL is still unknown.
 */
function usePlainLaunch(): boolean | null {
  const [plain, setPlain] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void Linking.getInitialURL()
      .then((url) => alive && setPlain((prev) => (prev === false ? false : isPlainLaunch(url))))
      .catch(() => alive && setPlain((prev) => (prev === false ? false : true)));
    // A link that arrives while the app runs counts too: this launch wasn't a plain one.
    const sub = Linking.addEventListener('url', () => setPlain(false));
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return plain;
}

/**
 * The new-feature sheet (section 37). Mounted once at the app root, after onboarding. On a plain launch it shows
 * the newest entry between the last seen and the installed version; any way of closing it records the installed
 * version. With no entry (or the switch off) the version moves forward without a sound.
 */
export function HighlightSheet() {
  const { settings } = useSettings();
  const [prefs] = useUpdatePrefs();
  const router = useRouter();
  const plain = usePlainLaunch();
  const [shown, setShown] = useState<Highlight | null>(null);
  const [decided, setDecided] = useState(false);
  const onboarded = settings.onboarded;

  useEffect(() => {
    if (decided || plain !== true || !onboarded || !INSTALLED) return;
    setDecided(true);
    const plan = highlightPlan(INSTALLED, getLastSeenVersion(), false, prefs.showHighlights);
    if (plan.show) setShown(plan.show.highlight);
    else if (plan.advanceSilently) setLastSeenVersion(INSTALLED);
  }, [decided, plain, onboarded, prefs.showHighlights]);

  const close = useCallback(() => {
    setLastSeenVersion(INSTALLED);
    setShown(null);
  }, []);
  const tryIt = useCallback(() => {
    const route = shown?.tryRoute;
    close();
    if (route) router.push(route as never);
  }, [shown, close, router]);
  const notes = useCallback(() => {
    close();
    router.push('/settings/whats-new' as never);
  }, [close, router]);

  return shown ? <Body highlight={shown} onTry={tryIt} onNotNow={close} onNotes={notes} /> : null;
}

function Body({ highlight, onTry, onNotNow, onNotes }: { highlight: Highlight; onTry: () => void; onNotNow: () => void; onNotes: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Sheet visible onClose={onNotNow} title={highlight.title} testID="highlight-sheet">
      <View style={s.body}>
        <View style={s.tile}>
          <PixelIcon name={highlight.icon} size={24} color={colors.accentText} />
        </View>
        <Text style={s.text}>{highlight.body}</Text>
        <Button label={highlight.tryLabel} onPress={onTry} />
        <Button label={highlightCopy.notNow} variant="secondary" onPress={onNotNow} />
        <Button label={highlightCopy.allNotes} variant="ghost" onPress={onNotes} />
        <Text style={s.footer}>{highlightCopy.footer}</Text>
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    tile: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, backgroundColor: c.surfaceRaised, marginBottom: spacing.xs },
    text: { ...type.body, fontSize: 15, color: c.text, marginBottom: spacing.sm },
    footer: { ...type.body, fontSize: 12, color: c.textMuted, textAlign: 'center', marginTop: spacing.xs },
  });
