import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type, touch } from '../../constants/theme';
import { Button, IconButton, PressableScale, Sheet, TextField } from '../ui';
import { PixelIcon } from '../PixelIcon';
import { parseTyped } from '../../utils/subtitles/parseName';
import { looksLikeAnime } from '../../utils/subtitles/offSources';
import { useSubtitleOffSources } from './useSubtitleEntry';
import {
  CHANGE_LANGUAGES,
  CHANGE_NAME_LABEL,
  MORE_SOURCES,
  PHASE_WORDS,
  ROW_BUTTONS,
  SKIP_LABEL,
  TYPE_A_TITLE,
  bulkProgress,
  useBestMatchFor,
  USES_YOUR_LANGUAGES,
  foundInOtherOnly,
  multiButton,
  multiTitle,
  offSourcesTail,
  nonVideoMany,
  nonVideoOne,
  statusSummary,
} from '../../utils/subtitles/copy';
import { useSeasonBulk, clearBulkResult } from './bulkSave';
import { useSubtitleStateVersion } from './useSubtitleStates';
import { stateFor } from './stateStore';
import { bulkIndex, episodeRows, isEpisodeRequest, phaseCounts, type EpisodeRow, type EpisodeStart } from '../../utils/subtitles/season';
import { clearAskSearchNames, getRequests, isPackAsk, renameRequest, retryRequest, rowTitles, setAskSearchName, skipSubtitles, useRequestPhases, type SubtitleAsk } from '../../utils/subtitles/requests';

interface Props {
  visible: boolean;
  asks: SubtitleAsk[];
  mode: 'choose' | 'status';
  onConfirm: (keys: string[]) => void;
  onClose: () => void;
  /** Names of adds that are not videos, for the one muted footnote (44.9). */
  nonVideo?: string[];
  /**
   * 46.2: a tap on an episode row opens the single SubtitleSheet for that file (the page owns the target). Without it
   * the rows are not tappable.
   */
  onOpenEpisode?: (askKey: string, fileKey: string, start: EpisodeStart) => void;
}

/** One row of the status list: a request, or (46.1) one video file of a season pack. */
type StatusRow = { kind: 'ask'; ask: SubtitleAsk; index: number } | { kind: 'episode'; ep: EpisodeRow };

/** The typing form of a row's name: the title without brackets or the "· n episodes" tail. */
const typingForm = (a: SubtitleAsk): string => a.searchName ?? a.title.split(' · ')[0].replace(/[()]/g, '');

/**
 * NATIVE_CONTRACT 44.9: subtitles for several videos at once. `choose` has a checkbox per row (all ticked), `status`
 * shows each row's phase in words. The pencil edits the name to search for (NATIVE_CONTRACT 42). In `choose` the typed
 * name is handed to `askSubtitles` through `setAskSearchName`; in `status` it searches again at once.
 */
