import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { haptic } from '../../constants/haptics';
import { Button, Sheet } from '../ui';
import { sharingBadge, sharingWords } from './sharing';

export interface ResultPreview {
  name: string;
  sizeBytes?: number;
  seeders?: number;
  leechers?: number;
  age: string;
  via: string;
  detailUrl?: string;
  added: boolean;
}

export interface ResultPreviewSheetProps {
  result: ResultPreview | null;
  onClose: () => void;
  onAdd: () => void;
  onOpenInBrowser: () => void;
  /** What Share and Copy pass on: a magnet link, a direct file link, or nothing (the buttons hide). */
  linkKind: 'magnet' | 'file' | null;
  /** Gives the link, fetching it first when the list page had none. Rejects on failure or when `signal` aborts. */
  getLink: (signal: AbortSignal) => Promise<string>;
  /** Called after a successful copy. The screen closes the sheet and shows its notice. */
  onCopied: (kind: 'magnet' | 'file') => void;
}

type Action = 'share' | 'copy';

/** A closer look at one result before adding it. */
export function ResultPreviewSheet({ result, onClose, onAdd, onOpenInBrowser, linkKind, getLink, onCopied }: ResultPreviewSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [busy, setBusy] = useState<Action | null>(null);
  const [failed, setFailed] = useState(false);
  // Dots and the "Getting…" line only after a short wait, so a link that is already known doesn't flash them.
  const [slow, setSlow] = useState(false);
  const ctl = useRef<AbortController | null>(null);
  // Set synchronously on the first tap and held until the share sheet closes: two quick taps read the same `busy`
  // state, and `busy` is cleared before the sheet opens, so without this a double tap opened two sheets (phone 2026-11-26).
  const inFlight = useRef(false);
  const open = !!result;
  // Closing the sheet (or showing another result) drops any fetch in flight.
  useEffect(() => {
    return () => {
      ctl.current?.abort();
      ctl.current = null;
      setBusy(null);
      setSlow(false);
      setFailed(false);
    };
  }, [open, result?.name]);

  const run = useCallback(
    async (action: Action) => {
      if (inFlight.current || !linkKind) return;
      inFlight.current = true;
      const wait = new AbortController();
      ctl.current = wait;
      const timer = setTimeout(() => wait.abort(), 15000);
      const slowTimer = setTimeout(() => setSlow(true), 200);
      setBusy(action);
      setFailed(false);
      try {
        const link = await getLink(wait.signal);
        if (ctl.current !== wait) return;
        if (action === 'share') {
          setBusy(null);
          await Share.share({ message: link }).catch(() => {});
        } else {
          await Clipboard.setStringAsync(link);
          haptic('done');
          setBusy(null);
          onCopied(linkKind);
        }
      } catch {
        // A closed sheet cleared `ctl`; only a live attempt (including a 15 s timeout) shows the retry line.
        if (ctl.current === wait) {
          setBusy(null);
          setFailed(true);
        }
      } finally {
        inFlight.current = false;
        clearTimeout(timer);
        clearTimeout(slowTimer);
        setSlow(false);
      }
    },
    [linkKind, getLink, onCopied],
  );

  const noun = linkKind === 'file' ? 'link' : 'magnet link';
  const badge = result ? sharingBadge(result.seeders) : null;
  const lines: [string, string][] = result
    ? [
        ['Size', result.sizeBytes ? formatBytes(result.sizeBytes) : 'Unknown'],
        ['People', sharingWords(result.seeders, result.leechers)],
        ['Source', result.via],
        ['Added', result.age ? `${result.age} ago` : 'Unknown'],
      ]
    : [];
  return (
    <Sheet visible={!!result} onClose={onClose} title={result?.name ?? ''}>
      <View style={styles.stack}>
        {lines.map(([k, v]) => (
          <View key={k} style={styles.line}>
            <Text style={styles.key}>{k}</Text>
            <Text style={styles.value}>{v}</Text>
          </View>
        ))}
        {badge ? <Text style={styles.warn}>{badge}. This may be slow or never finish.</Text> : null}
        <Button label={result?.added ? 'Already added' : 'Add'} icon="download" fullWidth disabled={result?.added} onPress={onAdd} />
        {linkKind || result?.detailUrl ? (
          <View style={styles.row}>
            {linkKind ? (
              <>
                <View style={styles.cell}>
                  <Button label="Share" icon="share" variant="secondary" fullWidth stacked loading={busy === 'share' && slow} disabled={!!busy && busy !== 'share'} accessibilityLabel={`Share ${noun}`} onPress={() => void run('share')} />
                </View>
                <View style={styles.cell}>
                  <Button label="Copy" icon="copy" variant="secondary" fullWidth stacked loading={busy === 'copy' && slow} disabled={!!busy && busy !== 'copy'} accessibilityLabel={`Copy ${noun}`} onPress={() => void run('copy')} />
                </View>
              </>
            ) : null}
            {result?.detailUrl ? (
              <View style={styles.cell}>
                <Button label="Open page" icon="network" variant="secondary" fullWidth stacked accessibilityLabel="Open source page in browser" onPress={onOpenInBrowser} />
              </View>
            ) : null}
          </View>
        ) : null}
        {busy && slow ? <Text style={styles.note}>Getting the {noun}…</Text> : failed ? <Text style={styles.fail}>Couldn't get the {noun}. Try again.</Text> : null}
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    line: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
    key: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    value: { ...type.mono, fontSize: type.size.md, color: c.text, flexShrink: 1, textAlign: 'right' },
    row: { flexDirection: 'row', gap: spacing.sm },
    cell: { flex: 1, minWidth: 0 },
    note: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    fail: { ...type.body, fontSize: type.size.md, color: c.danger },
    warn: { ...type.body, fontSize: type.size.md, color: c.warning },
  });
