import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useIsFocused, useRouter } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, alpha, radius, spacing, type, touch } from '../../constants/theme';
import { Banner, Button, Chip, IconButton, ListRow, PressableScale, Sheet, TextField } from '../ui';
import { useListsVersion } from '../../utils/lists/hooks';
import { listSubtitleEntries } from '../../utils/lists';
import { enabledProviders } from '../../utils/subtitles/providers';
import { buildQuery, searchSubtitles, type PreparedSubtitle } from '../../utils/subtitles/search';
import { acceptPrivacy, effectiveLanguages, needsPrivacyNotice } from '../../utils/subtitles/prefs';
import { GROUP_LABEL, type SubtitleGroup } from '../../utils/subtitles/rank';
import { LANGUAGES, languageName } from '../../utils/subtitles/languages';
import {
  DOWNLOAD_BUTTON,
  HEARING_IMPAIRED_TAG,
  COPIES_FULL_TITLE,
  KEEP_BOTH_NOTE,
  NO_OTHER_ROWS,
  NAME_TAKEN_ACTIONS,
  NAME_TAKEN_TITLE,
  NOTHING_FITS_BODY,
  NOTHING_FITS_TITLE,
  NOTICE_CONTINUE,
  NOTICE_NOT_NOW,
  CHANGE_NAME_LABEL,
  SEARCHING_FOR_LABEL,
  SEARCH_BUTTON,
  TYPE_A_TITLE,
  USE_FILE_NAME,
  OTHER_LANGUAGE_TAB,
  SHEET_TITLE,
  alreadyHasCopy,
  TURN_ON_MORE_SOURCES,
  errorCopy,
  offSourcesLine,
  privacyNotice,
} from '../../utils/subtitles/copy';
import { looksLikeAnime } from '../../utils/subtitles/offSources';
import { useSubtitleOffSources } from './useSubtitleEntry';
import { SUBTITLE_PROVIDERS } from '../../utils/subtitles/providers';
import {
  didntRespondLine,
  downloadAndSave,
  errorFromThrown,
  hashIfComplete,
  looksOffline,
  savedToast,
  sourceProblems,
  toFlowError,
  type SubtitleTarget,
} from './flow';
import { CLOSED, canDownload, cardStateFor, draftTitleOk, nothingFits, rowKey, rowsOf, searchNote, searchText, selectedRow, sheetReducer, tabStatus, tabsOf } from './sheetMachine';
import { forgetState, recordState } from './stateStore';
import { markSaved } from '../../utils/subtitles/requests';
import { hasExistingSubtitle } from '../../utils/subtitles/existing';
import { parsedText, parseTyped } from '../../utils/subtitles/parseName';

interface Props {
  /** The video to find subtitles for, or null when the sheet is closed. */
  target: SubtitleTarget | null;
  onClose: () => void;
  /** How it opens: on the results (default), or with the "Searching for" field already open (44.14 "Edit name"). */
  initial?: 'results' | 'edit-name';
}

const GROUP_TAG: Record<SubtitleGroup, string> = { fits: 'Fits', probably: 'Probably', maybe: 'Out of sync' };
const GROUPS: SubtitleGroup[] = ['fits', 'probably', 'maybe'];
const nameOf = (id: string): string => SUBTITLE_PROVIDERS.find((p) => p.id === id)?.name ?? id;

/**
 * The result sheet (36.10): one-time notice, language tabs, grouped results, Download subtitle, and the plain
 * errors. All rules live in `sheetMachine.ts` and `flow.ts`; this component runs the search and the save.
 */
