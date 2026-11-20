import React, { memo, useMemo } from 'react';
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type, touch } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import { useMaglevEngine } from '../../context/EngineContext';
import { useSeasonBulk } from './bulkSave';
import { ROW_LABEL } from '../../utils/subtitles/copy';
import { getRequests, retryRequest, skipSubtitles, useRequestPhases } from '../../utils/subtitles/requests';
import { useSubtitleConsent } from './useSubtitleConsent';
import { cardIconModel } from './flow';
import { SubtitleBadge } from './SubtitleCardIcon';
import { packCounts, rowModel, type SheetStart } from './rowModel';
import { stateFor } from './stateStore';
import { useSubtitleOffSources } from './useSubtitleEntry';
import { useSubtitleStateVersion } from './useSubtitleStates';

interface Props {
  /** `t:<infoHash lowercase>` or `d:<downloadId>`. */
  requestKey: string;
  /** Key of the stored per-video state (`t:<id>` as the card writes it). Defaults to `requestKey`. */
  stateKey?: string;
  /** The video has some bytes on disk (42.1). */
  started: boolean;
  /** One video's sheet can open from here; the page owns the sheet and the target. */
  canOpenSheet: boolean;
  /** Opens the page's SubtitleSheet: on its results, or with the 42 name field open. */
  onOpenSheet: (start: SheetStart) => void;
  /** Season pack: opens MultiSubtitleSheet in status mode. */
  onSeeAll: () => void;
  /** 44.15 D7: a pack with no request: asks for the whole pack. The row asks for the one-time OK first (D10). */
  onAskPack?: () => void;
}

/**
 * NATIVE_CONTRACT 44.14: one card under the progress card and the "why" block. The icon, the label with the state
 * line, and one text button. Tapping anywhere does what the button does. The page decides whether it shows.
 */
function SubtitlesRowImpl({ requestKey, stateKey = requestKey, started, canOpenSheet, onOpenSheet, onSeeAll, onAskPack }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const phases = useRequestPhases([requestKey]);
  const stateVersion = useSubtitleStateVersion();
  const consent = useSubtitleConsent();
  const router = useRouter();
  const off = useSubtitleOffSources(false);
  const bulk = useSeasonBulk();
  const { showNotice } = useMaglevEngine();
  const entry = getRequests()[requestKey];
  const stored = useMemo(() => cardIconModel(stateFor(stateKey), Date.now()), [stateKey, stateVersion, phases[requestKey]]); // eslint-disable-line react-hooks/exhaustive-deps
  const m = rowModel({
    phase: phases[requestKey],
    otherLang: entry?.otherLang,
    fileListKnown: !!entry?.files,
    pack: packCounts(entry?.files),
    stored,
    language: stored?.lang,
    started,
    canOpenSheet,
    canAskPack: !!onAskPack && !canOpenSheet && !entry,
    needsOk: consent.needsOk && !!entry,
    offSources: off.count,
    bestK: bulk.best([requestKey]),
    bulk: bulk.progress([requestKey]),
  });
  const extraAct = () => {
    if (m.extra?.action === 'see-all') onSeeAll();
    else router.push('/settings/subtitle-sources' as never);
  };

  const act = () => {
    if (!m.button) return;
    if (m.button.action === 'cancel') skipSubtitles(requestKey);
    else if (m.button.action === 'see-all') onSeeAll();
    else if (m.button.action === 'busy') return;
    else if (m.button.action === 'use-best') void bulk.start([requestKey]).then((text) => text && showNotice({ message: text }, 6000));
    else if (m.button.action === 'try-again') retryRequest(requestKey);
    else if (m.button.action === 'review') consent.require(() => {});
    else if (m.button.action === 'ask-pack') consent.require(() => onAskPack?.());
    else onOpenSheet(m.start);
  };

  const glyph = m.glyph === 'saved' ? colors.accentText : m.glyph === 'needs-look' ? colors.text : colors.textMuted;
  const badge = m.glyph === 'saved' ? 'saved' : m.glyph === 'needs-look' ? 'needs-look' : null;
  const body = (
    <>
      <View style={styles.icon} importantForAccessibility="no-hide-descendants">
        {m.glyph === 'getting' ? <View style={[styles.ring, { borderColor: colors.textMuted }]} /> : null}
        <PixelIcon name="subtitles" size={20} color={glyph} />
        {badge ? <SubtitleBadge state={badge} color={m.glyph === 'saved' ? colors.accentText : colors.text} /> : null}
      </View>
      <View style={styles.text}>
        <Text style={styles.label}>{ROW_LABEL}</Text>
        <Text style={[styles.line, m.muted ? { color: colors.textMuted } : null]} numberOfLines={2}>
          {m.line}
        </Text>
      </View>
      {m.button ? (
        <View style={styles.button} importantForAccessibility="no-hide-descendants">
          <Text style={styles.buttonText}>{m.button.label}</Text>
        </View>
      ) : null}
    </>
  );

  // 45.5: "More sources" is a second button, so the card is a plain view with the row's own button inside.
  if (m.extra) {
    return (
      <>
        <View style={styles.cardColumn} testID="subtitles-row">
          {m.button ? (
            <PressableScale onPress={act} scaleTo={0.99} accessibilityRole="button" accessibilityLabel={m.a11y} style={styles.cardRow}>
              {body}
            </PressableScale>
          ) : (
            <View style={styles.cardRow} accessible accessibilityLabel={m.a11y}>
              {body}
            </View>
          )}
          <PressableScale onPress={extraAct} accessibilityRole="button" accessibilityLabel={m.extra.label} style={styles.moreButton} testID={m.extra.action === 'see-all' ? 'subtitles-row-see-all' : 'subtitles-row-more-sources'}>
            <Text style={styles.buttonText}>{m.extra.label}</Text>
          </PressableScale>
        </View>
        {consent.node}
      </>
    );
  }
  if (!m.button) {
    return (
      <View style={styles.card} accessible accessibilityLabel={m.a11y} testID="subtitles-row">
        {body}
      </View>
    );
  }
  return (
    <>
      <PressableScale onPress={act} scaleTo={0.99} accessibilityRole="button" accessibilityLabel={m.a11y} style={styles.card} testID="subtitles-row">
        {body}
      </PressableScale>
      {consent.node}
    </>
  );
}

export const SubtitlesRow = memo(SubtitlesRowImpl);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      paddingVertical: spacing.sm,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      minHeight: 56,
      marginBottom: spacing.md,
    },
    cardColumn: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      marginBottom: spacing.md,
    },
    cardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm, minHeight: 56 },
    moreButton: { minHeight: touch.min, paddingLeft: spacing.lg + 28 + spacing.md, paddingRight: spacing.md, justifyContent: 'center', alignSelf: 'flex-start' },
    icon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
    ring: { position: 'absolute', width: 28, height: 28, borderRadius: radius.lg, borderWidth: 1, borderStyle: 'dotted' },
    text: { flex: 1, gap: 2 },
    label: { ...type.heading, fontSize: type.size.md, color: c.text },
    line: { ...type.body, fontSize: type.size.md, color: c.text },
    // The button's hit area is at least 44 dp; tapping the row does the same.
    button: { minWidth: touch.min, minHeight: touch.min, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
    buttonText: { ...type.body, fontSize: type.size.base, color: c.accentText },
  });
