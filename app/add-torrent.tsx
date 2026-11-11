import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { maglevEngine, parseSource, type Metadata } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, touch, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { triggerHaptic } from '../constants/haptics';
import { Banner, Button, Chip, EmptyBlock, ProgressBar, Screen } from '../components/ui';
import { PreviewFileRow } from '../components/add/PreviewFileRow';
import { fileExt } from '../components/detail/torrentLabels';

/** SM-9 add flow states. */
type Phase = 'input' | 'validating' | 'invalid' | 'resolving' | 'timeout' | 'error' | 'duplicate' | 'preview' | 'adding' | 'added';

const RESOLVE_TIMEOUT_MS = 60_000;
const INVALID_TEXT = "That isn't a magnet link or torrent file.";

interface Folder {
  uri: string;
  label: string;
}

export default function AddTorrentScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ source?: string; uri?: string; magnet?: string }>();
  const { telemetry, defaultStoragePath } = useMaglevEngine();

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [message, setMessage] = useState<string | null>(null);
  const [meta, setMeta] = useState<Metadata | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dupId, setDupId] = useState<string | null>(null);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

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
      triggerHaptic('success');
      router.replace({ pathname: '/torrent/[id]', params: { id } });
    },
    [router],
  );

  const showDuplicate = useCallback((id: string | null) => {
    setDupId(id);
    setPhase('duplicate');
    triggerHaptic('warning');
  }, []);

  const resolve = useCallback(
    async (source: string) => {
      const mine = ++token.current;
      sourceRef.current = source;
      setMessage(null);
      setAddError(null);
      setPhase('resolving');
      let res;
      try {
        res = await maglevEngine.resolveMetadata(source, RESOLVE_TIMEOUT_MS);
      } catch (e) {
        if (mine !== token.current) return;
        setMessage(e instanceof Error ? e.message : 'Something went wrong.');
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
        setPhase('preview');
        triggerHaptic('medium');
        return;
      }
      switch (res.code) {
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
          setMessage(res.message || 'Something went wrong.');
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
    [resolve, showDuplicate, telemetry.torrents],
  );

  // The `source` param prefills the input and resolves once.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    const incoming = params.source || params.uri || params.magnet;
    if (typeof incoming === 'string' && incoming.trim()) {
      autoRan.current = true;
      setText(incoming);
      submit(incoming);
    }
  }, [params.source, params.uri, params.magnet, submit]);

  const onChangeText = (next: string) => {
    token.current++;
    fromFileRef.current = false;
    setText(next);
    setMessage(null);
    setMeta(null);
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
      setPhase('invalid');
      return;
    }
    setText(clip);
    submit(clip);
  };

  const handlePickFile = async () => {
    triggerHaptic('light');
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
      setMessage("Couldn't open that file.");
      setPhase('invalid');
    }
  };

  const handleChangeFolder = async () => {
    triggerHaptic('light');
    try {
      const res = await maglevEngine.pickDownloadFolder();
      if ('cancelled' in res) return;
      setFolder({ uri: res.uri, label: res.displayName });
    } catch {
      setAddError("Couldn't open the folder picker.");
    }
  };

  const doAdd = async (onlyAll: boolean) => {
    setAddError(null);
    setPhase('adding');
    const onlyFiles = !onlyAll && meta && selected.size < meta.files.length ? [...selected].sort((a, b) => a - b) : null;
    let res;
    try {
      res = await maglevEngine.addTorrent(sourceRef.current, { onlyFiles, outputFolder: null /* Kotlin fills output_folder from the persisted target set by pickDownloadFolder (handles direct + staging) */ });
    } catch (e) {
      setAddError(e instanceof Error ? e.message : 'Something went wrong.');
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
    setAddError(res.message || 'Could not add this torrent.');
    triggerHaptic('error');
    setPhase(meta ? 'preview' : 'timeout');
  };

  const toggleFile = useCallback((index: number, next: boolean) => {
    triggerHaptic('selection');
    setSelected((prev) => {
      const s = new Set(prev);
      if (next) s.add(index);
      else s.delete(index);
      return s;
    });
  }, []);

  const isMagnetSource = !fromFileRef.current && /^magnet:/i.test(sourceRef.current);
  const destination = folder?.label ?? defaultStoragePath;

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
            <Text style={styles.dest} numberOfLines={2} ellipsizeMode="middle">{destination}</Text>
          </View>
          <Button label="Change" variant="secondary" disabled={adding} onPress={handleChangeFolder} />
        </View>
        {addError ? <Banner tone="danger" title="Couldn't add this torrent" body={addError} /> : null}
      </View>
    );

    return (
      <Screen title="Add torrent" onBack={close}>
        <FlatList
          data={meta.files}
          keyExtractor={(f) => String(f.index)}
          renderItem={({ item }) => (
            <PreviewFileRow file={item} checked={selected.has(item.index)} onToggle={toggleFile} />
          )}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={<EmptyBlock icon="file" title="No files listed" body="This torrent has no files to choose from." />}
          contentContainerStyle={styles.listContent}
          initialNumToRender={14}
          windowSize={7}
        />
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
          <Button
            label={selected.size === 0 ? 'Select a file to start' : `Start download · ${formatBytes(selectedBytes)}`}
            size="lg"
            fullWidth
            loading={adding}
            disabled={selected.size === 0}
            onPress={() => doAdd(false)}
          />
        </View>
      </Screen>
    );
  }

  // ---------- Resolving ----------
  if (phase === 'resolving' || phase === 'validating') {
    return (
      <Screen title="Add torrent" onBack={close}>
        <View style={styles.centered} accessibilityLiveRegion="polite">
          <Text style={styles.heading}>Getting torrent info…</Text>
          <View style={styles.loadingBar}>
            <ProgressBar indeterminate accessibilityLabel="Getting torrent info" />
          </View>
          <Text style={styles.metaCenter}>This can take up to a minute for magnet links.</Text>
          <Button
            label="Cancel"
            variant="ghost"
            onPress={() => {
              token.current++;
              setPhase('input');
            }}
          />
        </View>
      </Screen>
    );
  }

  // ---------- Terminal states with their own block ----------
  if (phase === 'duplicate') {
    return (
      <Screen title="Add torrent" onBack={close}>
        <EmptyBlock
          icon="check"
          title="Already in your list"
          body="This torrent is already added."
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
          title="Couldn't find this torrent's info"
          body={
            addError ??
            (isMagnetSource
              ? 'No peers answered in time. Retry, or add it anyway and Maglev keeps looking in the background.'
              : 'No peers answered in time.')
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
          title="Couldn't read this torrent"
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
    <Screen title="Add torrent" onBack={close} scroll contentStyle={styles.inputContent}>
      <Text style={styles.label}>Magnet link or torrent URL</Text>
      <TextInput
        value={text}
        onChangeText={onChangeText}
        placeholder="magnet:?xt=urn:btih:…"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={() => canSubmit && submit(text)}
        multiline
        style={[styles.field, phase === 'invalid' && styles.fieldInvalid]}
        accessibilityLabel="Magnet link or torrent URL"
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
    bar: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
      backgroundColor: c.bg,
    },
  });
