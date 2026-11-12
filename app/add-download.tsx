import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendlyPath } from '../components/settings/SettingsParts';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { maglevEngine, isDownloadLink, isShareOpen, isTorrentSource, normalizeIncoming, type FreeSpace, type UrlProbe } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { triggerHaptic } from '../constants/haptics';
import { Banner, Button, EmptyBlock, Screen } from '../components/ui';
import { admit, pendingNeedOf } from '../utils/admission';
import { actionRoute, probeErrorView } from '../utils/downloadCopy';

/** Add a download from a web link: probe the link, show what it is, then start. */
type Phase = 'input' | 'probing' | 'ready' | 'adding' | 'error';

const INVALID_TEXT = "That isn't a web link. Use a link that starts with http or https.";

export default function AddDownloadScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; source?: string; from?: string }>();
  const { telemetry, defaultStoragePath, probeUrl, startDownload, showNotice } = useMaglevEngine();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<ReturnType<typeof probeErrorView> | null>(null);
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [free, setFree] = useState<FreeSpace | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const token = useRef(0);
  const urlRef = useRef('');
  const allowLanRef = useRef(false);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const submit = useCallback(
    async (raw: string, allowLan = false) => {
      const input = normalizeIncoming(raw);
      // A magnet or a .torrent link is a torrent: hand it to Add torrent instead of refusing it.
      if (isTorrentSource(input)) {
        router.replace({ pathname: '/add-torrent', params: { source: input } });
        return;
      }
      if (!isDownloadLink(input)) {
        setMessage(INVALID_TEXT);
        setPhase('input');
        return;
      }
      const mine = ++token.current;
      urlRef.current = input;
      allowLanRef.current = allowLan;
      setMessage(null);
      setAddError(null);
      setPhase('probing');
      const res = await probeUrl(input, allowLan ? { allowLan: true } : {});
      if (mine !== token.current) return;
      if (res.ok) {
        setProbe(res);
        setPhase('ready');
        triggerHaptic('medium');
        return;
      }
      setProbe(null);
      setErrorView(probeErrorView(res.code, res.message, res.httpStatus));
      setPhase('error');
    },
    [probeUrl, router],
  );

  // The `url` or `source` param (a share, a maglev:// link, or another screen) fills the field.
  // Only a share (`from=share`, set by app/+native-intent.tsx and stripped from every outside link)
  // checks the link at once. Anything else waits for a tap, so a web page or app cannot make the
  // phone fetch a link by opening maglev://add-download.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    const raw = params.url || params.source;
    const incoming = typeof raw === 'string' ? raw.trim() : '';
    if (!incoming || incoming === lastIncoming.current) return;
    lastIncoming.current = incoming;
    const shared = isShareOpen({ url: params.url, from: params.from });
    const clean = normalizeIncoming(incoming);
    if (shared) {
      setText(clean);
      void submit(clean);
      return;
    }
    if (isTorrentSource(clean)) {
      router.replace({ pathname: '/add-torrent', params: { source: clean } });
      return;
    }
    setText(clean);
  }, [params.url, params.source, params.from, submit, router]);

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
      setPhase('input');
      return;
    }
    const link = normalizeIncoming(clip);
    setText(link);
    void submit(link);
  };

  const start = async (fromError = false) => {
    setPhase('adding');
    setAddError(null);
    const res = await startDownload(urlRef.current, allowLanRef.current ? { allowLan: true } : {});
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
    if (fromError) {
      setErrorView({ body: res.message || "Couldn't start this download.", primary: 'retry' });
      setPhase('error');
      return;
    }
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
  if (phase === 'error' && errorView?.primary === 'blocked') {
    return (
      <Screen title="Add download" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title="Waiting for a network"
          body={errorView.body}
          primary={{ label: 'Open settings', onPress: () => router.push(actionRoute('openNetworkSettings') ?? '/settings/network') }}
          secondary={{ label: 'Add anyway', onPress: () => void start(true) }}
        />
      </Screen>
    );
  }
  if (phase === 'error' && errorView?.primary === 'allowDevice') {
    return (
      <Screen title="Add download" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title="A device on your network"
          body={errorView.body}
          primary={{ label: 'Allow this device', onPress: () => void submit(urlRef.current, true) }}
          secondary={{ label: 'Back', onPress: () => setPhase('input') }}
        />
      </Screen>
    );
  }
  if (phase === 'error') {
    return (
      <Screen title="Add download" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title="Couldn't use this link"
          body={errorView?.body}
          primary={
            errorView?.primary === 'pasteAnother'
              ? { label: 'Paste another link', onPress: () => { setText(''); void handlePaste(); } }
              : { label: 'Try again', onPress: () => void submit(urlRef.current) }
          }
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
        <Text style={styles.meta}>Saves to {friendlyPath(defaultStoragePath)}</Text>
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
