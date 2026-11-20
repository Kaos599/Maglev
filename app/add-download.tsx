import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChipGroup, friendlyPath } from '../components/settings/SettingsParts';
import { DownloadParts, PART_CHOICES, useLinkDownloadPrefs } from '../utils/prefs/linkDownloads';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { maglevEngine, infoHashToMagnet, isDownloadLink, isShareOpen, isTorrentSource, normalizeIncoming, type UrlProbe } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { haptic } from '../constants/haptics';
import { StreamSheet } from '../components/browser/StreamSheet';
import { streamKindOfLink } from '../components/browser/streamChoice';
import type { FoundItem } from 'maglev-engine';
import { Banner, Button, EmptyBlock, Screen, TextField } from '../components/ui';
import { useDownloadAdmission } from '../utils/useDownloadAdmission';
import { actionRoute, probeErrorView } from '../utils/downloadCopy';
import { banners, empty, mobileDataLine, notices } from '../constants/copy';
import { pickFolderForThisDownload } from '../utils/downloadFolder';
import { useSettings } from '../context/SettingsContext';
import { START_ENGINE_LABEL, engineStoppedBody, isEngineStopped } from '../utils/addErrorNotice';
import { openBrowser } from '../utils/browser/openBrowser';
import { fileKind } from '../utils/fileKind';
import { SubtitlesAutoRow, useSubtitlesAuto } from '../components/search/SubtitlesAutoRow';
import { askSubtitles, markNotThisOne } from '../utils/subtitles/requests';
import { buildAsk } from '../utils/addedTray';
import { joinTrayIfShowing } from '../components/search/AddedTray';

/** Add a download from a web link: probe the link, show what it is, then start. */
type Phase = 'input' | 'probing' | 'ready' | 'adding' | 'error';

/** Splits "movie.final.mp4" into "movie.final" and ".mp4". A leading dot or a long tail is not an extension. */
function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0 || name.length - i > 9 || /\s/.test(name.slice(i))) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

const INVALID_TEXT = "That isn't a web link. Use a link that starts with http or https.";

const PART_OPTIONS: { value: DownloadParts; label: string }[] = PART_CHOICES.map((n) => ({ value: n, label: String(n) }));

