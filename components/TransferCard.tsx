import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "../context/ThemeContext";
import type { TransferTelemetry } from "../context/EngineContext";
import { ThemeColors, alpha, isFinishTransition, motion, radius, spacing, touch, type } from "../constants/theme";
import { StatusLine } from "./transfers/StatusLine";
import { useStatusOpts } from "./transfers/useStatusOpts";
import { formatEta } from "../utils/rates";
import { PixelIcon } from "./PixelIcon";
import { IconButton, PressableScale, ProgressBar, ProgressTone } from "./ui";
import { useMotion } from "./ui/useMotion";
import { torrentCardAction, torrentProgressPercent, torrentStatus } from "./transfers/model";
import { useBlockContext } from "../utils/blocks/useActiveBlocks";
import { cardCanPlay } from "./detail/play";
import { playCopy } from "../constants/copy";
import { useRouter } from "expo-router";
import { SwipeRow } from "./transfers/SwipeRow";
import { swipePlan } from "./transfers/swipe";
import { SubtitleCardIcon } from "./subtitles/SubtitleCardIcon";
import { sameCardIcon, type CardIconModel } from "./subtitles/flow";
import { torrentCardGlyph } from "../utils/cardIcon";

/**
 * Name (two lines), one bar, one status line. At the default font size the height never changes
 * between states. It is a minimum, not a fixed height: at large font scales the card grows so text never clips.
 */
export const CARD_HEIGHT = 104;
export const CARD_GAP = 8;

export interface TransferCardProps {
  torrent: TransferTelemetry;
  selectionMode: boolean;
  selected: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  /** SM-37: clears the no_peers tag so the torrent looks for peers again. */
  onKeepTrying?: (id: string) => void;
  /** A finished card's button: opens the file (the detail screen when there are several). */
  onOpen?: (id: string) => void;
  /** Runs a paused torrent once although a rule (Wi-Fi only, battery, charger, schedule) paused it. */
  onResumeAnyway?: (id: string) => void;
  /** Play button (0.19): streams or opens the torrent's video or audio file. Shown only when the card can tell it is playable. */
  onPlay?: (id: string) => void;
  /** Swipe left: remove from the list, files kept, with Undo. Also the Remove accessibility action. */
  onRemove?: (id: string) => void;
  /** The "Swipe to pause or remove" setting. Off: the card has no swipe wrapper at all. */
  swipeEnabled?: boolean;
  /** Subtitle icon (36.10), top right: only after the user asked for subtitles on this item. */
  subtitle?: CardIconModel | null;
  /** Taps the subtitle icon: opens the subtitle sheet. */
  onSubtitles?: (id: string) => void;
  /** The "Show file type icons in Transfers" setting. The icon shares the slot of the selection checkbox. */
  showFileIcon?: boolean;
}

/**
 * The finish moment: a lime check fades in over the value slot (150 ms) once the bar has filled,
 * holds, then fades out (220 ms) and hands the slot back to the size or upload speed.
 * Mounted only while it plays, so idle rows carry no extra animated views.
 */
