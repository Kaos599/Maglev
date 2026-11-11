import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { maglevEngine, type ResolveActivity } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, ProgressBar } from '../ui';
import { PixelIcon } from '../PixelIcon';

/** NATIVE_CONTRACT 12.1: the secondary action appears after this long. */
const START_NOW_AFTER_MS = 5000;
const POLL_MS = 1000;

interface Props {
  /** 40-char info-hash of the magnet being resolved, or null for sources that show no activity. */
  infoHash: string | null;
  /** True once the user tapped Start now and the cancel plus add are running. */
  starting: boolean;
  onStartNow: () => void;
  onCancel: () => void;
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Resolving block of the Add screen (UI_SPEC S9). Polls what the engine can see, never guesses. */
export function ResolveProgress({ infoHash, starting, onStartNow, onCancel }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [activity, setActivity] = useState<ResolveActivity | null | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const clockTimer = setInterval(() => setElapsed(Date.now() - startedAt), POLL_MS);
    let alive = true;
    const poll = () => {
      if (!infoHash) return;
      maglevEngine
        .getResolveActivity(infoHash)
        .then((res) => {
          if (alive) setActivity(res.ok ? res : null);
        })
        .catch(() => {
          if (alive) setActivity(null);
        });
    };
    poll();
    const pollTimer = infoHash ? setInterval(poll, POLL_MS) : null;
    return () => {
      alive = false;
      clearInterval(clockTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [infoHash]);

  let line: string | null = null;
  if (infoHash && activity !== undefined) {
    line = activity && activity.dht ? `Looking for peers · ${activity.peersFound} found` : 'Asking trackers…';
  }
  const showStartNow = !!infoHash && elapsed >= START_NOW_AFTER_MS;

  return (
    <View style={styles.centered} accessibilityLiveRegion="polite">
      <Text style={styles.heading}>Getting torrent info…</Text>
      <View style={styles.loadingBar}>
        <ProgressBar indeterminate accessibilityLabel="Getting torrent info" />
      </View>
      {line ? (
        <View style={styles.row}>
          <PixelIcon name={activity && activity.dht ? 'peers' : 'network'} size={16} color={colors.textMuted} />
          <Text style={styles.body}>{line}</Text>
        </View>
      ) : null}
      <View style={styles.row}>
        <PixelIcon name="clock" size={16} color={colors.textMuted} />
        <Text style={styles.timer} accessibilityLabel={`${Math.floor(elapsed / 1000)} seconds`}>{clock(elapsed)}</Text>
      </View>
      <Text style={styles.body}>This can take up to a minute for magnet links.</Text>
      {showStartNow ? (
        <Button label="Start now, choose files later" variant="secondary" loading={starting} onPress={onStartNow} />
      ) : null}
      <Button label="Cancel" variant="ghost" disabled={starting} onPress={onCancel} />
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, paddingHorizontal: spacing.xxxl },
    heading: { ...type.bodyStrong, fontSize: type.size.xl, color: c.text, textAlign: 'center' },
    loadingBar: { width: '70%' },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    body: { ...type.body, fontSize: type.size.md, color: c.textMuted, textAlign: 'center' },
    timer: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