export default function AddDownloadScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string; source?: string; from?: string }>();
  const { defaultStoragePath, probeUrl, probeStream, startDownload, showNotice, onMeteredNetwork, restartEngine } = useMaglevEngine();
  const { settings } = useSettings();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [errorView, setErrorView] = useState<ReturnType<typeof probeErrorView> | null>(null);
  const [probe, setProbe] = useState<UrlProbe | null>(null);
  const [notAFile, setNotAFile] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addStopped, setAddStopped] = useState(false);
  const [folderLabel, setFolderLabel] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [streamItem, setStreamItem] = useState<FoundItem | null>(null);
  const [baseName, setBaseName] = useState('');
  // Parts default to the Settings > Downloads pref; the chips below override it for this download only.
  const [linkPrefs] = useLinkDownloadPrefs();
  const [partsOverride, setPartsOverride] = useState<DownloadParts | null>(null);
  const parts: DownloadParts = partsOverride ?? linkPrefs.downloadParts;
  const token = useRef(0);
  const urlRef = useRef('');
  // NATIVE_CONTRACT 44.5 and 44.12: a video link gets the Subtitles row.
  const fullName = probe ? baseName.trim() + splitName(probe.name).ext : '';
  const subs = useSubtitlesAuto(!!probe && fileKind(fullName || probe.name) === 'video');
  const allowLanRef = useRef(false);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.dismissTo('/');
  }, [router]);

  const submit = useCallback(
    async (raw: string, allowLan = false) => {
      const input = normalizeIncoming(raw);
      // A magnet or a .torrent link is a torrent: hand it to Add torrent instead of refusing it.
      if (isTorrentSource(input)) {
        router.replace({ pathname: '/add-torrent', params: { source: input } });
        return;
      }
      // A bare info hash (40 hex or 32 base32) is a torrent too.
      const hashMagnet = infoHashToMagnet(input);
      if (hashMagnet) {
        router.replace({ pathname: '/add-torrent', params: { source: hashMagnet } });
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
  // or the Add torrent hand-off (`from=add-torrent`) checks the link at once. Anything else waits for a tap, so a web page or app cannot make the
  // phone fetch a link by opening maglev://add-download.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    const raw = params.url || params.source;
    const incoming = typeof raw === 'string' ? raw.trim() : '';
    if (!incoming || incoming === lastIncoming.current) return;
    lastIncoming.current = incoming;
    const shared = isShareOpen({ url: params.url, from: params.from });
    const clean = normalizeIncoming(incoming);
    // Add torrent hands a plain web link over with `from=add-torrent` (also stripped from outside links):
    // the user already tapped Get info there, so run it once here instead of asking again.
    const handoff = params.from === 'add-torrent' && isDownloadLink(clean);
    if (shared || handoff) {
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
  const { doesntFit, noSpace } = useDownloadAdmission(probe?.size ?? null, phase === 'ready');

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

  // "Change" picks a folder for this download only: the path goes to startDownload and the default folder is untouched.
  const handleChangeFolder = async () => {
    haptic('tap');
    try {
      const res = await pickFolderForThisDownload(() => maglevEngine.pickFolder());
      if (res.kind === 'cancelled') return;
      if (res.kind === 'unsupported') {
        setAddError(notices.inline.folderNotDirect);
        return;
      }
      setFolderPath(res.path);
      setFolderLabel(res.label);
    } catch {
      setAddError(notices.inline.folderPickerFailed);
    }
  };

  const nameInvalid = baseName.trim().length === 0 || /[\\/]/.test(baseName);
  const nameError = nameInvalid ? (baseName.trim().length === 0 ? 'Enter a file name.' : "A file name can't contain a slash.") : null;

  const start = async (fromError = false) => {
    setPhase('adding');
    setAddError(null);
    setAddStopped(false);
    const renamed = !fromError && probe && !nameInvalid && baseName.trim() + splitName(probe.name).ext !== probe.name
      ? baseName.trim() + splitName(probe.name).ext
      : null;
    const res = await startDownload(urlRef.current, {
      ...(allowLanRef.current ? { allowLan: true } : {}),
      ...(renamed ? { name: renamed } : {}),
      ...(folderPath ? { folder: folderPath } : {}),
      segments: parts,
    });
    if (res.ok) {
      haptic('commit');
      if (probe && subs.show) {
        const ask = buildAsk({ infoHash: '', key: `d:${res.id}`, name: renamed ?? probe.name, sizeBytes: probe.size ?? undefined });
        // A link added while the Added message is on screen joins it (44.12); otherwise Auto asks on its own.
        const joined = joinTrayIfShowing({ hash: ask.key, name: renamed ?? probe.name, ask, auto: subs.on });
        if (!joined && subs.on) askSubtitles([ask], { auto: true });
        // 44.15 D4: Settings auto is on and this screen's switch is off: "not this one".
        else if (!joined && !subs.on && subs.settingsOn) markNotThisOne([ask]);
      }
      router.dismissTo('/');
      return;
    }
    if (res.code === 'DUPLICATE') {
      showNotice({ message: notices.addDownload.duplicate });
      router.dismissTo('/');
      return;
    }
    haptic('fail');
    const stopped = isEngineStopped(res);
    const reason = stopped ? engineStoppedBody(res) : res.message;
    if (fromError) {
      setErrorView({ body: reason || "Couldn't start this download.", primary: 'retry' });
      setPhase('error');
      return;
    }
    setAddStopped(stopped);
    setAddError(reason || notices.inline.startDownloadFailed);
    setPhase('ready');
  };

  // ---------- Probing ----------
  if (phase === 'probing') {
    return (
      <Screen title="Add a link" onBack={close}>
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
      <Screen title="Add a link" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          // BLOCKED comes from Wi-Fi only or from the VPN rule; only the first is "waiting for Wi-Fi".
          title={settings.network.wifiOnly ? empty.addDownload.waitingForNetwork.title : 'Blocked by your network settings'}
          body={errorView.body}
          primary={{ label: 'Open settings', onPress: () => router.push(actionRoute('openNetworkSettings') ?? '/settings/network') }}
          secondary={{ label: 'Add anyway', onPress: () => void start(true) }}
        />
      </Screen>
    );
  }
  if (phase === 'error' && errorView?.primary === 'allowDevice') {
    return (
      <Screen title="Add a link" onBack={close}>
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
      <Screen title="Add a link" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title={empty.addDownload.badLink.title}
          body={errorView?.body}
          primary={
            notAFile
              ? { label: 'Open in browser', onPress: () => openBrowser(router, { url: urlRef.current }, 'replace') }
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
      <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
        <TextField
          value={baseName}
          onChangeText={setBaseName}
          editable={!adding}
          mono
          multiline
          minLines={1}
          size="lg"
          trailing={splitName(probe.name).ext ? <Text style={styles.ext}>{splitName(probe.name).ext}</Text> : null}
          error={nameError ?? undefined}
          accessibilityLabel="File name"
        />
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
        {subs.show ? <SubtitlesAutoRow on={subs.on} onChange={subs.setOn} disabled={adding} /> : null}
        {subs.node}
        <ChipGroup label="Parts" options={PART_OPTIONS} value={parts} onChange={(v) => setPartsOverride(v)} />
        {mobileNote ?<Banner tone="info" title={mobileNote} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={noSpace} /> : null}
        {addError ? (
          addStopped ? (
            <Banner
              tone="danger"
              title={empty.engineStopped.title}
              body={addError}
              actionLabel={START_ENGINE_LABEL}
              onAction={() => void restartEngine().then((ok) => { if (ok) void start(); })}
            />
          ) : (
            <Banner tone="danger" title={addError} />
          )
        ) : null}
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
    <Screen title="Add a link" onBack={close} scroll contentStyle={styles.content}>
      <TextField
        label="Link to a file"
        value={text}
        onChangeText={onChangeText}
        placeholder="https://…"
        mono
        multiline
        minLines={3}
        returnKeyType="go"
        onSubmitEditing={() => canSubmit && void submit(text)}
        error={message ?? undefined}
        accessibilityLabel="Link to a file"
      />
      <View style={styles.actions}>
        <Button label="Paste" icon="clipboard" variant="secondary" onPress={() => void handlePaste()} />
      </View>
      <View style={styles.gap}>
        <Button label="Get info" size="lg" fullWidth disabled={!canSubmit} onPress={() => void submit(text)} />
      </View>
      <StreamSheet item={streamItem} onClose={() => setStreamItem(null)} onStarted={() => { setStreamItem(null); close(); }} onCopyLink={(u) => { void Clipboard.setStringAsync(u); }} />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.md },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    gap: { marginTop: spacing.sm },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, paddingHorizontal: spacing.xxxl },
    heading: { ...type.bodyStrong, fontSize: type.size.xl, color: c.text, textAlign: 'center' },
    ext: { ...type.mono, fontSize: type.size.lg, lineHeight: Math.round(type.size.lg * 1.4), color: c.textMuted },
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
