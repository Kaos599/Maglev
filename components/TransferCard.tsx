import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useTheme } from "../context/ThemeContext";
import type { TransferTelemetry } from "../context/EngineContext";
import { ThemeColors, alpha, isFinishTransition, monoSlotWidth, motion, radius, spacing, type } from "../constants/theme";
import { formatEta } from "../utils/rates";
import { PixelIcon, PixelIconName } from "./PixelIcon";
import { IconButton, PressableScale, ProgressBar, ProgressTone } from "./ui";
import { useMotion } from "./ui/useMotion";
import { torrentProgressPercent, torrentStatus } from "./transfers/model";

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
}

type CardAction = {
  icon: PixelIconName;
  label: string;
  kind: "pause" | "resume" | "keepTrying";
} | null;

/** Status line font size; the value slot is sized in Space Mono glyphs at this size. */
const STATUS_SIZE = 12;
const STATUS_LINE = 18;

/**
 * Widest strings each value slot holds, in glyphs: "1023.9 KB/s", "↑ 1023.9 KB/s", "1023.9 GB".
 * A fixed minimum width means a speed that gains a digit never shifts the text beside it.
 */
const SLOT_CHARS = { speed: 11, upload: 13, size: 9 } as const;

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

function actionFor(t: TransferTelemetry): CardAction {
  switch (t.state) {
    case "DOWNLOADING":
    case "SEEDING":
      return { icon: "pause", label: "Pause", kind: "pause" };
    case "PAUSED": {
      const by: string | null | undefined = t.pausedBy;
      if (by === "no_peers") return { icon: "retry", label: "Keep trying", kind: "keepTrying" };
      if (
        by === "files_missing" ||
        by === "files_changed" ||
        by === "storage_full" ||
        by === "storage_unavailable"
      )
        return null;
      if (
        by === "wifi_only" ||
        by === "battery" ||
        by === "charging_only" ||
        by === "fgs_timeout" ||
        by === "schedule"
      )
        return null;
      return {
        icon: "play",
        label: by === "seed_limit" ? "Seed again" : "Resume",
        kind: "resume",
      };
    }
    case "ERROR":
      return { icon: "retry", label: "Retry", kind: "resume" };
    default:
      return null;
  }
}

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
}: TransferCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { fontScale } = useWindowDimensions();
  const m = useMotion();
  // The time left only changes label when it moves more than 10% or crosses a step.
  // Keyed by id: FlashList recycles cards, and the hysteresis must not carry one torrent's label to another.
  const etaRef = useRef<{ id: string; label: string } | null>(null);
  const prevEta = etaRef.current && etaRef.current.id === t.id ? etaRef.current.label : null;
  const etaLabel = formatEta(t.state === "DOWNLOADING" ? t.etaSeconds : -1, prevEta);
  etaRef.current = etaLabel === "—" ? null : { id: t.id, label: etaLabel };
  const status = torrentStatus(t, etaLabel);
  const action = actionFor(t);
  const indeterminate = t.state === "INITIALIZING" || t.state === "CHECKING";
  const moving = t.state === "MOVING";
  const pct = Math.min(
    100,
    Math.max(0, moving ? (t.moveProgress ?? 0) * 100 : torrentProgressPercent(t)),
  );
  const statusColor =
    status.tone === "danger"
      ? colors.danger
      : status.tone === "accent"
        ? colors.accentText
        : colors.textMuted;
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
  const a11yActions = [
    { name: "activate", label: selectionMode ? (selected ? "Deselect" : "Select") : "Open" },
    ...(canAct && action ? [{ name: action.kind, label: action.label }] : []),
  ];
  const a11yLabel = `${t.name}, ${status.text}, ${pct.toFixed(0)} percent${selectionMode && selected ? ", selected" : ""}`;

  return (
    <View style={[styles.card, selected && styles.cardSelected]}>
      <PressableScale
        onPress={() => onPress(t.id)}
        onLongPress={() => onLongPress(t.id)}
        scaleTo={0.99}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
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
          }
        }}
        accessibilityState={{ selected: selectionMode ? selected : undefined }}
        style={styles.press}
      >
        <View style={styles.nameRow}>
          {selectionMode ? (
            <PixelIcon
              name={selected ? "select" : "checkbox-empty"}
              size={20}
              color={selected ? colors.accentText : colors.textMuted}
            />
          ) : null}
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
        <View style={styles.statusBlock}>
        <View style={styles.statusRow}>
          <Text style={[styles.status, styles.lead, { color: statusColor }]} numberOfLines={1}>
            {status.lead}
          </Text>
          {status.value ? (
            <View style={[styles.slot, { minWidth: monoSlotWidth(SLOT_CHARS[status.slot ?? "speed"], STATUS_SIZE, fontScale) }]}>
              <Text style={[styles.status, styles.value, { color: statusColor }]} numberOfLines={1}>
                {status.value}
              </Text>
              {finishing ? <FinishMark key={t.id} color={colors.accentText} cover={colors.surface} onDone={endFinish} /> : null}
            </View>
          ) : null}
        </View>
        {status.sub ? (
          <Text style={[styles.status, { color: colors.textMuted }]} numberOfLines={1}>
            {status.sub}
          </Text>
        ) : null}
        </View>
      </PressableScale>
      {action && !selectionMode ? (
        <View style={styles.actionAnchor}>
          <IconButton
            icon={action.icon}
            disabled={actionBusy}
            accessibilityLabel={`${action.label} ${t.name}`}
            onPress={() =>
              action.kind === "pause"
                ? onPause(t.id)
                : action.kind === "keepTrying"
                  ? onKeepTrying?.(t.id)
                  : onResume(t.id)
            }
          />
        </View>
      ) : null}
    </View>
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
    x.id === y.id &&
    x.name === y.name &&
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
    press: {
      flexGrow: 1,
      gap: spacing.sm,
      paddingLeft: spacing.lg,
      paddingRight: 44 + spacing.sm,
      paddingVertical: spacing.md,
      justifyContent: "space-between",
    },
    actionAnchor: {
      position: "absolute",
      right: spacing.sm,
      top: "50%",
      marginTop: -22,
      width: 44,
      height: 44,
    },
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
    name: { ...type.mono, fontSize: 13, lineHeight: 18, color: c.text, flex: 1 },
    // One line, always present, at a fixed minimum height: rows never grow or shrink as the text changes.
    statusBlock: { gap: 0 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: STATUS_LINE },
    status: { ...type.mono, fontSize: STATUS_SIZE, lineHeight: STATUS_LINE },
    lead: { flex: 1, flexShrink: 1 },
    slot: { flexShrink: 0, alignItems: "flex-end", justifyContent: "center" },
    value: { textAlign: "right" },
  });
