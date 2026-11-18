import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button, IconButton, PressableScale, Sheet } from '../ui';
import { PixelIcon } from '../PixelIcon';
import { parseTyped } from '../../utils/subtitles/parseName';
import {
  CHANGE_LANGUAGES,
  CHANGE_NAME_LABEL,
  PHASE_WORDS,
  SKIP_LABEL,
  TYPE_A_TITLE,
  USES_YOUR_LANGUAGES,
  foundInOtherOnly,
  multiButton,
  multiTitle,
  nonVideoMany,
  nonVideoOne,
  statusSummary,
} from '../../utils/subtitles/copy';
import { getRequests, renameRequest, rowTitles, setAskSearchName, skipSubtitles, useRequestPhases, type SubtitleAsk } from '../../utils/subtitles/requests';

interface Props {
  visible: boolean;
  asks: SubtitleAsk[];
  mode: 'choose' | 'status';
  onConfirm: (keys: string[]) => void;
  onClose: () => void;
  /** Names of adds that are not videos, for the one muted footnote (44.9). */
  nonVideo?: string[];
}

/** The typing form of a row's name: the title without brackets or the "· n episodes" tail. */
const typingForm = (a: SubtitleAsk): string => a.searchName ?? a.title.split(' · ')[0].replace(/[()]/g, '');

/**
 * NATIVE_CONTRACT 44.9: subtitles for several videos at once. `choose` has a checkbox per row (all ticked), `status`
 * shows each row's phase in words. The pencil edits the name to search for (NATIVE_CONTRACT 42). In `choose` the typed
 * name is handed to `askSubtitles` through `setAskSearchName`; in `status` it searches again at once.
 */
export function MultiSubtitleSheet({ visible, asks, mode, onConfirm, onClose, nonVideo }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const phases = useRequestPhases(asks.map((a) => a.key));
  const [off, setOff] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (visible) {
      setOff(new Set());
      setEditing(null);
      setNames({});
    }
  }, [visible]);

  const titles = useMemo(() => rowTitles(asks.map((a) => (a.addedAt ? a : { ...a, addedAt: getRequests()[a.key]?.updatedAt }))), [asks]);
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

  const counts = { saved: 0, needsYou: 0, waiting: 0 };
  for (const a of asks) {
    const p = phases[a.key];
    if (p === 'saved') counts.saved++;
    else if (p === 'needs-pick') counts.needsYou++;
    else if (p === 'searching' || p === 'queued') counts.waiting++;
  }
  const summary = mode === 'status' ? statusSummary(counts) : '';
  const foot = nonVideo && nonVideo.length > 0 ? (nonVideo.length === 1 ? nonVideoOne(nonVideo[0]) : nonVideoMany(nonVideo.length)) : '';

  return (
    <Sheet visible={visible} onClose={onClose} title={multiTitle(asks.length)} testID="multi-subtitle-sheet">
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
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
          {asks.map((a, i) => {
            const phase = phases[a.key];
            const on = !off.has(a.key);
            const editingRow = editing === a.key;
            const typed = names[a.key] ?? a.searchName;
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
                    <TextInput
                      value={draft}
                      onChangeText={setDraft}
                      autoFocus
                      returnKeyType="search"
                      onSubmitEditing={() => submit(a)}
                      accessibilityLabel={CHANGE_NAME_LABEL}
                      placeholder={TYPE_A_TITLE}
                      placeholderTextColor={colors.textFaint}
                      style={[styles.input, !draftOk && styles.inputError]}
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
                {editingRow ? (
                  <Button label="Search" size="md" disabled={!draftOk} onPress={() => submit(a)} />
                ) : (
                  <IconButton icon="pencil" accessibilityLabel={CHANGE_NAME_LABEL} onPress={() => startEdit(a)} />
                )}
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
    hint: { ...type.body, fontSize: 13, lineHeight: 20, color: c.textMuted, flexShrink: 1 },
    summary: { ...type.bodyStrong, fontSize: type.size.md, color: c.text },
    change: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.sm },
    changeText: { ...type.bodyStrong, fontSize: type.size.md, color: c.accentText },
    list: { maxHeight: 360 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 56, paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: c.border },
    check: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    main: { flex: 1, justifyContent: 'center' },
    title: { ...type.bodyStrong, fontSize: type.size.lg, color: c.text },
    detail: { ...type.body, fontSize: 13, color: c.textMuted },
    phase: { ...type.bodyStrong, fontSize: 13, color: c.text },
    input: { ...type.mono, fontSize: type.size.md, minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.bg, color: c.text },
    inputError: { borderColor: c.danger },
  });
