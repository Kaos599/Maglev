import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, ListRow, Sheet, Toggle } from '../ui';
import type { FollowTarget } from '../../utils/follow';
import { getFeedAutomation } from '../../utils/prefs/feedAutomation';
import { commitFollow } from './followAction';

export interface FollowSheetProps {
  target: FollowTarget | null;
  onClose: () => void;
  /** Called after the show was saved (or was already followed). */
  onDone: (target: FollowTarget, status: 'followed' | 'already') => void;
}

const SOURCE_NOTE = {
  anime: 'Maglev watches Nyaa for new episodes of this show.',
  tv: "Maglev watches EZTV's latest releases. An episode posted during a very busy hour can be missed.",
} as const;

/** Confirm sheet for "Follow this". Automatic download starts off. */
export function FollowSheet({ target, onClose, onDone }: FollowSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAuto(false);
    setBusy(false);
    setError(null);
  }, [target]);

  const globalOff = !getFeedAutomation().enabled;

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    const out = await commitFollow(target, auto);
    setBusy(false);
    if (out.ok) onDone(target, out.status);
    else setError(out.message);
  };

  return (
    <Sheet visible={!!target} onClose={onClose} title={target ? `Follow ${target.title}?` : 'Follow'} subtitle="New episodes appear in Feeds.">
      {target ? (
        <View style={styles.body}>
          <Text style={styles.note}>{SOURCE_NOTE[target.kind]}</Text>
          <ListRow
            title="Download new episodes automatically"
            subtitle={auto && globalOff ? 'This also turns on automatic downloads for feeds.' : undefined}
            accessory={<Toggle value={auto} onValueChange={setAuto} accessibilityLabel="Download new episodes automatically" />}
          />
          {error ? (
            <Text style={styles.error} accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Button label={busy ? 'Following…' : 'Follow'} fullWidth onPress={submit} disabled={busy} />
            <Button label="Cancel" variant="secondary" fullWidth onPress={onClose} />
          </View>
        </View>
      ) : null}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.md },
    note: { ...type.body, fontSize: 13, lineHeight: 18, color: c.textMuted },
    error: { ...type.body, fontSize: 13, color: c.danger },
    actions: { gap: spacing.sm },
  });
