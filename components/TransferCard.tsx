import React, { memo, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TorrentTelemetry } from "maglev-engine";
import { useTheme } from "../context/ThemeContext";
import { ThemeColors, alpha, radius, spacing, type } from "../constants/theme";
import { formatBytes, formatEta, formatSpeed } from "../constants/format";
import { PixelIcon, PixelIconName } from "./PixelIcon";
import { IconButton, PressableScale, ProgressBar, ProgressTone } from "./ui";

export const CARD_HEIGHT = 124;
export const CARD_GAP = 8;

export interface TransferCardProps {
  torrent: TorrentTelemetry;
  selectionMode: boolean;
  selected: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}

interface Badge {
  text: string;
  tone: "neutral" | "accent" | "danger";
}

type CardAction = {
  icon: PixelIconName;
  label: string;
  kind: "pause" | "resume";
} | null;

function pausedLabel(pausedBy: string | null | undefined): string {
  switch (pausedBy) {
    case "wifi_only":
      return "Waiting for Wi-Fi";
    case "battery":
    case "charging_only":
      return "Paused to save battery";
    case "seed_limit":
      return "Done";
    case "fgs_timeout":
      return "Paused in background";
    default:
      return "Paused";
  }
}

function badgeFor(t: TorrentTelemetry): Badge | null {
  switch (t.state) {
    case "INITIALIZING":
      return { text: "Getting info", tone: "neutral" };
    case "QUEUED":
      return { text: "Queued", tone: "neutral" };
    case "SEEDING":
      return { text: "Seeding", tone: "accent" };
    case "PAUSED":
      return { text: pausedLabel(t.pausedBy), tone: "neutral" };
    case "CHECKING":
      return { text: "Checking", tone: "neutral" };
    case "ERROR":
      return {
        text: t.error?.message ? t.error.message : "Something went wrong",
        tone: "danger",
      };
    case "COMPLETED":
      return { text: "Done", tone: "accent" };
    default:
      return null;
  }
}

function actionFor(t: TorrentTelemetry): CardAction {
  switch (t.state) {
    case "DOWNLOADING":
    case "SEEDING":
      return { icon: "pause", label: "Pause", kind: "pause" };
    case "PAUSED": {
      const by: string | null | undefined = t.pausedBy;
      if (
        by === "wifi_only" ||
        by === "battery" ||
        by === "charging_only" ||
        by === "fgs_timeout"
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

function toneFor(t: TorrentTelemetry): ProgressTone {
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

function telemetryLine(t: TorrentTelemetry): string {
  const total = t.totalSizeBytes > 0 ? formatBytes(t.totalSizeBytes) : "—";
  const done = formatBytes(t.downloadedBytes);
  switch (t.state) {
    case "DOWNLOADING":
      return `↓ ${formatSpeed(t.downloadSpeedBytes)} · ${done} / ${total} · ${formatEta(t.etaSeconds)}`;
    case "SEEDING":
      return `↑ ${formatSpeed(t.uploadSpeedBytes)} · ratio ${t.ratio.toFixed(2)} · ${total}`;
    case "INITIALIZING":
      return "—";
    default:
      return `${done} / ${total}`;
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
}: TransferCardProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const badge = badgeFor(t);
  const action = actionFor(t);
  const indeterminate = t.state === "INITIALIZING" || t.state === "CHECKING";
  const pct = Math.min(100, Math.max(0, t.progressPercent));
  const badgeColor =
    badge?.tone === "danger"
      ? colors.danger
      : badge?.tone === "accent"
        ? colors.accentText
        : colors.textMuted;

  return (
    <View style={[styles.card, selected && styles.cardSelected]}>
      <PressableScale
        onPress={() => onPress(t.id)}
        onLongPress={() => onLongPress(t.id)}
        scaleTo={0.99}
        accessibilityRole="button"
        accessibilityLabel={`${t.name}, ${badge?.text ?? "Downloading"}, ${pct.toFixed(0)} percent`}
        accessibilityState={{ selected: selectionMode ? selected : undefined }}
        style={styles.press}
      >
        <View style={styles.row}>
          {selectionMode ? (
            <PixelIcon
              name={selected ? "select" : "checkbox-empty"}
              size={20}
              color={selected ? colors.accentText : colors.textMuted}
            />
          ) : null}
          <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
            {t.name}
          </Text>
          {badge ? (
            <View
              style={[
                styles.badge,
                {
                  backgroundColor: alpha(badgeColor, 0.12),
                  borderColor: alpha(badgeColor, 0.4),
                },
              ]}
            >
              <Text
                style={[styles.badgeText, { color: badgeColor }]}
                numberOfLines={1}
              >
                {badge.text}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.telemetry} numberOfLines={1}>
          {telemetryLine(t)}
        </Text>
        <ProgressBar
          progress={pct / 100}
          tone={toneFor(t)}
          indeterminate={indeterminate}
          accessibilityLabel={`${t.name} progress`}
        />
        <View style={styles.footer}>
          <Text style={styles.footText}>
            {indeterminate ? "—" : `${pct.toFixed(1)}%`}
          </Text>
          <Text style={[styles.footText, styles.peers]} numberOfLines={1}>
            {`peers ${t.peersConnected}/${t.peersTotal}`}
          </Text>
          <View style={styles.actionSlot} />
        </View>
      </PressableScale>
      {action && !selectionMode ? (
        <View style={styles.actionAnchor}>
          <IconButton
            icon={action.icon}
            accessibilityLabel={`${action.label} ${t.name}`}
            onPress={() =>
              action.kind === "pause" ? onPause(t.id) : onResume(t.id)
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
    x.id === y.id &&
    x.name === y.name &&
    x.state === y.state &&
    x.pausedBy === y.pausedBy &&
    x.error?.message === y.error?.message &&
    x.downloadSpeedBytes === y.downloadSpeedBytes &&
    x.uploadSpeedBytes === y.uploadSpeedBytes &&
    x.progressPercent === y.progressPercent &&
    x.downloadedBytes === y.downloadedBytes &&
    x.totalSizeBytes === y.totalSizeBytes &&
    x.etaSeconds === y.etaSeconds &&
    x.peersConnected === y.peersConnected &&
    x.peersTotal === y.peersTotal &&
    x.ratio === y.ratio
  );
}

export const TransferCard = memo(TransferCardImpl, sameCard);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      height: CARD_HEIGHT,
      marginHorizontal: spacing.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      overflow: "hidden",
    },
    press: {
      flex: 1,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      paddingTop: spacing.md,
      justifyContent: "flex-start",
    },
    actionAnchor: {
      position: "absolute",
      right: spacing.sm,
      bottom: 0,
      width: 44,
      height: 44,
    },
    cardSelected: {
      borderColor: c.accent,
      backgroundColor: alpha(c.accent, 0.08),
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      height: 24,
      paddingRight: spacing.sm,
    },
    name: { ...type.mono, fontSize: 13, color: c.text, flex: 1 },
    badge: {
      borderWidth: 1,
      borderRadius: radius.sm,
      paddingHorizontal: 6,
      height: 22,
      justifyContent: "center",
      maxWidth: 160,
    },
    badgeText: { ...type.bodyStrong, fontSize: 11 },
    telemetry: {
      ...type.mono,
      fontSize: 12,
      color: c.textMuted,
      height: 20,
      lineHeight: 20,
      marginTop: 2,
      marginBottom: spacing.sm,
    },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      height: 44,
      gap: spacing.md,
    },
    footText: { ...type.mono, fontSize: 12, color: c.textMuted },
    peers: { flex: 1 },
    actionSlot: { width: 44, height: 44 },
  });
