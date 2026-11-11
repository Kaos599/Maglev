import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { maglevEngine, isDownloadLink, type FreeSpace, type UrlProbe } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { triggerHaptic } from '../constants/haptics';
import { Banner, Button, EmptyBlock, Screen } from '../components/ui';
import { admit, pendingNeedOf } from '../utils/admission';

/** Add a download from a web link: probe the link, show what it is, then start. */
type Phase = 'input' | 'probing' | 'ready' | 'adding' | 'error';

const INVALID_TEXT = "That isn't a web link. Use a link that starts with http or https.";

export default function AddDownloadScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; source?: string }>();
  const { telemetry, defaultStoragePath, probeUrl, startDownload, showNotice } = useMaglevEngine();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [free, setFree] = useState<FreeSpace | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const token = useRef(0);
  const urlRef = useRef('');

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const submit = useCallback(
    async (raw: string) => {
      const input = raw.trim();
      if (!isDownloadLink(input)) {
        setMessage(INVALID_TEXT);
        setPhase('input');
        return;
      }
      const mine = ++token.current;
      urlRef.current = input;
      setMessage(null);
      setAddError(null);
      setPhase('probing');
      const res = await probeUrl(input);
      if (mine !== token.current) return;
      if (res.ok) {
        setProbe(res);
        setPhase('ready');
        triggerHaptic('medium');
        return;
      }
      setProbe(null);
      setMessage(res.message || 'Something went wrong.');
      setPhase('error');
    },
    [probeUrl],
  );

  // The `url` param (share, or the torrent screen) fills the field and starts at once.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    const raw = params.url || params.source;
    const incoming = typeof raw === 'string' ? raw.trim() : '';
    if (!incoming || incoming === lastIncoming.current) return;
    lastIncoming.current = incoming;
    setText(incoming);
    void submit(incoming);
  }, [params.url, params.source, submit]);

  // Free space refreshes when the preview opens.
  const probed = phase === 'ready' ? probe?.name : null;
  useEffect(() => {
    if (!probed) return;
    let alive = true;
    maglevEngine
      .getFreeSpace()
      .then((res) => {
        if (alive) setFree(res.ok ? res : null);
      })
      .catch(() => {
        if (alive) setFree(null);
      });
    return () => {
      alive = false;
    };
  }, [probed]);

  const onChangeText = (next: string) => {
    token.current++;
    setText(next);
    setMessage(null);
    setProbe(null);
    setPhase('input');
  };

  const handlePaste = async () => {
    triggerHaptic('light');
    let clip = '';
    try {
      clip = (await Clipboard.getStringAsync()).trim();
    } catch {
      clip = '';
    }
    if (!clip) {
      setMessage('Your clipboard is empty.');
      return;
    }
    setText(clip);
    void submit(clip);
  };

  const start = async () => {
    setPhase('adding');
    setAddError(null);
    const res = await startDownload(urlRef.current, {});
    if (res.ok) {
      triggerHaptic('success');
      router.replace('/');
      return;
    }
    if (res.code === 'DUPLICATE') {
      showNotice({ message: 'This link is already in your downloads.' });
      router.replace('/');
      return;
    }
    triggerHaptic('error');
    setAddError(res.message || "Couldn't start this download.");
    setPhase('ready');
  };

  // ---------- Probing ----------
  if (phase === 'probing') {
    return (
      <Screen title="Add download" onBack={close}>
        <View style={styles.centered}>
          <Text style={styles.heading}>Checking the link…</Text>
          <Button label="Cancel" variant="ghost" onPress={() => { token.current++; setPhase('input'); }} />
        </View>
      </Screen>
    );
  }

  // ---------- Error ----------
  if (phase === 'error') {
    return (
      <Screen title="Add download" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title="Couldn't use this link"
          body={message ?? undefined}
          primary={{ label: 'Try again', onPress: () => void submit(urlRef.current) }}
          secondary={{ label: 'Back', onPress: () => setPhase('input') }}
        />
      </Screen>
    );
  }

  // ---------- Ready ----------
  if ((phase === 'ready' || phase === 'adding') && probe) {
    const adding = phase === 'adding';
    const size = probe.size;
    const freeBytes = free ? Math.min(free.freeBytes, free.targetFreeBytes ?? free.freeBytes) : null;
    const outcome =
      freeBytes !== null && size
        ? admit({
            freeBytes,
            pendingNeed: pendingNeedOf(telemetry.torrents),
            stagingFactor: free?.mode === 'staging' ? 2 : 1,
            selectionBytes: size,
          })
        : null;
    const doesntFit = outcome?.result === 'DoesntFit';
    return (
      <Screen title="Add download" onBack={close} scroll contentStyle={styles.content}>
        <Text style={styles.name} numberOfLines={3}>{probe.name}</Text>
        <Text style={styles.meta}>{size != null ? formatBytes(size) : 'Size unknown'}</Text>
        <Text style={styles.meta} numberOfLines={2}>{probe.urlDisplay}</Text>
        <Text style={styles.meta}>
          {probe.resumable ? 'You can pause and resume this one.' : "This server can't resume. It starts over if it stops."}
        </Text>
        <Text style={styles.meta}>Saves to {defaultStoragePath}</Text>
        {doesntFit ? <Banner tone="danger" title="Not enough space" body="Free up some storage, then try again." /> : null}
        {addError ? <Banner tone="danger" title={addError} /> : null}
        <View style={styles.gap}>
          <Button label="Start" size="lg" fullWidth loading={adding} disabled={adding || doesntFit} onPress={() => void start()} />
        </View>
      </Screen>
    );
  }

  // ---------- Input ----------
  const canSubmit = text.trim().length > 0;
  return (
    <Screen title="Add download" onBack={close} scroll contentStyle={styles.content}>
      <Text style={styles.label}>Link to a file</Text>
      <TextInput
        value={text}
        onChangeText={onChangeText}
        placeholder="https://…"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={() => canSubmit && void submit(text)}
        multiline
        style={[styles.field, message ? styles.fieldInvalid : null]}
        accessibilityLabel="Link to a file"
      />
      {message ? <Banner tone="danger" title={message} /> : null}
      <View style={styles.actions}>
        <Button label="Paste" icon="clipboard" variant="secondary" onPress={() => void handlePaste()} />
      </View>
      <View style={styles.gap}>
        <Button label="Get info" size="lg" fullWidth disabled={!canSubmit} onPress={() => void submit(text)} />
      </View>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.md },
    label: { ...type.bodyStrong, fontSize: type.size.md, color: c.textMuted },
    field: {
      ...type.mono,
      fontSize: type.size.md,
      color: c.text,
      minHeight: 96,
      textAlignVertical: 'top',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    fieldInvalid: { borderColor: c.danger },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    gap: { marginTop: spacing.sm },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, paddingHorizontal: spacing.xxxl },
    heading: { ...type.bodyStrong, fontSize: type.size.xl, color: c.text, textAlign: 'center' },
    name: { ...type.mono, fontSize: type.size.lg, color: c.text },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
