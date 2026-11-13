import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { maglevEngine, isDownloadLink, parseSource, type FilePriority, type FreeSpace, type Metadata } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { haptic } from '../constants/haptics';
import { Banner, Button, Chip, EmptyBlock, Screen } from '../components/ui';
import { ResolveProgress } from '../components/add/ResolveProgress';
import { AddFileRow } from '../components/add/AddFileRow';
import { SpaceStrip } from '../components/add/SpaceStrip';
import { PrioritySheet } from '../components/detail/PrioritySheet';
import { fileExt } from '../components/detail/torrentLabels';
import { admit, pendingNeedOf, type AdmissionOutcome } from '../utils/admission';
import { admissionCaption } from '../utils/admissionCopy';
import { takePrefetchedMetadata } from '../components/search/metadataCache';
import { banners, empty, mobileDataLine, notices } from '../constants/copy';
import { useSettings } from '../context/SettingsContext';

/** SM-9 add flow states. */
type Phase = 'input' | 'validating' | 'invalid' | 'resolving' | 'timeout' | 'error' | 'duplicate' | 'preview' | 'adding' | 'added';

const RESOLVE_TIMEOUT_MS = 60_000;
const INVALID_TEXT = "That isn't a magnet link, torrent file or web link.";
/** Android hands VIEW intents over as file:// or content:// URIs; Kotlin reads both. */
const LOCAL_SOURCE = /^(file|content):\/\//i;
/** The same file with its scheme stripped on the way in: an absolute path ending in .torrent. */
const BARE_TORRENT_PATH = /^\/[^?#]*\.torrent$/i;

interface Folder {
  uri: string;
  label: string;
}

/** Last two path segments ("Download/Maglev"), so long storage paths stay on one line. */
function friendlyFolder(path: string): string {
  const parts = path.replace(/^[a-z]+:\/\//i, '').split(/[\/:]/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/') || path;
}

export default function AddTorrentScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ source?: string; uri?: string; magnet?: string }>();
  const { telemetry, defaultStoragePath, showNotice, onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dupId, setDupId] = useState<string | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [freeSpace, setFreeSpace] = useState<FreeSpace | null>(null);
  /** Files marked "Download first". Skip is an unchecked file. */
  const [firsts, setFirsts] = useState<Set<number>>(new Set());
  const [prioIndex, setPrioIndex] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  /** The string handed to the engine: a magnet, a URL, or a cached .torrent path. */
  const sourceRef = useRef<string>('');
  const fromFileRef = useRef(false);
  const token = useRef(0);

  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const finishAdded = useCallback(
    (id: string) => {
      setPhase('added');
      haptic('commit');
      router.replace({ pathname: '/torrent/[id]', params: { id } });
    },
    [router],
  );

  const showDuplicate = useCallback((id: string | null) => {
    setDupId(id);
    setPhase('duplicate');
  }, []);

  const resolve = useCallback(
    async (source: string) => {
      const mine = ++token.current;
      sourceRef.current = source;
      setMessage(null);
      setAddError(null);
      setPhase('resolving');
      let res;
      const began = Date.now();
      try {
        // Search may have read this magnet's file list already (or be reading it): use that read.
        const early = takePrefetchedMetadata(source);
        res = early ? await early : await maglevEngine.resolveMetadata(source, RESOLVE_TIMEOUT_MS);
        // The background read gives up sooner than this screen; keep looking for the rest of the wait.
        if (early && !res.ok && res.code === 'METADATA_TIMEOUT' && mine === token.current) {
          res = await maglevEngine.resolveMetadata(source, Math.max(1_000, RESOLVE_TIMEOUT_MS - (Date.now() - began)));
        }
      } catch (e) {
        if (mine !== token.current) return;
        setMessage(e instanceof Error ? e.message : notices.addTorrent.addFailed);
        setPhase('error');
        return;
      }
      if (mine !== token.current) return;
      if (res.ok) {
        if (telemetry.torrents.some((t) => t.id === res.infoHash)) {
          showDuplicate(res.infoHash);
          return;
        }
        setMeta(res);
        setSelected(new Set(res.files.map((f) => f.index)));
        setFirsts(new Set());
        setPhase('preview');
        return;
      }
      switch (res.code) {
        case 'CANCELLED':
          // The user chose Start now or Cancel; the screen already moved on.
          break;
        case 'DUPLICATE':
          showDuplicate(res.id ?? null);
          break;
        case 'INVALID_SOURCE':
          setMessage(INVALID_TEXT);
          setPhase('invalid');
          break;
        case 'METADATA_TIMEOUT':
          setPhase('timeout');
          break;
        default:
          setMessage(res.message || notices.addTorrent.addFailed);
          setPhase('error');
      }
    },
    [showDuplicate, telemetry.torrents],
  );

  const submit = useCallback(
    (raw: string, fromFile = false) => {
      const input = raw.trim();
      setPhase('validating');
      if (fromFile) {
        fromFileRef.current = true;
        void resolve(input);
        return;
      }
      fromFileRef.current = false;
      if (LOCAL_SOURCE.test(input) || BARE_TORRENT_PATH.test(input)) {
        // A .torrent handed over by another app. The engine reads the path or content URI itself.
        fromFileRef.current = true;
        void resolve(BARE_TORRENT_PATH.test(input) ? `file://${input}` : input);
        return;
      }
      // A plain web link (not a .torrent) is a download from a link: hand it to that flow.
      if (isDownloadLink(input)) {
        router.replace({ pathname: '/add-download', params: { url: input } });
        return;
      }
      const parsed = parseSource(input);
      if (!parsed) {
        setMessage(INVALID_TEXT);
        setPhase('invalid');
        return;
      }
      if (parsed.kind === 'magnet' && telemetry.torrents.some((t) => t.id === parsed.infoHash)) {
        showDuplicate(parsed.infoHash);
        return;
      }
      void resolve(input);
    },
    [resolve, router, showDuplicate, telemetry.torrents],
  );

  // The `source` param prefills the input and resolves. A new value (a second intent while this
  // screen is open) discards the old state and starts over.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    const raw = params.source || params.uri || params.magnet;
    const incoming = typeof raw === 'string' ? raw.trim() : '';
    if (!incoming || incoming === lastIncoming.current) return;
    lastIncoming.current = incoming;
    token.current++;
    setMeta(null);
    setSelected(new Set());
    setFirsts(new Set());
    setFreeSpace(null);
    setDupId(null);
    setAddError(null);
    setMessage(null);
    setText(incoming);
    submit(incoming);
  }, [params.source, params.uri, params.magnet, submit]);

  // Free space refreshes when the preview opens and whenever the folder changes.
  const previewHash = meta?.infoHash;
  useEffect(() => {
    if (!previewHash) return;
    let alive = true;
    maglevEngine
      .getFreeSpace()
      .then((res) => {
        if (alive) setFreeSpace(res.ok ? res : null);
      })
      .catch(() => {
        if (alive) setFreeSpace(null);
      });
    return () => {
      alive = false;
    };
  }, [previewHash, folder?.uri]);

  const onChangeText = (next: string) => {
    token.current++;
    fromFileRef.current = false;
    setText(next);
    setMessage(null);
    setMeta(null);
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
      setPhase('invalid');
      return;
    }
    setText(clip);
    submit(clip);
  };

  const handlePickFile = async () => {
    haptic('tap');
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/x-bittorrent', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.length) return;
      const asset = res.assets[0];
      setText(asset.name);
      if (!/\.torrent$/i.test(asset.name)) {
        setMessage(INVALID_TEXT);
        setPhase('invalid');
        return;
      }
      // The engine reads an absolute path; the picker already copied the file into the cache.
      submit(decodeURI(asset.uri.replace(/^file:\/\//, '')), true);
    } catch {
      setMessage(notices.inline.openFileFailed);
      setPhase('invalid');
    }
  };

  const handleChangeFolder = async () => {
    haptic('tap');
    try {
      const res = await maglevEngine.pickDownloadFolder();
      if ('cancelled' in res) return;
      setFolder({ uri: res.uri, label: res.displayName });
    } catch {
      setAddError(notices.inline.folderPickerFailed);
    }
  };

  const doAdd = async (onlyAll: boolean, paused = false) => {
    setAddError(null);
    setPhase('adding');
    const onlyFiles = !onlyAll && meta && selected.size < meta.files.length ? [...selected].sort((a, b) => a - b) : null;
    const filePriorities =
      !onlyAll && meta && [...firsts].some((i) => selected.has(i))
        ? meta.files.map((f) => ({
            index: f.index,
            priority: (!selected.has(f.index) ? 'skip' : firsts.has(f.index) ? 'first' : 'normal') as FilePriority,
          }))
        : null;
    let res;
    try {
      res = await maglevEngine.addTorrent(sourceRef.current, { onlyFiles, filePriorities, paused, outputFolder: null /* Kotlin fills output_folder from the persisted target set by pickDownloadFolder (handles direct + staging) */ });
    } catch (e) {
      setAddError(e instanceof Error ? e.message : notices.addTorrent.addFailed);
      setPhase(meta ? 'preview' : 'timeout');
      return;
    }
    if (res.ok) {
      finishAdded(res.id);
      return;
    }
    if (res.code === 'DUPLICATE') {
      showDuplicate(res.id ?? null);
      return;
    }
    setAddError(res.message || notices.addTorrent.addFailed);
    haptic('fail');
    setPhase(meta ? 'preview' : 'timeout');
  };

  /** 12.1: stop the wait, add the magnet with every file, and let Transfers show it. */
  const startNow = async () => {
    const source = sourceRef.current;
    const hash = parseSource(source)?.infoHash;
    if (!hash || starting) return;
    setStarting(true);
    try {
      await maglevEngine.cancelResolve(hash);
    } catch {
      // The resolve may already have ended; adding still works.
    }
    token.current++; // the pending resolveMetadata result (CANCELLED) is ignored
    let res;
    try {
      res = await maglevEngine.addTorrent(source, { onlyFiles: null, filePriorities: null, outputFolder: null });
    } catch (e) {
      setStarting(false);
      setAddError(e instanceof Error ? e.message : notices.addTorrent.addFailed);
      setPhase('timeout');
      return;
    }
    setStarting(false);
    if (res.ok) {
      haptic('commit');
      showNotice({ message: notices.addTorrent.addedWaiting }, 6000);
      router.replace('/');
      return;
    }
    if (res.code === 'DUPLICATE') {
      showDuplicate(res.id ?? null);
      return;
    }
    setAddError(res.message || notices.addTorrent.addFailed);
    haptic('fail');
    setPhase('timeout');
  };

  const toggleFile = useCallback((index: number, next: boolean) => {
    haptic('select');
    setSelected((prev) => {
      const s = new Set(prev);
      if (next) s.add(index);
      else s.delete(index);
      return s;
    });
  }, []);

  const applyPriority = (index: number, p: FilePriority) => {
    haptic('select');
    setSelected((prev) => {
      const next = new Set(prev);
      if (p === 'skip') next.delete(index);
      else next.add(index);
      return next;
    });
    setFirsts((prev) => {
      const next = new Set(prev);
      if (p === 'first') next.add(index);
      else next.delete(index);
      return next;
    });
    setPrioIndex(null);
  };

  const isMagnetSource = !fromFileRef.current && /^magnet:/i.test(sourceRef.current);
  const destination = folder?.label ?? defaultStoragePath;
  const destShort = friendlyFolder(destination);

  // ---------- Preview ----------
  if ((phase === 'preview' || phase === 'adding') && meta) {
    const adding = phase === 'adding';
    const exts = new Map<string, number[]>();
    for (const f of meta.files) {
      const e = fileExt(f.path);
      exts.set(e, [...(exts.get(e) ?? []), f.index]);
    }
    const selectedBytes = meta.files.reduce((n, f) => (selected.has(f.index) ? n + f.length : n), 0);
    const allSelected = selected.size === meta.files.length;
    // Writes land in the free-space path; in staging mode the SAF target must fit it too.
    const freeBytes = freeSpace
      ? Math.min(freeSpace.freeBytes, freeSpace.targetFreeBytes ?? freeSpace.freeBytes)
      : null;
    const pendingNeed = pendingNeedOf(telemetry.torrents);
    const admission: AdmissionOutcome | null =
      freeBytes !== null && selectedBytes > 0
        ? admit({
            freeBytes,
            pendingNeed,
            stagingFactor: freeSpace?.mode === 'staging' ? 2 : 1,
            selectionBytes: selectedBytes,
          })
        : null;
    const doesntFit = admission?.result === 'DoesntFit';
    const mobileNote = mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, selectedBytes);
    const prioFile = prioIndex === null ? null : meta.files.find((f) => f.index === prioIndex) ?? null;

    const header = (
      <View style={styles.previewHeader}>
        <Text style={styles.name} numberOfLines={3}>{meta.name}</Text>
        <Text style={styles.meta}>
          {formatBytes(meta.totalBytes)} · {meta.files.length} {meta.files.length === 1 ? 'file' : 'files'}
        </Text>
        {exts.size > 1 ? (
          <View style={styles.chips}>
            {[...exts.entries()].map(([ext, idx]) => (
              <Chip
                key={ext}
                label={ext}
                count={idx.length}
                selected={idx.every((i) => selected.has(i))}
                onPress={() => {
                  const all = idx.every((i) => selected.has(i));
                  setSelected((prev) => {
                    const s = new Set(prev);
                    idx.forEach((i) => (all ? s.delete(i) : s.add(i)));
                    return s;
                  });
                }}
              />
            ))}
          </View>
        ) : null}
        <SpaceStrip selectedBytes={selectedBytes} totalBytes={meta.totalBytes} free={freeSpace} tooBig={doesntFit} />
        <View style={styles.selectRow}>
          <Text style={styles.meta}>
            {selected.size} of {meta.files.length} selected · {formatBytes(selectedBytes)}
          </Text>
          <View style={styles.selectActions}>
            <Button label="All" variant="ghost" disabled={allSelected} onPress={() => setSelected(new Set(meta.files.map((f) => f.index)))} />
            <Button label="None" variant="ghost" disabled={selected.size === 0} onPress={() => setSelected(new Set())} />
          </View>
        </View>
      </View>
    );

    const footer = (
      <View style={styles.footer}>
        <View style={styles.destRow}>
          <View style={styles.destText}>
            <Text style={styles.meta}>Save to</Text>
            <Text style={styles.dest} numberOfLines={1} ellipsizeMode="middle" accessibilityLabel={`Save to ${destination}`}>{destShort}</Text>
          </View>
          <Button label="Change" variant="secondary" disabled={adding} onPress={handleChangeFolder} />
        </View>
        {mobileNote ? <Banner tone="info" title={mobileNote} /> : null}
        {addError ? <Banner tone="danger" title={banners.addTorrent.addFailed.title} body={addError} /> : null}
      </View>
    );

    return (
      <Screen title="Add torrent" onBack={close}>
        <FlatList
          data={meta.files}
          keyExtractor={(f) => String(f.index)}
          renderItem={({ item }) => (
            <AddFileRow
              file={item}
              checked={selected.has(item.index)}
              first={firsts.has(item.index)}
              onToggle={toggleFile}
              onLongPress={(i) => {
                haptic('tap');
                setPrioIndex(i);
              }}
            />
          )}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={<EmptyBlock icon="file" title={empty.addTorrent.noFiles.title} body={empty.addTorrent.noFiles.body} />}
          contentContainerStyle={styles.listContent}
          initialNumToRender={14}
          windowSize={7}
        />
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          {admission && admissionCaption(admission, pendingNeed) ? (
            <Text style={styles.caption}>{admissionCaption(admission, pendingNeed)}</Text>
          ) : null}
          <Button
            label={
              selected.size === 0
                ? 'Select a file to start'
                : doesntFit
                  ? 'Add paused'
                  : `Start download · ${formatBytes(selectedBytes)}`
            }
            size="lg"
            fullWidth
            loading={adding}
            disabled={selected.size === 0}
            onPress={() => doAdd(false, doesntFit)}
          />
        </View>
        <PrioritySheet
          visible={!!prioFile}
          onClose={() => setPrioIndex(null)}
          title="File priority"
          subtitle={prioFile?.path.split('/').pop()}
          current={prioFile ? (!selected.has(prioFile.index) ? 'skip' : firsts.has(prioFile.index) ? 'first' : 'normal') : null}
          skipBytes={prioFile?.length}
          onSelect={(p) => prioFile && applyPriority(prioFile.index, p)}
        />
      </Screen>
    );
  }

  // ---------- Resolving ----------
  if (phase === 'resolving' || phase === 'validating') {
    return (
      <Screen title="Add torrent" onBack={close}>
        <ResolveProgress
          infoHash={isMagnetSource ? parseSource(sourceRef.current)?.infoHash ?? null : null}
          starting={starting}
          onStartNow={startNow}
          onCancel={() => {
            token.current++;
            setPhase('input');
          }}
        />
      </Screen>
    );
  }

  // ---------- Terminal states with their own block ----------
  if (phase === 'duplicate') {
    return (
      <Screen title="Add torrent" onBack={close}>
        <EmptyBlock
          icon="check"
          title={empty.addTorrent.duplicate.title}
          body={empty.addTorrent.duplicate.body}
          primary={{ label: 'Open it', onPress: () => dupId && router.replace({ pathname: '/torrent/[id]', params: { id: dupId } }) }}
          secondary={{ label: 'Back', onPress: () => setPhase('input') }}
        />
      </Screen>
    );
  }

  if (phase === 'timeout') {
    return (
      <Screen title="Add torrent" onBack={close}>
        <EmptyBlock
          icon="clock"
          title={empty.addTorrent.timedOut.title}
          body={
            addError ??
            (isMagnetSource
              ? empty.addTorrent.timedOutMagnet
              : empty.addTorrent.timedOutFile)
          }
          primary={{ label: 'Retry', onPress: () => resolve(sourceRef.current) }}
          secondary={isMagnetSource ? { label: 'Add anyway', onPress: () => doAdd(true) } : { label: 'Back', onPress: () => setPhase('input') }}
        />
      </Screen>
    );
  }

  if (phase === 'error') {
    return (
      <Screen title="Add torrent" onBack={close}>
        <EmptyBlock
          icon="warning"
          error
          title={empty.addTorrent.readFailed.title}
          body={message ?? undefined}
          primary={{ label: 'Retry', onPress: () => resolve(sourceRef.current) }}
          secondary={{ label: 'Back', onPress: () => setPhase('input') }}
        />
      </Screen>
    );
  }

  // ---------- Input (and Invalid, Added) ----------
  const canSubmit = text.trim().length > 0 && phase !== 'added';
  return (
    <Screen title="Add a link or torrent" onBack={close} scroll contentStyle={styles.inputContent}>
      <Text style={styles.label}>Link, magnet or .torrent</Text>
      <TextInput
        value={text}
        onChangeText={onChangeText}
        placeholder="Paste a link or magnet"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={() => canSubmit && submit(text)}
        multiline
        style={[styles.field, phase === 'invalid' && styles.fieldInvalid]}
        accessibilityLabel="Link, magnet or .torrent"
      />
      {phase === 'invalid' && message ? (
        <View style={styles.gap}>
          <Banner tone="danger" title={message} />
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button label="Paste" icon="clipboard" variant="secondary" onPress={handlePaste} />
        <Button label="Open .torrent file" icon="file" variant="secondary" onPress={handlePickFile} />
      </View>

      <View style={styles.gap}>
        <Button label="Get info" size="lg" fullWidth disabled={!canSubmit} onPress={() => submit(text)} />
      </View>
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    inputContent: { padding: spacing.lg, gap: spacing.md },
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
    loadingBar: { width: '70%' },
    metaCenter: { ...type.body, fontSize: type.size.md, color: c.textMuted, textAlign: 'center' },
    listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
    previewHeader: { marginBottom: spacing.md, gap: spacing.sm },
    name: { ...type.mono, fontSize: type.size.lg, color: c.text },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    selectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' },
    selectActions: { flexDirection: 'row' },
    footer: { marginTop: spacing.sm, gap: spacing.md },
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
    caption: { ...type.mono, fontSize: type.size.sm, color: c.textMuted, marginBottom: spacing.sm },
    bar: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.bg,
    },
  });