function FinishMark({ color, cover, onDone }: { color: string; cover: string; onDone: () => void }) {
  const m = useMotion();
  const o = useSharedValue(0);
  useEffect(() => {
    o.value = withSequence(
      // Let the bar finish its 220 ms fill first.
      withDelay(m.base - m.fast / 2, withTiming(1, { duration: m.fast, easing: m.easing })),
      withDelay(
        motion.finishHold,
        withTiming(0, { duration: m.base, easing: m.easing }, (finished) => {
          if (finished) scheduleOnRN(onDone);
        }),
      ),
    );
    // Plays once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const style = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={[finishStyles.mark, { backgroundColor: cover }, style]}
    >
      <PixelIcon name="check" size={16} color={color} />
    </Animated.View>
  );
}

const finishStyles = StyleSheet.create({
  mark: { ...StyleSheet.absoluteFill, alignItems: "flex-end", justifyContent: "center" },
});

function toneFor(t: TransferTelemetry): ProgressTone {
  switch (t.state) {
    case "SEEDING":
    case "COMPLETED":
      return "seed";
    case "PAUSED":
      return "paused";
    case "ERROR":
      return "error";
    default:
      return "download";
  }
}

function TransferCardImpl({
  torrent: t,
  selectionMode,
  selected,
  onPress,
  onLongPress,
  onPause,
  onResume,
  onKeepTrying,
  onOpen,
  onResumeAnyway,
  onPlay,
  onRemove,
  swipeEnabled = false,
  subtitle = null,
  onSubtitles,
  showFileIcon = true,
}: TransferCardProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const m = useMotion();
  // The time left only changes label when it moves more than 10% or crosses a step.
  // Keyed by id: FlashList recycles cards, and the hysteresis must not carry one torrent's label to another.
  const etaRef = useRef<{ id: string; label: string } | null>(null);
  const prevEta = etaRef.current && etaRef.current.id === t.id ? etaRef.current.label : null;
  const etaLabel = formatEta(t.state === "DOWNLOADING" ? t.etaSeconds : -1, prevEta);
  etaRef.current = etaLabel === "—" ? null : { id: t.id, label: etaLabel };
  const blockCtx = useBlockContext();
  const action = torrentCardAction(t, blockCtx);
  // Play sits left of the state button; the card has no file list, so it needs a media file name (cardCanPlay).
  const showPlay = !!onPlay && !selectionMode && cardCanPlay(t);
  const statusOpts = useStatusOpts(t.id, t.state === "DOWNLOADING" && !t.lastKnown ? t.downloadSpeedBytes : 0, {
    hasRail: selectionMode || showFileIcon,
    hasPlay: showPlay,
    hasAction: !!action && !selectionMode,
  }, t.state === "DOWNLOADING" && !t.lastKnown);
  const status = torrentStatus(t, etaLabel, blockCtx, statusOpts);
  const indeterminate = t.state === "INITIALIZING" || t.state === "CHECKING";
  const moving = t.state === "MOVING";
  const pct = Math.min(
    100,
    Math.max(0, moving ? (t.moveProgress ?? 0) * 100 : torrentProgressPercent(t)),
  );
  // Finish moment: only for this torrent going from downloading to done while its row is shown.
  // A recycled row (another id) resets instead of playing.
  const seen = useRef<{ id: string; state: string; pausedBy?: string | null } | null>(null);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    const next = { id: t.id, state: t.state, pausedBy: t.pausedBy };
    const prev = seen.current;
    seen.current = next;
    if (prev && prev.id !== t.id) {
      setFinishing(false);
      return;
    }
    if (isFinishTransition(prev, next) && !m.disabled && !selectionMode) setFinishing(true);
  }, [t.id, t.state, t.pausedBy, m.disabled, selectionMode]);
  const endFinish = useCallback(() => setFinishing(false), []);

  // Optimistic action in flight (or the saved list before the engine answers): the button dims
  // and stops taking presses. No spinner, no fake progress; the next engine update settles it.
  const actionBusy = !!t.pending || !!t.lastKnown;
  const canAct = !!action && !selectionMode && !actionBusy;
  const playRight = spacing.sm + (action ? touch.min : 0);
  const a11yActions = [
    { name: "activate", label: selectionMode ? (selected ? "Deselect" : "Select") : "Open" },
    ...(canAct && action ? [{ name: action.kind, label: action.label }] : []),
    // Remove from the list (files kept, Undo) is always offered to screen readers, whatever the swipe setting says.
    ...(onRemove && !selectionMode && !actionBusy && !moving ? [{ name: "remove", label: "Remove" }] : []),
  ];
  const swipe = swipePlan({ action, busy: actionBusy, moving, selectionMode, enabled: swipeEnabled });
  const onSwipeRight = useCallback((kind: "pause" | "resume") => (kind === "pause" ? onPause(t.id) : onResume(t.id)), [onPause, onResume, t.id]);
  const onSwipeLeft = useCallback(() => onRemove?.(t.id), [onRemove, t.id]);
  const a11yLabel = `${t.name}, ${status.text}, ${pct.toFixed(0)} percent${selectionMode && selected ? ", selected" : ""}`;

  const card = (
    <View style={[styles.card, selected && styles.cardSelected]}>
      <PressableScale
        onPress={() => onPress(t.id)}
        onLongPress={() => onLongPress(t.id)}
        scaleTo={0.99}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        testID="transfer-card"
        accessibilityActions={a11yActions}
        onAccessibilityAction={(e) => {
          switch (e.nativeEvent.actionName) {
            case "activate":
              onPress(t.id);
              break;
            case "pause":
              onPause(t.id);
              break;
            case "resume":
              onResume(t.id);
              break;
            case "keepTrying":
              onKeepTrying?.(t.id);
              break;
            case "open":
              onOpen?.(t.id);
              break;
            case "resumeAnyway":
              onResumeAnyway?.(t.id);
              break;
            case "remove":
              onRemove?.(t.id);
              break;
            case "freeSpace":
              router.push("/free-space");
              break;
            case "setting":
              if (action?.route) router.push(action.route as never);
              break;
          }
        }}
        accessibilityState={{ selected: selectionMode ? selected : undefined }}
        style={[styles.press, showPlay && { paddingRight: touch.min + playRight }]}
      >
        {selectionMode ? (
          <View style={styles.rail}>
            <PixelIcon name={selected ? "select" : "checkbox-empty"} size={24} color={selected ? colors.accentText : colors.textMuted} />
          </View>
        ) : showFileIcon ? (
          <View style={styles.rail} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <PixelIcon name={torrentCardGlyph(t.name, t.mainFile ? [{ path: t.mainFile, length: 1 }] : null)} size={24} color={colors.textMuted} />
          </View>
        ) : null}
        <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={2} ellipsizeMode="tail">
            {t.name}
          </Text>
        </View>
        <ProgressBar
          progress={pct / 100}
          tone={toneFor(t)}
          indeterminate={indeterminate}
          accessibilityLabel={`${t.name} progress`}
          resetKey={t.id}
        />
        <StatusLine
          status={status}
          overlay={finishing ? <FinishMark key={t.id} color={colors.accentText} cover={colors.surface} onDone={endFinish} /> : null}
        />
        </View>
      </PressableScale>
      {subtitle && onSubtitles && !selectionMode ? (
        <View style={styles.subtitleAnchor}>
          <SubtitleCardIcon model={subtitle} onPress={() => onSubtitles(t.id)} />
        </View>
      ) : null}
      {showPlay ? (
        <View style={[styles.actionAnchor, { right: playRight }]}>
          <IconButton icon="file-video" disabled={actionBusy} accessibilityLabel={playCopy.a11y(t.name)} onPress={() => onPlay?.(t.id)} />
        </View>
      ) : null}
      {action && !selectionMode ? (
        <View style={styles.actionAnchor}>
          <IconButton
            icon={action.icon}
            disabled={actionBusy}
            accessibilityLabel={`${action.label} ${t.name}`}
            onPress={() => {
              switch (action.kind) {
                case "pause":
                  return onPause(t.id);
                case "keepTrying":
                  return onKeepTrying?.(t.id);
                case "open":
                  return onOpen?.(t.id);
                case "resumeAnyway":
                  return onResumeAnyway?.(t.id);
                case "freeSpace":
                  return router.push("/free-space");
                case "setting":
                  return action.route ? router.push(action.route as never) : undefined;
                default:
                  return onResume(t.id);
              }
            }}
          />
        </View>
      ) : null}
    </View>
  );
  return swipeEnabled ? (
    <SwipeRow id={t.id} right={swipe.right} left={swipe.left && !!onRemove} enabled={!selectionMode} onRight={onSwipeRight} onLeft={onSwipeLeft}>
      {card}
    </SwipeRow>
  ) : (
    card
  );
}

