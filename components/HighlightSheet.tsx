import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useTheme } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { ThemeColors, motion, radius, spacing, type } from '../constants/theme';
import { highlightCopy } from '../constants/copy';
import { HIGHLIGHTS, type Highlight } from '../constants/highlights';
import Animated from 'react-native-reanimated';
import { Button, Dialog } from './ui';
import { DIALOG_GUTTER, DIALOG_MAX_WIDTH } from './ui/Dialog';
import { PixelIcon } from './PixelIcon';
import { Station } from './highlight/Station';
import { useEntrance, useStagger } from './highlight/useEntrance';
import { cardAt, scrimAt } from './highlight/timeline';
import { cardUnit } from './highlight/timing';
import { highlightPlan, isPlainLaunch } from '../utils/highlights';
import { getLastSeenVersion, setLastSeenVersion } from '../utils/prefs/highlights';
import { useUpdatePrefs } from '../utils/prefs/update';

/** Closing fades and shrinks the card a little over this long. */
const EXIT_MS = motion.duration.exit;

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
 * The new-feature dialog (section 37). Mounted once at the app root, after onboarding. On a plain launch it shows
 * the newest entry between the last seen and the installed version; any way of closing it records the installed
 * version. With no entry (or the switch off) the version moves forward without a sound.
 */
export function HighlightSheet() {
  const { settings } = useSettings();
  const [prefs] = useUpdatePrefs();
  const router = useRouter();
  const plain = usePlainLaunch();
  const [shown, setShown] = useState<{ highlight: Highlight; version: string; open: boolean } | null>(null);
  const [decided, setDecided] = useState(false);
  const onboarded = settings.onboarded;

  useEffect(() => {
    if (decided || plain !== true || !onboarded || !INSTALLED) return;
    setDecided(true);
    const plan = highlightPlan(INSTALLED, getLastSeenVersion(), false, prefs.showHighlights);
    if (plan.show) setShown({ highlight: plan.show.highlight, version: plan.show.version, open: true });
    else if (plan.advanceSilently) setLastSeenVersion(INSTALLED);
  }, [decided, plain, onboarded, prefs.showHighlights]);

  // Closing records the version and starts the exit; the dialog reports back when it is gone and only then is it dropped.
  const close = useCallback(() => {
    setLastSeenVersion(INSTALLED);
    setShown((cur) => (cur ? { ...cur, open: false } : cur));
  }, []);
  const gone = useCallback(() => setShown(null), []);
  const tryIt = useCallback(() => {
    if (!shown?.open) return; // already closing: a second tap does nothing
    const route = shown.highlight.tryRoute;
    close();
    if (route) router.push(route as never);
  }, [shown, close, router]);
  const notes = useCallback(() => {
    if (!shown?.open) return;
    close();
    router.push('/settings/whats-new' as never);
  }, [shown, close, router]);

  return shown ? <Body highlight={shown.highlight} version={shown.version} open={shown.open} onExited={gone} onTry={tryIt} onNotNow={close} onNotes={notes} /> : null;
}

function Body({ highlight, version, open, onExited, onTry, onNotNow, onNotes }: { highlight: Highlight; version: string; open: boolean; onExited: () => void; onTry: () => void; onNotNow: () => void; onNotes: () => void }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  // 1% of the design's phone width in points: the card is 86 of those, so the station and the motion scale with it.
  const cq = cardUnit(width, DIALOG_MAX_WIDTH, DIALOG_GUTTER);
  const { clock } = useEntrance(open);
  const intro = useMemo(() => ({ clock, unit: cq, card: cardAt, scrim: scrimAt }), [clock, cq]);
  // The entrance only fades and moves things; every button is tappable from the first frame.
  const iconIn = useStagger(clock, 0, cq);
  const titleIn = useStagger(clock, 1, cq);
  const bodyIn = useStagger(clock, 2, cq);
  const tryIn = useStagger(clock, 3, cq);
  const laterIn = useStagger(clock, 4, cq);
  const notesIn = useStagger(clock, 5, cq);
  return (
    <Dialog
      visible={open}
      onClose={onNotNow}
      intro={intro}
      exitMs={EXIT_MS}
      onExited={onExited}
      title={highlight.title}
      titleStyle={titleIn}
      testID="highlight-sheet"
      hero={
        <>
          <Station version={version} clock={clock} cq={cq} />
          <Animated.View style={[s.tile, iconIn]}>
            <PixelIcon name={highlight.icon} size={24} color={colors.accentText} />
          </Animated.View>
        </>
      }
      actions={
        <>
          <Animated.View style={tryIn}><Button label={highlight.tryLabel} onPress={onTry} fullWidth /></Animated.View>
          <Animated.View style={laterIn}><Button label={highlightCopy.notNow} variant="secondary" onPress={onNotNow} fullWidth /></Animated.View>
          <Animated.View style={notesIn}><Button label={highlightCopy.allNotes} variant="ghost" onPress={onNotes} fullWidth /></Animated.View>
        </>
      }
    >
      <Animated.View style={bodyIn}>
        <Text style={s.text}>{highlight.body}</Text>
        <Text style={s.footer}>{highlightCopy.footer}</Text>
      </Animated.View>
    </Dialog>
  );
}

/** The highlight as it looks after an update, with no launch or version checks, for review on web or in a dev build. Closing it offers to show it again. */
export function HighlightPreview({ version = '0.30' }: { version?: string }) {
  const [open, setOpen] = useState(true);
  const [gone, setGone] = useState(false);
  const [run, setRun] = useState(0);
  const highlight = HIGHLIGHTS[version];
  const { colors } = useTheme();
  const close = useCallback(() => setOpen(false), []);
  const exited = useCallback(() => setGone(true), []);
  if (!highlight) return null;
  return !gone ? (
    <Body key={run} highlight={highlight} version={version} open={open} onExited={exited} onTry={close} onNotNow={close} onNotes={close} />
  ) : (
    <View style={{ padding: spacing.lg, backgroundColor: colors.bg }}>
      <Button label="Show again" onPress={() => { setRun((n) => n + 1); setOpen(true); setGone(false); }} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    tile: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border, borderRadius: radius.md, backgroundColor: c.surfaceRaised, marginBottom: spacing.md },
    text: { ...type.body, fontSize: type.size.lg, color: c.text },
    footer: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginTop: spacing.sm },
  });
