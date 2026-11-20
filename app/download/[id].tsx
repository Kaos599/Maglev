import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { isDownloadLink, normalizeIncoming, type DownloadSnapshot } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useEngineActions, useEngineTelemetry } from '../../context/EngineContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { haptic } from '../../constants/haptics';
import { empty, notices } from '../../constants/copy';
import {
  CANT_RESUME_HINT,
  LINK_COPIED_TEXT,
  WIFI_ANYWAY_NOTE,
  downloadActions,
  downloadCaption,
  downloadProgress,
  downloadProgressLabel,
  downloadStatus,
  isSizeUnknown,
  linkSituation,
  linkWhy,
  linkProblem,
  needsNewLink,
  removeCopy,
  sourceHost,
} from '../../utils/downloadCopy';
import { friendlyPath, formatLimit } from '../../components/settings/SettingsParts';
import { SpeedLimitSheet } from '../../components/detail/SpeedLimitSheet';
import { Banner, Button, EmptyBlock, IconButton, ListRow, Screen, Sheet, TextField, type ProgressTone } from '../../components/ui';
import { toneColor } from '../../components/transfers/StatusLine';
import { ProgressBadge, ProgressCard } from '../../components/detail/ProgressCard';
import { CompactLine } from '../../components/detail/CompactLine';
import { WhyStuck } from '../../components/detail/WhyStuck';
import { useFlowClock } from '../../components/transfers/useStatusOpts';
import { useSettings } from '../../context/SettingsContext';
import { WhyHeld } from '../../components/transfers/WhyHeld';
import { DownloadStats } from '../../components/transfers/DownloadStats';
import { useDownloadActions } from '../../components/transfers/useDownloadActions';
import { SubtitleSheet } from '../../components/subtitles/SubtitleSheet';
import { SubtitlesRow } from '../../components/subtitles/SubtitlesRow';
import { downloadRowFacts, type SheetStart } from '../../components/subtitles/rowModel';
import { useSubtitleAvailability } from '../../components/subtitles/useSubtitleEntry';
import { downloadEntryMode, entrySubtitle, type SubtitleTarget } from '../../components/subtitles/flow';
import { FIND_SUBTITLES } from '../../utils/subtitles/copy';
import { useLiveBlockContext } from '../../utils/blocks/useActiveBlocks';
import { reasonsForItem } from '../../utils/blocks/reasons';

type RemoveStep = 'closed' | 'choose' | 'confirmDelete';

/** The bar's colour, the same as the card's. */
function barTone(d: DownloadSnapshot): ProgressTone {
  switch (d.state) {
    case 'finished':
      return 'seed';
    case 'paused':
      return 'paused';
    case 'error':
    case 'needs_link':
      return 'error';
    default:
      return 'download';
  }
}

/**
 * NATIVE_CONTRACT 40: the page of one link download (it replaces the sheet a tap on its card used to open).
 * Everything comes from the DownloadSnapshot that EngineContext polls; the handlers are `useDownloadActions`.
 */