function sameCard(a: TransferCardProps, b: TransferCardProps): boolean {
  const x = a.torrent;
  const y = b.torrent;
  return (
    a.selectionMode === b.selectionMode &&
    a.selected === b.selected &&
    a.onPress === b.onPress &&
    a.onLongPress === b.onLongPress &&
    a.onPause === b.onPause &&
    a.onResume === b.onResume &&
    a.onKeepTrying === b.onKeepTrying &&
    a.onOpen === b.onOpen &&
    a.onResumeAnyway === b.onResumeAnyway &&
    a.onPlay === b.onPlay &&
    a.onRemove === b.onRemove &&
    a.swipeEnabled === b.swipeEnabled &&
    a.onSubtitles === b.onSubtitles &&
    sameCardIcon(a.subtitle, b.subtitle) &&
    a.showFileIcon === b.showFileIcon &&
    x.id === y.id &&
    x.name === y.name &&
    x.mainFile === y.mainFile &&
    x.state === y.state &&
    x.pausedBy === y.pausedBy &&
    x.health === y.health &&
    x.resolvingSecs === y.resolvingSecs &&
    x.peersTotal === y.peersTotal &&
    x.error?.message === y.error?.message &&
    x.downloadSpeedBytes === y.downloadSpeedBytes &&
    x.uploadSpeedBytes === y.uploadSpeedBytes &&
    x.progressPercent === y.progressPercent &&
    x.moveProgress === y.moveProgress &&
    x.downloadedBytes === y.downloadedBytes &&
    x.includedBytes === y.includedBytes &&
    x.totalSizeBytes === y.totalSizeBytes &&
    x.etaSeconds === y.etaSeconds &&
    x.pending === y.pending &&
    x.lastKnown === y.lastKnown
  );
}

export const TransferCard = memo(TransferCardImpl, sameCard);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      minHeight: CARD_HEIGHT,
      marginHorizontal: spacing.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      overflow: "hidden",
    },
    // A row: the left rail (file icon or selection box, full card height) and the text column.
    press: {
      flexGrow: 1,
      flexDirection: "row",
      gap: spacing.md,
      paddingLeft: spacing.lg,
      paddingRight: touch.min + spacing.sm,
      paddingVertical: spacing.md,
    },
    rail: { width: 24, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
    body: { flex: 1, gap: spacing.sm, justifyContent: "space-between" },
    actionAnchor: {
      position: "absolute",
      right: spacing.sm,
      top: "50%",
      marginTop: -22,
      width: touch.min,
      height: touch.min,
    },
    // Over the top of the action column (44 wide, right spacing.sm), above the button's own area.
    subtitleAnchor: { position: "absolute", right: spacing.sm + 8, top: 4, width: 28, height: 28 },
    cardSelected: {
      borderColor: c.accent,
      backgroundColor: alpha(c.accent, 0.08),
    },
    nameRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: spacing.sm,
      minHeight: 36,
    },
    name: { ...type.mono, fontSize: type.size.md, lineHeight: 18, color: c.text, flex: 1 },
  });
