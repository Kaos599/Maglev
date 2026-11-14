import React, { useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { FloatingSheet } from './browser/FloatingSheet';
import { Button } from './ui';
import { REPO_URL } from './settings/StarTicket';
import { useMaglevEngine } from '../context/EngineContext';
import { useSettings } from '../context/SettingsContext';
import { starCopy } from '../constants/copy';
import { spacing } from '../constants/theme';
import { anyOverlayOpen } from '../utils/overlayTracker';
import { ensureFirstSeen, getStarState, updateStarState } from '../utils/prefs/star';
import { STAR_DELAY_MS, afterCompleted, afterNever, afterNotNow, afterStarred, shouldAskForStar } from '../utils/star';

/**
 * Asks happy people for a GitHub star (docs/NATIVE_CONTRACT.md section 33). Mounted once at the app root.
 * A finished transfer starts a 2 s wait (so its notice shows first); the card then appears if every gate holds,
 * at most once per app session.
 */
export function StarPrompt() {
  const { lastCompleted } = useMaglevEngine();
  const { settings } = useSettings();
  const [visible, setVisible] = useState(false);
  const shown = useRef(false);
  const seen = useRef(lastCompleted);
  const onboardedRef = useRef(settings.onboarded);
  onboardedRef.current = settings.onboarded;

  useEffect(() => {
    ensureFirstSeen();
  }, []);

  useEffect(() => {
    if (!lastCompleted || lastCompleted === seen.current) return;
    seen.current = lastCompleted;
    updateStarState(afterCompleted);
    const t = setTimeout(() => {
      const ok = shouldAskForStar(getStarState(), Date.now(), {
        onboarding: !onboardedRef.current,
        overlayOpen: anyOverlayOpen(),
        browserLoading: false,
        shownThisSession: shown.current,
        foreground: AppState.currentState === 'active',
      });
      if (!ok) return;
      shown.current = true;
      setVisible(true);
    }, STAR_DELAY_MS);
    return () => clearTimeout(t);
  }, [lastCompleted]);

  const close = () => setVisible(false);
  const notNow = () => {
    updateStarState((s) => afterNotNow(s, Date.now()));
    close();
  };
  const never = () => {
    updateStarState(afterNever);
    close();
  };
  const star = () => {
    void Linking.openURL(REPO_URL);
    updateStarState(afterStarred);
    close();
  };

  return (
    <FloatingSheet visible={visible} onClose={notNow} title={starCopy.title} subtitle={starCopy.body} testID="star-prompt">
      <View style={styles.actions}>
        <Button label={starCopy.star} icon="github" onPress={star} />
        <Button label={starCopy.notNow} variant="secondary" onPress={notNow} />
        <Button label={starCopy.never} variant="ghost" onPress={never} />
      </View>
    </FloatingSheet>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
});
