import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import type { DownloadSnapshot, EngineResult } from 'maglev-engine';
import { isDownloadLink, normalizeIncoming } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { actionRoute, downloadActions, downloadCaption, removeCopy } from '../../utils/downloadCopy';
import { Banner, Button, Sheet } from '../ui';

export interface DownloadSheetProps {
  /** The download to act on, or null when the sheet is closed. */
  download: DownloadSnapshot | null;
  onClose: () => void;
  onRetry: (id: string) => void;
  onRemove: (id: string, deleteFiles: boolean) => void;
  onNewLink: (id: string, url: string) => Promise<EngineResult>;
}

type Step = 'main' | 'confirmDelete';

/** What a tap on a download card opens: details, Retry or Restart, Paste new link, Remove (SM-30 Copy). */
export function DownloadSheet({ download: d, onClose, onRetry, onRemove, onNewLink }: DownloadSheetProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [step, setStep] = useState<Step>('main');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const id = d?.id ?? null;
  useEffect(() => {
    setStep('main');
    setLink('');
    setLinkError(null);
    setBusy(false);
  }, [id]);

  if (!d) return <Sheet visible={false} onClose={onClose} title="" />;

  const copy = removeCopy(d);
  const actions = downloadActions(d);
  const caption = downloadCaption(d);
  const size = d.size ? formatBytes(d.size) : 'Size unknown';
  const subtitle = `${d.urlDisplay} · ${size}`;

  const applyLink = async (raw: string) => {
    const text = normalizeIncoming(raw);
    if (!isDownloadLink(text)) {
      setLinkError("That isn't a web link.");
      return;
    }
    setBusy(true);
    setLinkError(null);
    const res = await onNewLink(d.id, text);
    setBusy(false);
    if (res.ok) onClose();
    else setLinkError(res.code === 'FILE_CHANGED' ? 'That link is a different file.' : res.message || "Couldn't use that link.");
  };

  const pasteLink = async () => {
    let clip = '';
    try {
      clip = (await Clipboard.getStringAsync()).trim();
    } catch {
      clip = '';
    }
    if (!clip) {
      setLinkError('Your clipboard is empty.');
      return;
    }
    setLink(clip);
    void applyLink(clip);
  };

  if (step === 'confirmDelete') {
    return (
      <Sheet
        visible
        onClose={onClose}
        title={d.state === 'finished' ? 'Delete the file?' : 'Delete the partial file?'}
        subtitle={d.downloaded > 0 ? `This permanently deletes ${formatBytes(d.downloaded)} from your device.` : 'This removes the download.'}
      >
        <View style={styles.stack}>
          <Button label="Delete" variant="danger" icon="trash" fullWidth onPress={() => { onRemove(d.id, true); onClose(); }} />
          <Button label="Cancel" variant="ghost" fullWidth onPress={onClose} />
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet visible onClose={onClose} title={d.name} subtitle={subtitle}>
      <View style={styles.stack}>
        {d.notice ? <Banner tone="info" title={d.notice} /> : null}
        {d.state === 'needs_link' ? (
          <View style={styles.stack}>
            <Text style={styles.label}>Paste a new link to the same file</Text>
            <TextInput
              value={link}
              onChangeText={(t) => {
                setLink(t);
                setLinkError(null);
              }}
              placeholder="https://…"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="go"
              onSubmitEditing={() => void applyLink(link)}
              style={[styles.field, linkError ? styles.fieldInvalid : null]}
              accessibilityLabel="New link"
            />
            {linkError ? <Text style={styles.error}>{linkError}</Text> : null}
            <Button label="Paste" icon="clipboard" variant="secondary" fullWidth loading={busy} onPress={() => void pasteLink()} />
            <Button label="Use this link" fullWidth disabled={!link.trim() || busy} onPress={() => void applyLink(link)} />
          </View>
        ) : null}
        {caption ? <Text style={styles.hint}>{caption}</Text> : null}
        {d.state === 'error' || d.state === 'paused'
          ? actions
              .filter((a) => a.kind !== 'remove' && a.kind !== 'resume')
              .map((a, i) => (
                <Button
                  key={a.kind}
                  label={a.label}
                  icon={a.icon}
                  variant={i === 0 ? 'primary' : 'secondary'}
                  fullWidth
                  onPress={() => {
                    const route = actionRoute(a.kind);
                    if (route) router.push(route);
                    else onRetry(d.id);
                    onClose();
                  }}
                />
              ))
          : null}
        <Text style={styles.hint}>{copy.subtitle}</Text>
        <Button label={copy.keepLabel} variant="secondary" fullWidth onPress={() => { onRemove(d.id, false); onClose(); }} />
        <Button label={copy.deleteLabel} variant="danger" icon="trash" fullWidth onPress={() => setStep('confirmDelete')} />
        <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    label: { ...type.bodyStrong, fontSize: type.size.md, color: c.textMuted },
    field: {
      ...type.mono,
      fontSize: type.size.md,
      color: c.text,
      minHeight: 44,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
    },
    fieldInvalid: { borderColor: c.danger },
    error: { ...type.body, fontSize: 13, color: c.danger },
    hint: { ...type.body, fontSize: 13, color: c.textMuted, marginTop: spacing.sm },
  });