export default function DownloadScreen() {
  const { colors } = useTheme();
  // NATIVE_CONTRACT 41: Compact or Detailed, from Settings > Appearance > Download page.
  const compact = useSettings().settings.appearance.telemetryDensity === 'COMPACT';
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { downloads } = useEngineTelemetry();
  const { showNotice } = useEngineActions();
  const actions = useDownloadActions();
  const blockCtx = useLiveBlockContext();
  const subtitleAvail = useSubtitleAvailability();

  const [moreOpen, setMoreOpen] = useState(false);
  const [removeStep, setRemoveStep] = useState<RemoveStep>('closed');
  const [limitOpen, setLimitOpen] = useState(false);
  const [subtitleTarget, setSubtitleTarget] = useState<SubtitleTarget | null>(null);
  const [subtitleStart, setSubtitleStart] = useState<SheetStart>('results');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // NATIVE_CONTRACT 40.3: an id that is not in the list (removed, or a stale link) shows the missing state below.
  const d = useMemo(() => downloads.find((x) => x.id === id) ?? null, [downloads, id]);

  // A new page for another download starts with a clean field.
  useEffect(() => {
    setLink('');
    setLinkError(null);
    setBusy(false);
  }, [id]);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [router]);

  const applyLink = useCallback(
    async (raw: string) => {
      if (!d) return;
      const text = normalizeIncoming(raw);
      if (!isDownloadLink(text)) {
        setLinkError("That isn't a web link.");
        return;
      }
      setBusy(true);
      setLinkError(null);
      const res = await actions.newLink(d.id, text);
      setBusy(false);
      if (res.ok) setLink('');
      else setLinkError(res.code === 'FILE_CHANGED' ? 'That link is a different file.' : res.message || "Couldn't use that link.");
    },
    [d, actions],
  );

  const pasteLink = useCallback(async () => {
    let clip = '';
    try {
      clip = (await Clipboard.getStringAsync()).trim();
    } catch {
      clip = '';
    }
    if (!clip) {
      setLinkError('Your clipboard is empty.');
      return;
    }
    setLink(clip);
    void applyLink(clip);
  }, [applyLink]);

  // NATIVE_CONTRACT 40.2 Source: tapping copies the address and says so (the app's one notice toast, as the browser does).
  const copyLink = useCallback(async () => {
    if (!d) return;
    try {
      await Clipboard.setStringAsync(d.urlDisplay);
      haptic('done');
      showNotice({ message: LINK_COPIED_TEXT }, 2500);
    } catch {
      showNotice({ message: notices.browser.linkCopyFailed });
    }
  }, [d, showNotice]);

  // NATIVE_CONTRACT 43: the shared flow clock, the same record the card reads.
  const flow = useFlowClock(id ?? '', d?.state === 'downloading', d?.downBps ?? 0);

  if (!id || !d) {
    // NATIVE_CONTRACT 40.3
    return (
      <Screen title="Download" onBack={goBack}>
        <EmptyBlock
          icon="warning"
          error
          title={empty.detail.downloadNotFound.title}
          body={empty.detail.downloadNotFound.body}
          primary={{ label: 'Back to transfers', onPress: goBack }}
        />
      </Screen>
    );
  }

  const heldItem = { finished: d.state === 'finished', paused: d.state === 'paused', queued: d.state === 'queued', downloading: d.state === 'downloading', pausedBy: d.pausedBy };
  const showWhy = reasonsForItem(heldItem, blockCtx.blocks ?? [], blockCtx.queueLimit).length > 0;
  const all = downloadActions(d, blockCtx);
  // "Why it's paused" carries each rule's own settings button, so the generic one is not repeated.
  const mainActions = all.filter((a) => a.kind !== 'remove' && a.kind !== 'newLink' && !(showWhy && a.kind === 'openNetworkSettings' && a.route));
  const headerAction = all.find((a) => a.kind === 'pause' || a.kind === 'resume') ?? null;
  const caption = downloadCaption(d, blockCtx);
  const status = downloadStatus(d, undefined, blockCtx, flow);
  const situation = linkSituation(d, flow);
  const whyModel =
    situation === 'connecting' || situation === 'waiting'
      ? linkWhy({ situation, host: sourceHost(d.urlDisplay), resumable: d.resumable, quietMs: flow.quietMs, lastDataAgoMs: flow.lastDataAgoMs })
      : null;
  const unknownSize = isSizeUnknown(d);
  const frac = unknownSize ? 0 : downloadProgress(d);
  // Same rule as the card: an unfinished download never reads 100%.
  const rounded = Math.round(frac * 100);
  const percent = unknownSize ? '—' : `${d.state === 'finished' ? rounded : Math.min(99, rounded)}%`;
  const tint = toneColor(status.tone, colors);
  const limit = d.downLimitBps;
  const limitText = limit > 0 ? formatLimit(limit) : 'No limit';
  const subtitles = downloadEntryMode(d, subtitleAvail);
  const subtitleRow = downloadRowFacts(d, subtitleAvail);
  const copy = removeCopy(d);
  const finished = d.state === 'finished';
  const problem = needsNewLink(d) ? linkProblem(d) : null;
  const host = sourceHost(d.urlDisplay);

  const removeNow = (deleteFiles: boolean) => {
    setRemoveStep('closed');
    void actions.remove(d.id, deleteFiles);
    // NATIVE_CONTRACT 40.2 Remove: after removing, go back.
    goBack();
  };

  const headerActions = (
    <>
      {headerAction ? (
        <IconButton
          icon={headerAction.icon}
          accessibilityLabel={headerAction.label}
          onPress={() => actions.run(d, headerAction)}
          testID="download-header-action"
        />
      ) : null}
      <IconButton icon="more" accessibilityLabel="More options" onPress={() => setMoreOpen(true)} testID="download-more" />
    </>
  );

  return (
    <Screen
      title={d.name}
      titleAccessibilityLabel={`${d.name}, ${status.text}`}
      onBack={goBack}
      actions={headerActions}
      scroll
      contentStyle={styles.content}
      testID="download-page"
    >
      {/* NATIVE_CONTRACT 40.2 Progress card: the state in the card's words and colour, the percent, then the bar. */}
      <ProgressCard
        badge={<ProgressBadge label={status.lead} tint={tint} />}
        percent={percent}
        progress={frac}
        tone={barTone(d)}
        barLabel="Download progress"
        accessibilityLabel={`${status.lead}, ${unknownSize ? downloadProgressLabel(d) : percent}`}
      >
        {/* NATIVE_CONTRACT 41.1: Compact, downloading: "↓ speed · time left" under the bar; no line in any other state. */}
        {compact && d.state === 'downloading' ? <CompactLine down={d.downBps} etaSecs={d.eta >= 0 ? d.eta : undefined} /> : null}
      </ProgressCard>

      {/* NATIVE_CONTRACT 40.2: the one-line hint while a download that can't resume is running. */}
      {/* NATIVE_CONTRACT 43.5: only while connecting or waiting; it carries that hint itself when the link can't resume. */}
      {whyModel ? <WhyStuck model={whyModel} /> : null}

      {/* NATIVE_CONTRACT 44.14: the Subtitles row, right under the why block. */}
      {subtitleRow.show ? (
        <SubtitlesRow
          requestKey={`d:${d.id}`}
          started={subtitleRow.started}
          canOpenSheet={subtitleRow.canOpenSheet}
          onOpenSheet={(start) => {
            const t = actions.findSubtitles(d);
            if (!t) return;
            setSubtitleStart(start);
            setSubtitleTarget(t);
          }}
          onSeeAll={() => undefined}
        />
      ) : null}
      {d.state === 'downloading' && !d.resumable && !whyModel?.note ? <Text style={[styles.hint, styles.hintTight]}>{CANT_RESUME_HINT}</Text> : null}

      {d.notice ? (
        <View style={styles.block}>
          <Banner tone="info" title={d.notice} />
        </View>
      ) : null}
      {showWhy ? (
        <View style={styles.block}>
          <WhyHeld item={heldItem} blocks={blockCtx.blocks ?? []} queueLimit={blockCtx.queueLimit} />
        </View>
      ) : null}
      {d.state === 'paused' && d.pausedBy === 'wifi_only' ? <Text style={[styles.hint, styles.block]}>{WIFI_ANYWAY_NOTE}</Text> : null}
      {caption ? <Text style={[styles.hint, styles.block]}>{caption}</Text> : null}

      {/* NATIVE_CONTRACT 40.2 Link problem: "Why it stopped" in WhyHeld's style, then the field and Paste / Update link. */}
      {problem ? (
        <View style={styles.block}>
          <View style={styles.why} testID="why-stopped">
            <Text style={styles.whyHeading} accessibilityRole="header">
              Why it stopped
            </Text>
            <View style={styles.whyItem}>
              <Text style={styles.whyTitle}>{problem.title}</Text>
              <Text style={styles.whyBody}>{problem.body}</Text>
            </View>
          </View>
          <View style={styles.linkBox}>
            <TextField
              label="Paste a new link to the same file"
              value={link}
              onChangeText={(t) => {
                setLink(t);
                setLinkError(null);
              }}
              placeholder="https://…"
              mono
              returnKeyType="go"
              onSubmitEditing={() => void applyLink(link)}
              error={linkError ?? undefined}
              accessibilityLabel="New link"
            />
            <View style={styles.row}>
              <View style={styles.half}>
                <Button label="Paste" icon="clipboard" variant="secondary" fullWidth loading={busy} onPress={() => void pasteLink()} />
              </View>
              <View style={styles.half}>
                <Button label="Update link" fullWidth disabled={!link.trim() || busy} onPress={() => void applyLink(link)} />
              </View>
            </View>
          </View>
        </View>
      ) : null}

      {/* NATIVE_CONTRACT 40.2 Main buttons: downloadActions in the sheet's order, first primary; a finished file reads like the torrent's DoneActions. */}
      <View style={[styles.block, styles.stack]}>
        {mainActions.map((a, i) => (
          <Button
            key={a.kind}
            label={a.label}
            icon={a.icon}
            variant={i === 0 ? 'primary' : 'secondary'}
            size={finished && i === 0 ? 'lg' : undefined}
            fullWidth
            onPress={() => actions.run(d, a)}
          />
        ))}
        {finished ? (
          <View style={styles.row}>
            <View style={styles.half}>
              <Button label="Share" icon="share" variant="secondary" fullWidth onPress={() => actions.share(d.id)} />
            </View>
            <View style={styles.half}>
              <Button label="Open folder" icon="folder" variant="secondary" fullWidth onPress={() => actions.openFolder(d.id)} />
            </View>
          </View>
        ) : (
          <Button label="Open folder" icon="folder" variant="secondary" fullWidth onPress={() => actions.openFolder(d.id)} />
        )}
      </View>

      {/* NATIVE_CONTRACT 40.2 Stats. 41.1: Compact leaves the boxes and the Timing row out; 41.2: Detailed is today's block. */}
      {!compact ? (
        <View style={styles.block}>
          <DownloadStats download={d} />
        </View>
      ) : null}

      {/* NATIVE_CONTRACT 40.2 Rows */}
      <View style={[styles.block, styles.stack]}>
        <ListRow
          title="Source"
          value={host}
          icon="link"
          onPress={() => void copyLink()}
          accessibilityLabel={`Source ${host}. Copies the link.`}
          testID="download-source"
        />
        {d.folder ? (
          <ListRow
            title="Saved to"
            value={friendlyPath(d.folder)}
            icon="folder"
            onPress={() => actions.openFolder(d.id)}
            accessibilityLabel={`Saved to ${friendlyPath(d.folder)}. Opens the folder.`}
          />
        ) : null}
        {/* NATIVE_CONTRACT 41.1: in Compact the Speed limit row moves into the ⋮ menu. 41.2: Detailed keeps the row. */}
        {!compact ? (
          <ListRow
            title="Speed limit"
            icon="speed-limit"
            value={limitText}
            onPress={() => setLimitOpen(true)}
            accessibilityLabel={`Speed limit, ${limitText}. Opens the speed limit options.`}
          />
        ) : null}
        {subtitles !== 'hidden' ? (
          <ListRow
            title={FIND_SUBTITLES}
            subtitle={entrySubtitle(subtitles)}
            icon="file-doc"
            disabled={subtitles !== 'enabled'}
            onPress={() => {
              const t = actions.findSubtitles(d);
              if (t) setSubtitleTarget(t);
            }}
          />
        ) : null}
      </View>

      {/* NATIVE_CONTRACT 40.2 Header menu: Remove…. 41.1: Compact adds Speed limit… above it. */}
      <Sheet visible={moreOpen} onClose={() => setMoreOpen(false)} title={d.name}>
        {compact ? (
          <ListRow
            title="Speed limit…"
            icon="speed-limit"
            value={limitText}
            onPress={() => {
              setMoreOpen(false);
              setLimitOpen(true);
            }}
            accessibilityLabel={`Speed limit, ${limitText}. Opens the speed limit options.`}
          />
        ) : null}
        <ListRow
          title="Remove…"
          icon="trash"
          destructive
          onPress={() => {
            setMoreOpen(false);
            setRemoveStep('choose');
          }}
        />
      </Sheet>
      {/* The sheet's copy and two-step confirm, unchanged. */}
      <Sheet visible={removeStep === 'choose'} onClose={() => setRemoveStep('closed')} title="Remove download">
        <View style={styles.stack}>
          <Text style={styles.hint}>{copy.subtitle}</Text>
          <Button label={copy.keepLabel} variant="secondary" fullWidth onPress={() => removeNow(false)} />
          <Button label={copy.deleteLabel} variant="danger" icon="trash" fullWidth onPress={() => setRemoveStep('confirmDelete')} />
          <Button label="Cancel" variant="ghost" fullWidth onPress={() => setRemoveStep('closed')} />
        </View>
      </Sheet>
      <Sheet
        visible={removeStep === 'confirmDelete'}
        onClose={() => setRemoveStep('closed')}
        title={finished ? 'Delete the file?' : 'Delete the partial file?'}
        subtitle={d.downloaded > 0 ? `This permanently deletes ${formatBytes(d.downloaded)} from your device.` : 'This removes the download.'}
      >
        <View style={styles.stack}>
          <Button label="Delete" variant="danger" icon="trash" fullWidth onPress={() => removeNow(true)} />
          <Button label="Cancel" variant="ghost" fullWidth onPress={() => setRemoveStep('closed')} />
        </View>
      </Sheet>
      <SpeedLimitSheet visible={limitOpen} mode="download" onClose={() => setLimitOpen(false)} limits={{ downBps: limit, upBps: 0 }} onChange={(l) => actions.setLimit(d.id, l.downBps)} />
      <SubtitleSheet
        target={subtitleTarget}
        initial={subtitleStart}
        onClose={() => {
          setSubtitleTarget(null);
          setSubtitleStart('results');
        }}
      />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
    block: { marginBottom: spacing.md },
    stack: { gap: spacing.sm },
    row: { flexDirection: 'row', gap: spacing.sm },
    half: { flex: 1 },
    hint: { ...type.body, fontSize: type.size.md, color: c.textMuted },
    hintTight: { marginTop: -spacing.xs, marginBottom: spacing.md },
    // Same look as WhyHeld: a heading, then each reason's title and text. No side stripe.
    why: { gap: spacing.md },
    whyHeading: { ...type.heading, fontSize: type.size.xl, color: c.text },
    whyItem: { gap: 2 },
    whyTitle: { ...type.bodyStrong, fontSize: type.size.base, color: c.text },
    whyBody: { ...type.body, fontSize: type.size.md, color: c.textMuted, lineHeight: 18 },
    linkBox: { gap: spacing.sm, marginTop: spacing.md },
  });
