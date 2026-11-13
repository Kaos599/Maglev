import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { friendlyPath } from '../components/settings/SettingsParts';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { maglevEngine, isDownloadLink, isShareOpen, isTorrentSource, normalizeIncoming, type UrlProbe } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { haptic } from '../constants/haptics';
import { StreamSheet } from '../components/browser/StreamSheet';
import { streamKindOfLink } from '../components/browser/streamChoice';
import type { FoundItem } from 'maglev-engine';
import { Banner, Button, EmptyBlock, Screen } from '../components/ui';
import { useDownloadAdmission } from '../utils/useDownloadAdmission';
import { actionRoute, probeErrorView } from '../utils/downloadCopy';
import { banners, empty, mobileDataLine, notices } from '../constants/copy';
import { useSettings } from '../context/SettingsContext';

/** Add a download from a web link: probe the link, show what it is, then start. */
type Phase = 'input' | 'probing' | 'ready' | 'adding' | 'error';

/** Splits "movie.final.mp4" into "movie.final" and ".mp4". A leading dot or a long tail is not an extension. */
function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0 || name.length - i > 9 || /\s/.test(name.slice(i))) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

const INVALID_TEXT = "That isn't a web link. Use a link that starts with http or https.";

export default function AddDownloadScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; source?: string; from?: string }>();
  const { defaultStoragePath, probeUrl, probeStream, startDownload, showNotice, onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<ReturnType<typeof probeErrorView> | null>(null);
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [notAFile, setNotAFile] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [streamItem, setStreamItem] = useState<FoundItem | null>(null);
  const [baseName, setBaseName] = useState('');
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
      // An .m3u8 or .mpd link is a stream: offer the same quality sheet the browser uses.
      // When the probe says it is not a stream, carry on as a plain file.
      const streamKind = streamKindOfLink(input);
      if (streamKind) {
        const sp = await probeStream(input, allowLan ? { allowLan: true } : {});
        if (mine !== token.current) return;
        if (sp.ok || (sp.code ?? '').toUpperCase().startsWith('STREAM_')) {
          setStreamItem({
            id: input, url: input, kind: 'video', mime: null, ext: streamKind === 'hls' ? 'm3u8' : 'mpd',
            name: '', size: null, width: null, height: null, source: 'page', stream: streamKind, pageUrl: '', pageTitle: '',
          });
          setPhase('input');
          return;
        }
      }
      const res = await probeUrl(input, allowLan ? { allowLan: true } : {});
      if (mine !== token.current) return;
      if (res.ok) {
        setProbe(res);
        setBaseName(splitName(res.name).base);
        setPhase('ready');
        return;
      }
      setProbe(null);
      setNotAFile((res.code ?? '').toUpperCase() === 'NOT_A_FILE');
      setErrorView(probeErrorView(res.code, res.message, res.httpStatus));
      setPhase('error');
    },
    [probeUrl, probeStream, router],
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
  const { doesntFit } = useDownloadAdmission(probe?.size ?? null, phase === 'ready');

  const onChangeText = (next: string) => {
    token.current++;
    setText(next);
    setMessage(null);
    setProbe(null);
    setPhase('input');
  };

  const handlePaste = async () => {
    haptic('tap');
    let clip = '';
    try {
      clip = (await Clipboard.getStringAsync()).trim();
    } catch {
      clip = '';
    }
    if (!clip) {
      setMessage(notices.inline.clipboardEmpty);
      setPhase('input');
      return;
    }
    const link = normalizeIncoming(clip);
    setText(link);
    void submit(link);
  };

  // The picked folder is stored by the engine as the active target, and EngineHost.addDownload
  // fills `folder` from it, so nothing is passed to startDownload (same as Add torrent).
  const handleChangeFolder = async () => {
    haptic('tap');
    try {
      const res = await maglevEngine.pickDownloadFolder();
      if ('cancelled' in res) return;
      setFolderLabel(res.displayName);
    } catch {
      setAddError(notices.inline.folderPickerFailed);
    }
  };

  const nameInvalid = baseName.trim().length === 0 || /[\\/]/.test(baseName);
  const nameError = nameInvalid ? (baseName.trim().length === 0 ? 'Enter a file name.' : "A file name can't contain a slash.") : null;

  const start = async (fromError = false) => {
    setPhase('adding');
    setAddError(null);
    const renamed = !fromError && probe && !nameInvalid && baseName.trim() + splitName(probe.name).ext !== probe.name
      ? baseName.trim() + splitName(probe.name).ext
      : null;
    const res = await startDownload(urlRef.current, {
      ...(allowLanRef.current ? { allowLan: true } : {}),
      ...(renamed ? { name: renamed } : {}),
    });
    if (res.ok) {
      haptic('commit');
      router.replace('/');
      return;
    }
    if (res.code === 'DUPLICATE') {
      showNotice({ message: notices.addDownload.duplicate });
      router.replace('/');
      return;
    }
    haptic('fail');
    if (fromError) {
      setErrorView({ body: res.message || "Couldn't start this download.", primary: 'retry' });
      setPhase('error');
      return;
    }
    setAddError(res.message || notices.inline.startDownloadFailed);
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
          title={empty.addDownload.waitingForNetwork.title}
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
          title={empty.addDownload.deviceOnNetwork.title}
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
          title={empty.addDownload.badLink.title}
          body={errorView?.body}
          primary={
            notAFile
              ? { label: 'Open in browser', onPress: () => router.replace({ pathname: '/browser', params: { url: urlRef.current } }) }
              : errorView?.primary === 'pasteAnother'
                ? { label: 'Paste another link', onPress: () => { setText(''); void handlePaste(); } }
                : { label: 'Try again', onPress: () => void submit(urlRef.current) }
          }
          secondary={
            notAFile
              ? { label: 'Paste another link', onPress: () => { setText(''); void handlePaste(); } }
              : { label: 'Back', onPress: () => setPhase('input') }
          }
        />
      </Screen>
    );
  }

  // ---------- Ready ----------
  if ((phase === 'ready' || phase === 'adding') && probe) {
    const adding = phase === 'adding';
    const size = probe.size;
    const mobileNote = mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, size);
    return (
      <Screen title="Add download" onBack={close} scroll contentStyle={styles.content}>
        <View style={[styles.nameRow, nameInvalid ? styles.fieldInvalid : null]}>
          <TextInput
            value={baseName}
            onChangeText={setBaseName}
            editable={!adding}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            multiline
            style={styles.nameInput}
            accessibilityLabel="File name"
          />
          {splitName(probe.name).ext ? <Text style={styles.ext}>{splitName(probe.name).ext}</Text> : null}
        </View>
        {nameError ? <Text style={styles.nameError}>{nameError}</Text> : null}
        <Text style={styles.meta}>{size != null ? formatBytes(size) : 'Size unknown'}</Text>
        <Text style={styles.meta} numberOfLines={2}>{probe.urlDisplay}</Text>
        <Text style={styles.meta}>
          {probe.resumable ? 'You can pause and resume this one.' : "This server can't resume. It starts over if it stops."}
        </Text>
        <View style={styles.destRow}>
          <View style={styles.destText}>
            <Text style={styles.meta}>Save to</Text>
            <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`Save to ${friendlyPath(folderLabel ?? defaultStoragePath)}`}>
              {friendlyPath(folderLabel ?? defaultStoragePath)}
            </Text>
          </View>
          <Button label="Change" variant="secondary" disabled={adding} onPress={() => void handleChangeFolder()} />
        </View>
        {mobileNote ? <Banner tone="info" title={mobileNote} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={banners.addDownload.notEnoughSpace.body} /> : null}
        {addError ? <Banner tone="danger" title={addError} /> : null}
        <View style={styles.gap}>
          <Button label="Start" size="lg" fullWidth loading={adding} disabled={adding || doesntFit || nameInvalid} onPress={() => void start()} />
          <Button label="Cancel" variant="ghost" size="lg" fullWidth disabled={adding} onPress={close} />
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
      <StreamSheet item={streamItem} onClose={() => { setStreamItem(null); close(); }} onCopyLink={(u) => { void Clipboard.setStringAsync(u); }} />
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
    nameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.borderStrong,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      minHeight: touch.min,
    },
    nameInput: { ...type.mono, fontSize: type.size.lg, color: c.text, flexShrink: 1, flexGrow: 1, paddingVertical: spacing.sm },
    ext: { ...type.mono, fontSize: type.size.lg, color: c.textMuted },
    nameError: { ...type.body, fontSize: type.size.sm, color: c.danger },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    destRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      padding: spacing.md,
      minHeight: touch.min,
    },
    destText: { flex: 1 },
    dest: { ...type.mono, fontSize: type.size.md, color: c.text, marginTop: 2 },
  });
