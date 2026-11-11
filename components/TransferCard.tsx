import React, { memo, useMemo, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../context/ThemeContext";
import type { TransferTelemetry } from "../context/EngineContext";
import { ThemeColors, alpha, radius, spacing, type } from "../constants/theme";
import { formatBytes, formatSpeed } from "../constants/format";
import { formatEta } from "../utils/rates";
import { PixelIcon, PixelIconName } from "./PixelIcon";
import { IconButton, PressableScale, ProgressBar, ProgressTone } from "./ui";
import { healthLabel, resolvingLine } from "./detail/fileHealthMachine";

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

type StatusTone = "muted" | "accent" | "danger";

function pausedReason(pausedBy: string | null | undefined): string {
  switch (pausedBy) {
    case "wifi_only":
      return "Paused: waiting for Wi-Fi";
    case "battery":
      return "Paused: battery is low";
    case "charging_only":
      return "Paused: waiting for charger";
    case "fgs_timeout":
      return "Paused: stopped in background";
    case "schedule":
      return "Paused: by schedule";
    default:
      return healthLabel(pausedBy) ?? "Paused";
  }
}

/** The one status line under the bar. `etaLabel` is the hysteresis-stable time left. */
function statusFor(t: TransferTelemetry, etaLabel: string): { text: string; tone: StatusTone } {
  const total = t.totalSizeBytes > 0 ? formatBytes(t.totalSizeBytes) : "—";
  switch (t.state) {
    case "DOWNLOADING": {
      const speed = t.lastKnown || t.downloadSpeedBytes <= 0 ? "—" : formatSpeed(t.downloadSpeedBytes);
      if (!t.lastKnown && t.etaSeconds >= 0 && etaLabel !== "—") return { text: `${etaLabel} left · ${speed}`, tone: "muted" };
      return { text: `Downloading · ${speed}`, tone: "muted" };
    }
    case "SEEDING":
      return { text: `Seeding · ↑ ${t.lastKnown ? "—" : formatSpeed(t.uploadSpeedBytes)}`, tone: "accent" };
    case "PAUSED":
      if (t.pausedBy === "seed_limit") return { text: `Done · ${total}`, tone: "accent" };
      return { text: pausedReason(t.pausedBy), tone: "muted" };
    case "COMPLETED":
      return { text: `Done · ${total}`, tone: "accent" };
    case "MOVING":
      return {
        text: t.moveProgress != null ? `Moving files… ${Math.round(t.moveProgress * 100)}%` : "Moving files…",
        tone: "accent",
      };
    case "ERROR":
      return { text: t.error?.message ? t.error.message : "Something went wrong", tone: "danger" };
    case "QUEUED":
      return { text: "Queued", tone: "muted" };
    case "CHECKING":
      return { text: "Checking files…", tone: "muted" };
    case "INITIALIZING":
      if (t.resolvingSecs != null) return { text: resolvingLine(t.peersTotal, t.resolvingSecs), tone: "muted" };
      return { text: "Getting info…", tone: "muted" };
    default:
      return { text: "Getting info…", tone: "muted" };
  }
}

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
  // The time left only changes label when it moves more than 10% or crosses a step.
  const etaRef = useRef<string | null>(null);
  const etaLabel = formatEta(t.state === "DOWNLOADING" ? t.etaSeconds : -1, etaRef.current);
  etaRef.current = etaLabel === "—" ? null : etaLabel;
  const status = statusFor(t, etaLabel);
  const action = actionFor(t);
  const indeterminate = t.state === "INITIALIZING" || t.state === "CHECKING";
  const moving = t.state === "MOVING";
  const pct = Math.min(
    100,
    Math.max(0, moving ? (t.moveProgress ?? 0) * 100 : t.progressPercent),
  );
  const statusColor =
    status.tone === "danger"
      ? colors.danger
      : status.tone === "accent"
        ? colors.accentText
        : colors.textMuted;
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
        />
        <Text style={[styles.status, { color: statusColor }]} numberOfLines={1}>
          {status.text}
        </Text>
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
    status: { ...type.mono, fontSize: 12, lineHeight: 18 },
  });