export function MultiSubtitleSheet({ visible, asks, mode, onConfirm, onClose, nonVideo, onOpenEpisode }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const phases = useRequestPhases(asks.map((a) => a.key));
  const stateVersion = useSubtitleStateVersion();
  const bulk = useSeasonBulk();
  const offSources = useSubtitleOffSources(asks.some((a) => looksLikeAnime(a.searchName ?? a.title)));
  const [off, setOff] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (visible) {
      clearBulkResult();
      setOff(new Set());
      setEditing(null);
      setNames({});
      return;
    }
    // 44.15 N26: a name typed in choose mode that was never asked for is forgotten.
    if (mode === 'choose') clearAskSearchNames(asks.map((a) => a.key));
    // Only the sheet closing matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // 44.15 D6: identical rows get " · 2nd", " · 3rd" in add order.
  const titles = useMemo(() => rowTitles(asks), [asks]);
  const ticked = asks.filter((a) => !off.has(a.key));
  const draftOk = parseTyped(draft).title !== '';

  const startEdit = (a: SubtitleAsk) => {
    setEditing(a.key);
    setDraft(names[a.key] ?? typingForm(a));
  };
  const submit = (a: SubtitleAsk) => {
    if (!draftOk) return;
    const text = draft.trim();
    setNames((n) => ({ ...n, [a.key]: text }));
    if (mode === 'choose') setAskSearchName(a.key, text);
    else renameRequest(a.key, text);
    setEditing(null);
  };

  // 46.1: in status mode a season pack lists one row per video file; everything else keeps one row per request.
  const rows = useMemo<StatusRow[]>(
    () => {
      if (mode !== 'status') return asks.map((ask, index) => ({ kind: 'ask' as const, ask, index }));
      const all = getRequests();
      return asks.flatMap<StatusRow>((ask, index) =>
        isEpisodeRequest(all[ask.key])
          ? episodeRows(all[ask.key], (vp) => (vp ? stateFor(vp)?.lang ?? null : null)).map((ep) => ({ kind: 'episode' as const, ep }))
          : [{ kind: 'ask' as const, ask, index }],
      );
    },
    // `phases` changes whenever a request does; the stored language when a state does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asks, mode, phases, stateVersion],
  );
  const rowPhase = (r: StatusRow) => (r.kind === 'episode' ? r.ep.phase : phases[r.ask.key]);
  const counts = phaseCounts(rows.map(rowPhase));
  const nothingFound = rows.some((r) => rowPhase(r) === 'none');
  const allEpisodes = mode === 'status' && rows.length > 0 && rows.every((r) => r.kind === 'episode');
  const keys = asks.map((a) => a.key);
  const bestK = mode === 'status' ? bulk.best(keys) : 0;
  const prog = bulk.progress(keys);
  const bulkLine = bulk.result(keys);
  const summary = mode === 'status' ? statusSummary(counts) : '';
  const foot = nonVideo && nonVideo.length > 0 ? (nonVideo.length === 1 ? nonVideoOne(nonVideo[0]) : nonVideoMany(nonVideo.length)) : '';

  return (
    <Sheet visible={visible} onClose={onClose} title={multiTitle(mode === 'status' ? rows.length : asks.length, allEpisodes)} testID="multi-subtitle-sheet">
      <View style={styles.stack}>
        <View style={styles.langLine}>
          <Text style={styles.hint}>{USES_YOUR_LANGUAGES}</Text>
          <PressableScale
            onPress={() => {
              onClose();
              router.push('/settings/subtitles' as never);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${CHANGE_LANGUAGES} subtitle languages`}
            style={styles.change}
          >
            <Text style={styles.changeText}>{CHANGE_LANGUAGES}</Text>
          </PressableScale>
        </View>
        <View style={styles.summaryRow}>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}
        {/* 45.5: a row found nothing and some sources are off. */}
        {mode === 'status' && nothingFound && offSources.count > 0 ? (
          <PressableScale
            onPress={() => {
              onClose();
              router.push('/settings/subtitle-sources' as never);
            }}
            accessibilityRole="button"
            accessibilityLabel={`${offSourcesTail(offSources.count)}. ${MORE_SOURCES}`}
            style={styles.offLine}
          >
            <Text style={styles.changeText}>{`${summary ? '\u00B7 ' : ''}${offSourcesTail(offSources.count)}`}</Text>
          </PressableScale>
        ) : null}
        </View>

        {/* 46.3: saves each qualifying run's stored best candidate; only on this tap. */}
        {mode === 'status' && (bestK >= 1 || prog) ? (
          <Button
            label={prog ? bulkProgress(bulkIndex(prog.done, prog.total), prog.total) : useBestMatchFor(bestK)}
            fullWidth
            disabled={!!prog || bulk.busy}
            onPress={() => void bulk.start(keys)}
            testID="subtitles-use-best-match"
          />
        ) : null}
        {mode === 'status' && bulkLine && !prog ? <Text style={styles.summary}>{bulkLine}</Text> : null}

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {rows.map((r) => {
            if (r.kind === 'episode') {
              const ep = r.ep;
              const open = onOpenEpisode && ep.start ? () => onOpenEpisode(ep.askKey, ep.fileKey, ep.start!) : null;
              const body = (
                <View style={styles.main}>
                  <Text style={styles.title} numberOfLines={1}>
                    {ep.main}
                  </Text>
                  <Text style={styles.detail} numberOfLines={1}>
                    {ep.detail}
                  </Text>
                </View>
              );
              return (
                <View key={`${ep.askKey}\n${ep.fileKey}`} style={styles.row}>
                  {open ? (
                    <PressableScale onPress={open} scaleTo={0.99} accessibilityRole="button" accessibilityLabel={`${ep.main}, ${ep.detail}`} style={styles.episodeTap} testID="subtitle-episode-row">
                      {body}
                    </PressableScale>
                  ) : (
                    <View style={styles.episodeTap} accessible accessibilityLabel={`${ep.main}, ${ep.detail}`}>
                      {body}
                    </View>
                  )}
                  {ep.phase === 'failed' ? (
                    <PressableScale onPress={() => retryRequest(ep.askKey)} accessibilityRole="button" accessibilityLabel={`${ROW_BUTTONS.tryAgain} ${ep.main}`} style={styles.change}>
                      <Text style={styles.changeText}>{ROW_BUTTONS.tryAgain}</Text>
                    </PressableScale>
                  ) : open ? (
                    <PixelIcon name="chevron-right" size={20} color={colors.textMuted} />
                  ) : null}
                </View>
              );
            }
            const a = r.ask;
            const i = r.index;
            const phase = phases[a.key];
            const on = !off.has(a.key);
            const editingRow = editing === a.key;
            const pack = isPackAsk(a, getRequests()[a.key]?.files);
            // 44.15 D7 / D12: a pack has no pencil, and a saved row is changed through the single sheet.
            const canEdit = !pack && phase !== 'saved';
            const typed = pack ? undefined : names[a.key] ?? a.searchName;
            const word = phase ? (phase === 'needs-pick' && getRequests()[a.key]?.otherLang ? foundInOtherOnly(getRequests()[a.key].otherLang!) : PHASE_WORDS[phase]) : '';
            return (
              <View key={a.key} style={styles.row}>
                {mode === 'choose' ? (
                  <PressableScale
                    onPress={() =>
                      setOff((s) => {
                        const n = new Set(s);
                        if (n.has(a.key)) n.delete(a.key);
                        else n.add(a.key);
                        return n;
                      })
                    }
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={a.title}
                    style={styles.check}
                  >
                    <PixelIcon name={on ? 'select' : 'checkbox-empty'} size={24} color={on ? colors.accentText : colors.textMuted} />
                  </PressableScale>
                ) : null}
                <View style={styles.main}>
                  {editingRow ? (
                    <TextField
                      onSurface
                      value={draft}
                      onChangeText={setDraft}
                      autoFocus
                      mono
                      returnKeyType="search"
                      onSubmitEditing={() => submit(a)}
                      accessibilityLabel={CHANGE_NAME_LABEL}
                      placeholder={TYPE_A_TITLE}
                      error={draftOk ? undefined : TYPE_A_TITLE}
                    />
                  ) : (
                    <>
                      <Text style={styles.title} numberOfLines={1}>
                        {titles[i]}
                      </Text>
                      <Text style={styles.detail} numberOfLines={1}>
                        {typed ? `Searching for ${typed}` : a.detail}
                      </Text>
                      {mode === 'status' && word ? <Text style={styles.phase}>{word}</Text> : null}
                    </>
                  )}
                </View>
                {mode === 'status' && phase === 'queued' && !editingRow ? (
                  <PressableScale onPress={() => skipSubtitles(a.key)} accessibilityRole="button" accessibilityLabel={`${SKIP_LABEL} ${a.title}`} style={styles.change}>
                    <Text style={styles.changeText}>{SKIP_LABEL}</Text>
                  </PressableScale>
                ) : null}
                {mode === 'status' && phase === 'failed' && !editingRow ? (
                  <PressableScale onPress={() => retryRequest(a.key)} accessibilityRole="button" accessibilityLabel={`${ROW_BUTTONS.tryAgain} ${a.title}`} style={styles.change}>
                    <Text style={styles.changeText}>{ROW_BUTTONS.tryAgain}</Text>
                  </PressableScale>
                ) : null}
                {editingRow ? (
                  <Button label="Search" size="md" disabled={!draftOk} onPress={() => submit(a)} />
                ) : canEdit ? (
                  <IconButton icon="pencil" accessibilityLabel={CHANGE_NAME_LABEL} onPress={() => startEdit(a)} />
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        {foot ? <Text style={styles.hint}>{foot}</Text> : null}
        {mode === 'choose' ? <Button label={multiButton(ticked.length)} fullWidth disabled={ticked.length === 0} onPress={() => onConfirm(ticked.map((a) => a.key))} /> : null}
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm },
    langLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    hint: { ...type.body, fontSize: type.size.md, lineHeight: 20, color: c.textMuted, flexShrink: 1 },
    summaryRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.sm },
    offLine: { minHeight: touch.min, justifyContent: 'center', alignSelf: 'flex-start' },
    summary: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    change: { minHeight: touch.min, minWidth: touch.min, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.sm },
    changeText: { ...type.bodyStrong, fontSize: type.size.md, color: c.accentText },
    list: { maxHeight: 360 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 56, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: c.border },
    check: { width: touch.min, height: touch.min, alignItems: 'center', justifyContent: 'center' },
    main: { flex: 1, justifyContent: 'center' },
    episodeTap: { flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    title: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text },
    detail: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    phase: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
  });