export function SubtitleSheet({ target, onClose, initial = 'results' }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { height } = useWindowDimensions();
  const { settings, updateSettings } = useSettings();
  const { showNotice } = useMaglevEngine();
  const listsVersion = useListsVersion();
  const [state, dispatch] = useReducer(sheetReducer, CLOSED);
  const [picker, setPicker] = useState(false);
  const [showSources, setShowSources] = useState(false);
  // 45.5: "Turn on more sources" hides the sheet while Settings is open; coming back runs the search again.
  const [away, setAway] = useState<string | null>(null);
  const blurred = useRef(false);
  const focused = useIsFocused();
  const [runKey, setRunKey] = useState(0);
  const [dlKey, setDlKey] = useState(0);
  const prevPhase = useRef(state.phase);
  const stateRef = useRef(state);
  stateRef.current = state;
  const prepared = useRef<{ key: string; value: PreparedSubtitle } | null>(null);
  const queryRef = useRef<ReturnType<typeof buildQuery> | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  const sub = settings.subtitles;
  const providers = useMemo(
    () => enabledProviders(sub, listSubtitleEntries()),
    // The signed list can change without the settings changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sub, listsVersion],
  );
  const languages = useMemo(() => effectiveLanguages(sub), [sub]);
  const offSources = useSubtitleOffSources(looksLikeAnime(target?.fileName ?? ''));
  const providersRef = useRef(providers);
  providersRef.current = providers;

  // Open: reset the machine for this video. The sheet never opens with the switch off or no source on.
  const targetKey = target?.videoPath ?? null;
  useEffect(() => {
    if (!targetKey) {
      dispatch({ type: 'CLOSE' });
      return;
    }
    if (!sub.enabled || providersRef.current.length === 0) {
      onClose();
      return;
    }
    prepared.current = null;
    setPicker(false);
    setShowSources(false);
    dispatch({ type: 'OPEN', languages, needsNotice: needsPrivacyNotice(sub), editName: initial === 'edit-name' ? searchText(targetRef.current?.fileName ?? '', null, true) : undefined });
    setRunKey((k) => k + 1);
    // Re-run only when the video changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // Search: runs on entering the searching phase.
  useEffect(() => {
    const t = targetRef.current;
    if (!t || stateRef.current.phase !== 'searching') return;
    const ctl = new AbortController();
    void (async () => {
      // NATIVE_CONTRACT 42.2 / 42.4: only a finished file is read for its fingerprint, and a typed name never sends one.
      const typed = stateRef.current.searchName;
      const h = typed ? { videoBytes: t.videoBytes, missing: false, hash: undefined } : await hashIfComplete(t, maglevEngine);
      if (ctl.signal.aborted) return;
      if (h.missing) {
        dispatch({ type: 'SEARCH_FAILED', error: toFlowError('missing') });
        return;
      }
      const file = { fileName: t.fileName, videoBytes: h.videoBytes, hash: h.hash, searchName: typed ?? undefined };
      queryRef.current = buildQuery(file, stateRef.current.languages);
      try {
        const res = await searchSubtitles(file, {
          providers: providersRef.current,
          languages: stateRef.current.languages,
          hearingImpaired: sub.hearingImpaired,
          signal: ctl.signal,
          onUpdate: (u) => {
            if (!ctl.signal.aborted) dispatch({ type: 'SEARCH_UPDATE', ranked: u.ranked, sources: u.sources, done: u.done });
          },
        });
        if (ctl.signal.aborted) return;
        const answered = res.sources.some((s) => s.state === 'done' || s.state === 'empty');
        if (!answered && res.sources.length > 0) {
          const first = res.sources[0];
          const code = looksOffline(res.sources) ? 'offline' : first.state === 'limit' ? 'limit' : first.state === 'timeout' ? 'timeout' : 'error';
          dispatch({ type: 'SEARCH_FAILED', error: toFlowError(code, { source: nameOf(first.providerId) }) });
        }
      } catch (e) {
        if (!ctl.signal.aborted) dispatch({ type: 'SEARCH_FAILED', error: errorFromThrown(e) });
      }
    })();
    return () => ctl.abort();
    // The search restarts only on a new run key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  // Download and save: runs on entering downloading (also after Replace / Keep both).
  useEffect(() => {
    const t = targetRef.current;
    const s = stateRef.current;
    if (!t || s.phase !== 'downloading') return;
    const row = selectedRow(s);
    const provider = row ? providersRef.current.find((p) => p.id === row.candidate.providerId) : undefined;
    if (!row || !provider) {
      dispatch({ type: 'DOWNLOAD_FAILED', error: toFlowError('error') });
      return;
    }
    const ctl = new AbortController();
    const key = rowKey(row);
    void (async () => {
      const q = queryRef.current ?? buildQuery({ fileName: t.fileName, videoBytes: t.videoBytes }, s.languages);
      const out = await downloadAndSave(
        {
          candidate: row.candidate,
          provider,
          sourceName: provider.name,
          target: t,
          query: q,
          choice: s.pendingChoice ?? 'normal',
          prepared: prepared.current?.key === key ? prepared.current.value : null,
          signal: ctl.signal,
        },
        { unzip: (b64) => maglevEngine.unzipSubtitles(b64), save: (v, n, b64, r) => maglevEngine.saveSubtitle(v, n, b64, r) },
      );
      if (ctl.signal.aborted) {
        // NATIVE_CONTRACT 39.1 S9: the sheet was closed while the native save was running. The file is on disk, so the
        // card still gets its saved state (and the toast) even though the sheet no longer listens.
        if (out.status === 'saved') {
          recordState(t, { state: 'saved', lang: out.language, file: out.fileName, savedAt: Date.now() });
          markSaved(t.ownerKey, t.existing?.videoPath ?? null);
          showNotice({ message: savedToast(out.language) }, 4000);
        }
        return;
      }
      if (out.status === 'saved') {
        dispatch({ type: 'SAVED', fileName: out.fileName, language: out.language });
      } else if (out.status === 'copies-full') {
        dispatch({ type: 'COPIES_FULL', fileName: out.fileName });
      } else if (out.status === 'name-taken') {
        prepared.current = { key, value: out.prepared };
        dispatch({ type: 'NAME_TAKEN', fileName: out.fileName });
      } else {
        dispatch({ type: 'DOWNLOAD_FAILED', error: out.error });
      }
    })();
    return () => ctl.abort();
    // Restarts for a new download attempt only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dlKey]);

  // Keep the card icon in step with the phase, and confirm a save with a toast.
  useEffect(() => {
    const t = targetRef.current;
    const prev = prevPhase.current;
    prevPhase.current = state.phase;
    if (!t) return;
    const w = cardStateFor(prev, state, Date.now());
    if (w === 'clear') forgetState(t);
    else if (w) {
      recordState(t, w);
      // 44.15 D11: the request for this video follows, so a later "name taken" never wipes the saved mark.
      if (w.state === 'saved') markSaved(t.ownerKey, t.existing?.videoPath ?? null);
    }
    if (state.phase === 'saved') {
      showNotice({ message: savedToast(state.savedLang ?? state.language) }, 4000);
      onClose();
    }
    // The phase is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // Back from Settings: search again once, and only when the set of sources on has changed.
  useEffect(() => {
    if (away === null) return;
    if (!focused) {
      blurred.current = true;
      return;
    }
    if (!blurred.current) return;
    blurred.current = false;
    const changed = providers.map((p) => p.id).join(',') !== away;
    setAway(null);
    if (changed && providers.length > 0 && stateRef.current.phase !== 'closed') send({ type: 'RETRY_SEARCH' });
    // Only the focus matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, away]);

  const send = useCallback((e: Parameters<typeof dispatch>[0]) => {
    dispatch(e);
    if (e.type === 'NOTICE_CONTINUE' || e.type === 'RETRY_SEARCH' || e.type === 'SEARCH_NAME' || e.type === 'USE_FILE_NAME') setRunKey((k) => k + 1);
    if (e.type === 'DOWNLOAD' || e.type === 'CHOOSE') setDlKey((k) => k + 1);
  }, []);

  const close = useCallback(() => {
    // Closing during a download or the name question forgets the "getting" state.
    const t = targetRef.current;
    if (t && (stateRef.current.phase === 'downloading' || stateRef.current.phase === 'name-taken')) forgetState(t);
    dispatch({ type: 'CLOSE' });
    // New keys end the running search and stop the download's wait. A save already handed to the native side still
    // finishes; the download effect records it for the card (NATIVE_CONTRACT 39.1 S9).
    setRunKey((k) => k + 1);
    setDlKey((k) => k + 1);
    onClose();
  }, [onClose]);

  const continueNotice = () => {
    updateSettings(acceptPrivacy());
    send({ type: 'NOTICE_CONTINUE' });
  };

  const openFolder = () => {
    const key = target?.ownerKey ?? '';
    const id = key.slice(2);
    const call = key.startsWith('d:') ? maglevEngine.openDownloadFolder(id) : maglevEngine.openFolder(id);
    void call.then((r) => {
      if (!r.ok) showNotice({ message: r.message || "Maglev can't open this folder." });
    });
  };

  const runAction = (kind: string) => {
    switch (kind) {
      case 'retry':
        if (state.phase === 'failed') send({ type: 'RETRY_SEARCH' });
        else send({ type: 'DOWNLOAD' });
        break;
      case 'other-language':
        setPicker(true);
        break;
      case 'more-sources':
        blurred.current = false;
        setAway(providers.map((p) => p.id).join(','));
        router.push('/settings/subtitle-sources' as never);
        break;
      case 'other-source':
        close();
        router.push('/settings/subtitles' as never);
        break;
      case 'open-folder':
        openFolder();
        break;
      case 'pick-another':
        // NATIVE_CONTRACT 39.1 S7
        send({ type: 'PICK_ANOTHER' });
        break;
      case 'keep-both':
        // NATIVE_CONTRACT 39.1 S5
        send({ type: 'CHOOSE', choice: 'keep-both' });
        break;
      default:
        close();
    }
  };

  const visible = !!target && state.phase !== 'closed' && away === null;
  const tabs = tabsOf(state);
  const rows = rowsOf(state);
  const status = tabStatus(state);
  const problems = sourceProblems(state.sources, nameOf);
  const asked = state.sources.filter((s) => s.state !== 'searching').length;
  const maxList = Math.round(height * 0.42);
  const busy = state.phase === 'downloading';

  // NATIVE_CONTRACT 42.3: the "Searching for" row.
  const detectedTyping = target ? searchText(target.fileName, null, true) : '';
  const shownText = target ? searchText(target.fileName, state.searchName) : '';
  const draftOk = draftTitleOk(state.draft);
  const draftDiffers = parseTyped(state.draft).title === '' || parsedText(parseTyped(state.draft), true) !== detectedTyping;
  const startEdit = () => send({ type: 'EDIT_NAME', draft: target ? searchText(target.fileName, state.searchName, true) : '' });
  const submitName = () => {
    if (draftOk) send({ type: 'SEARCH_NAME', detected: detectedTyping });
  };
  const note = target && state.searchDone ? searchNote(state, target.complete) : null;

  const body = () => {
    if (state.phase === 'notice') {
      return (
        <View style={styles.stack}>
          <Text style={styles.body}>{privacyNotice(providers.map((p) => p.name))}</Text>
          <Button label={NOTICE_CONTINUE} fullWidth onPress={continueNotice} />
          <Button label={NOTICE_NOT_NOW} variant="ghost" fullWidth onPress={close} />
        </View>
      );
    }
    if (state.phase === 'name-taken') {
      return (
        <View style={styles.stack}>
          <Text style={styles.heading}>{state.copiesFull ? COPIES_FULL_TITLE : NAME_TAKEN_TITLE}</Text>
          <Text style={styles.mono} numberOfLines={2} ellipsizeMode="middle">
            {state.takenName}
          </Text>
          <Button label={NAME_TAKEN_ACTIONS.replace} fullWidth onPress={() => send({ type: 'CHOOSE', choice: 'replace' })} />
          {state.copiesFull ? null : (
            <>
              <Button label={NAME_TAKEN_ACTIONS.keepBoth} variant="secondary" fullWidth onPress={() => send({ type: 'CHOOSE', choice: 'keep-both' })} />
              <Text style={styles.hint}>{`Keep both saves a second file. ${KEEP_BOTH_NOTE}`}</Text>
            </>
          )}
          <Button label={NAME_TAKEN_ACTIONS.cancel} variant="ghost" fullWidth onPress={() => send({ type: 'CHOOSE', choice: 'cancel' })} />
        </View>
      );
    }
    if (state.phase === 'failed' && state.error) {
      return (
        <View style={styles.stack}>
          <Banner tone="danger" title={state.error.message} actionLabel={state.error.action} onAction={() => runAction(state.error!.actionKind)} />
          <Button label="Close" variant="ghost" fullWidth onPress={close} />
        </View>
      );
    }
    if (picker) {
      return (
        <View style={styles.stack}>
          <ScrollView style={{ maxHeight: maxList + 80 }} keyboardShouldPersistTaps="handled">
            {LANGUAGES.map((l) => (
              <ListRow
                key={l.code}
                title={l.name}
                subtitle={l.native !== l.name ? l.native : undefined}
                selected={l.code === state.language}
                onPress={() => {
                  setPicker(false);
                  send({ type: 'PICK_OTHER', language: l.code });
                }}
              />
            ))}
          </ScrollView>
          <Button label="Back" variant="ghost" fullWidth onPress={() => setPicker(false)} />
        </View>
      );
    }
    return (
      <View style={styles.stack}>
        {/* NATIVE_CONTRACT 42.3 */}
        {state.editing ? (
          <View style={styles.stack}>
            <Text style={styles.hint}>{SEARCHING_FOR_LABEL}</Text>
            <TextField
              onSurface
              value={state.draft}
              onChangeText={(t) => send({ type: 'DRAFT_CHANGE', draft: t })}
              placeholder={TYPE_A_TITLE}
              mono
              returnKeyType="search"
              onSubmitEditing={submitName}
              autoCorrect={false}
              autoFocus
              error={state.draft.trim() !== '' && !draftOk ? TYPE_A_TITLE : undefined}
              accessibilityLabel={SEARCHING_FOR_LABEL}
            />
            <View style={styles.nameActions}>
              <Button label={SEARCH_BUTTON} variant="secondary" disabled={!draftOk} onPress={submitName} />
              {draftDiffers ? <Button label={USE_FILE_NAME} variant="ghost" icon="undo" onPress={() => send({ type: 'USE_FILE_NAME' })} /> : null}
            </View>
          </View>
        ) : (
          <View style={styles.nameRow}>
            <View style={styles.nameText}>
              <Text style={styles.hint}>{SEARCHING_FOR_LABEL}</Text>
              <Text style={styles.searchText} numberOfLines={1} ellipsizeMode="tail">
                {shownText}
              </Text>
            </View>
            <IconButton icon="pencil" accessibilityLabel={CHANGE_NAME_LABEL} disabled={busy} onPress={startEdit} />
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} accessibilityRole="tablist">
          {tabs.map((code) => (
            <Chip key={code} label={languageName(code)} role="radio" selected={code === state.language} disabled={busy} onPress={() => send({ type: 'PICK_TAB', language: code })} />
          ))}
          <Chip label={OTHER_LANGUAGE_TAB} disabled={busy} onPress={() => setPicker(true)} />
        </ScrollView>

        {status === 'searching' ? (
          <View style={styles.stack} accessibilityLiveRegion="polite">
            {[0, 1, 2].map((i) => (
              <View key={i} style={styles.skeleton} />
            ))}
            <Text style={styles.hint}>{`Asked ${asked} of ${state.sources.length} sources`}</Text>
          </View>
        ) : null}

        {status === 'nothing' ? (
          <View style={styles.stack}>
            <Text style={styles.heading}>{target?.existing && hasExistingSubtitle(target.existing.videoPath, state.language, target.existing.files) ? alreadyHasCopy(state.language) : errorCopy('nothing', { language: state.language }).message}</Text>
            {offSources.count > 0 && !(target?.existing && hasExistingSubtitle(target.existing.videoPath, state.language, target.existing.files)) ? (
              <>
                <Text style={styles.hint}>{offSourcesLine(offSources.count, offSources.animeName)}</Text>
                <Button label={TURN_ON_MORE_SOURCES} fullWidth onPress={() => runAction('more-sources')} />
              </>
            ) : null}
            <Button label={errorCopy('nothing').action} variant="secondary" fullWidth onPress={() => setPicker(true)} />
          </View>
        ) : null}

        {status === 'rows' ? (
          <ScrollView style={{ maxHeight: maxList }} keyboardShouldPersistTaps="handled">
            {nothingFits(state) ? (
              <View style={styles.box}>
                <Text style={styles.boxTitle}>{NOTHING_FITS_TITLE}</Text>
                <Text style={styles.hint}>{NOTHING_FITS_BODY}</Text>
              </View>
            ) : null}
            {GROUPS.map((g) => {
              const inGroup = rows.filter((r) => r.group === g);
              if (inGroup.length === 0) return null;
              return (
                <View key={g} style={styles.group}>
                  <Text style={styles.groupTitle}>{GROUP_LABEL[g]}</Text>
                  {inGroup.map((r) => {
                    const key = rowKey(r);
                    const on = key === state.selectedKey;
                    const c = r.candidate;
                    return (
                      <PressableScale
                        key={key}
                        onPress={() => send({ type: 'SELECT', key })}
                        disabled={busy}
                        scaleTo={0.99}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on, disabled: busy }}
                        accessibilityLabel={`${c.releaseName}, ${GROUP_TAG[g]}${c.hearingImpaired ? `, ${HEARING_IMPAIRED_TAG}` : ''}, ${nameOf(c.providerId)}`}
                        style={[styles.row, on && styles.rowOn]}
                      >
                        <Text style={styles.release} numberOfLines={2} ellipsizeMode="middle">
                          {c.releaseName}
                        </Text>
                        <Text style={styles.meta} numberOfLines={1}>
                          {[GROUP_TAG[g], c.hearingImpaired ? HEARING_IMPAIRED_TAG : null, nameOf(c.providerId)].filter(Boolean).join(' · ')}
                        </Text>
                      </PressableScale>
                    );
                  })}
                </View>
              );
            })}
          </ScrollView>
        ) : null}

        {state.searchDone && problems.length > 0 ? (
          <View>
            <PressableScale onPress={() => setShowSources((v) => !v)} accessibilityRole="button" accessibilityLabel={`${didntRespondLine(state.sources)}. Shows which.`} style={styles.problemsBtn}>
              <Text style={styles.hint}>{didntRespondLine(state.sources)}</Text>
            </PressableScale>
            {showSources ? problems.map((p) => (
              <Text key={p.id} style={styles.hint}>
                {p.text}
              </Text>
            )) : null}
          </View>
        ) : null}

        {state.error && state.phase === 'results' ? (
          <Banner tone="danger" title={state.error.message} actionLabel={state.error.action} onAction={() => runAction(state.error!.actionKind)} />
        ) : null}
        {state.noneLeft && state.phase === 'results' ? <Text style={styles.hint}>{NO_OTHER_ROWS}</Text> : null}
        {state.keepBothNote && busy ? <Text style={styles.hint}>{KEEP_BOTH_NOTE}</Text> : null}
        {/* NATIVE_CONTRACT 42.5 */}
        {note && state.phase === 'results' ? <Text style={styles.hint}>{note}</Text> : null}

        <Button label={DOWNLOAD_BUTTON} fullWidth loading={busy} disabled={!canDownload(state) && !busy} onPress={() => send({ type: 'DOWNLOAD' })} />
      </View>
    );
  };

  return (
    <Sheet visible={visible} onClose={close} title={SHEET_TITLE} subtitle={target?.fileName}>
      {body()}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    body: { ...type.body, fontSize: type.size.lg, color: c.text },
    heading: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text },
    mono: { ...type.mono, fontSize: type.size.md, color: c.textMuted },
    hint: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    tabs: { gap: spacing.sm, paddingVertical: spacing.xs },
    skeleton: { height: 56, borderRadius: radius.md, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, opacity: 0.6 },
    box: { padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: alpha(c.warning, 0.4), backgroundColor: alpha(c.warning, 0.1), marginBottom: spacing.sm, gap: 2 },
    boxTitle: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    group: { marginBottom: spacing.sm, gap: spacing.xs },
    groupTitle: { ...type.bodyStrong, fontSize: type.size.sm, color: c.textMuted, paddingVertical: spacing.xs },
    row: { minHeight: 56, justifyContent: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface },
    rowOn: { borderColor: c.accent, backgroundColor: alpha(c.accent, 0.08) },
    release: { ...type.mono, fontSize: type.size.md, color: c.text },
    meta: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginTop: 2 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    nameText: { flex: 1, minHeight: touch.min, justifyContent: 'center' },
    searchText: { ...type.mono, fontSize: type.size.md, color: c.text },
    nameActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
    problemsBtn: { minHeight: touch.min, justifyContent: 'center' },
  });
