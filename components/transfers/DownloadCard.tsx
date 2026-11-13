import React, { memo, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DownloadSnapshot } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { formatEta } from '../../utils/rates';
import { actionRoute, downloadAction, downloadProgress, downloadProgressLabel, downloadStatus, isIndeterminate, type DownloadAction } from '../../utils/downloadCopy';
import { PixelIcon } from '../PixelIcon';
import { IconButton, PressableScale, ProgressBar, ProgressTone } from '../ui';
import { CARD_HEIGHT } from '../TransferCard';

export interface DownloadCardProps {
  download: DownloadSnapshot;
  /** Opens the sheet with Remove, Retry and Paste new link. */
  onPress: (id: string) => void;
  onAction: (download: DownloadSnapshot, action: DownloadAction) => void;
  /** Multi-select, same as a torrent card: a tap toggles and the action button hides. */
  selectionMode?: boolean;
  selected?: boolean;
  onLongPress?: (id: string) => void;
}

function toneFor(d: DownloadSnapshot): ProgressTone {
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

/** Same card as a torrent: name, one bar, one status line, one button. The sheet behind a tap has the rest. */
function DownloadCardImpl({ download: d, onPress, onAction: onActionProp, selectionMode = false, selected = false, onLongPress }: DownloadCardProps) {
  const { colors } = useTheme();
  const router = useRouter();
  // Settings actions go to their screen and Remove opens the sheet (which has the keep/delete choice) here,
  // so the card works without the list screen knowing about them. The rest go to the list screen.
  const onAction = (dl: DownloadSnapshot, a: DownloadAction) => {
    const route = actionRoute(a.kind);
    if (route) router.push(route);
    else if (a.kind === 'remove') onPress(dl.id);
    else onActionProp(dl, a);
  };
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const etaRef = useRef<string | null>(null);
  const etaLabel = formatEta(d.state === 'downloading' ? d.eta : -1, etaRef.current);
  etaRef.current = etaLabel === '—' ? null : etaLabel;
  const status = downloadStatus(d, etaLabel);
  const action = downloadAction(d);
  const pct = Math.round(downloadProgress(d) * 100);
  const indeterminate = isIndeterminate(d);
  const statusColor = status.tone === 'danger' ? colors.danger : status.tone === 'accent' ? colors.accentText : colors.textMuted;

  return (
    <View style={[styles.card, selected && styles.cardSelected]}>
      <PressableScale
        onPress={() => onPress(d.id)}
        onLongPress={onLongPress ? () => onLongPress(d.id) : undefined}
        scaleTo={0.99}
        accessibilityRole="button"
        accessibilityLabel={`${d.name}, ${status.text}${status.sub ? `, ${status.sub}` : ''}, ${downloadProgressLabel(d)}${selectionMode && selected ? ', selected' : ''}`}
        accessibilityActions={[
          { name: 'activate', label: selectionMode ? (selected ? 'Deselect' : 'Select') : 'Open' },
          ...(action && !selectionMode ? [{ name: action.kind, label: action.label }] : []),
        ]}
        accessibilityState={{ selected: selectionMode ? selected : undefined }}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') onPress(d.id);
          else if (action && e.nativeEvent.actionName === action.kind) onAction(d, action);
        }}
        style={styles.press}
      >
        <View style={styles.nameRow}>
          {selectionMode ? (
            <PixelIcon name={selected ? 'select' : 'checkbox-empty'} size={20} color={selected ? colors.accentText : colors.textMuted} />
          ) : null}
          <Text style={styles.name} numberOfLines={2} ellipsizeMode="tail">
            {d.name}
          </Text>
        </View>
        <ProgressBar progress={pct / 100} tone={toneFor(d)} indeterminate={indeterminate} accessibilityLabel={`${d.name} progress`} />
        <View>
          <Text style={[styles.status, { color: statusColor }]} numberOfLines={1}>
            {status.text}
          </Text>
          {status.sub ? (
            <Text style={[styles.status, { color: colors.textMuted }]} numberOfLines={1}>
              {status.sub}
            </Text>
          ) : null}
        </View>
      </PressableScale>
      {action && !selectionMode ? (
        <View style={styles.actionAnchor}>
          <IconButton icon={action.icon} accessibilityLabel={`${action.label} ${d.name}`} onPress={() => onAction(d, action)} />
        </View>
      ) : null}
    </View>
  );
}

function same(a: DownloadCardProps, b: DownloadCardProps): boolean {
  const x = a.download;
  const y = b.download;
  return (
    a.onPress === b.onPress &&
    a.onAction === b.onAction &&
    a.selectionMode === b.selectionMode &&
    a.selected === b.selected &&
    a.onLongPress === b.onLongPress &&
    x.id === y.id &&
    x.name === y.name &&
    x.state === y.state &&
    x.pausedBy === y.pausedBy &&
    x.error?.httpStatus === y.error?.httpStatus &&
    x.size === y.size &&
    !!x.stream === !!y.stream &&
    x.downloaded === y.downloaded &&
    x.downBps === y.downBps &&
    x.stalled === y.stalled &&
    x.eta === y.eta &&
    x.error?.code === y.error?.code &&
    x.error?.message === y.error?.message
  );
}

export const DownloadCard = memo(DownloadCardImpl, same);

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    card: {
      minHeight: CARD_HEIGHT,
      marginHorizontal: spacing.lg,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      overflow: 'hidden',
    },
    press: {
      flexGrow: 1,
      gap: spacing.sm,
      paddingLeft: spacing.lg,
      paddingRight: 44 + spacing.sm,
      paddingVertical: spacing.md,
      justifyContent: 'space-between',
    },
    actionAnchor: { position: 'absolute', right: spacing.sm, top: '50%', marginTop: -22, width: 44, height: 44 },
    cardSelected: { borderColor: c.accent, backgroundColor: alpha(c.accent, 0.08) },
    nameRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    name: { ...type.mono, fontSize: 13, lineHeight: 18, color: c.text, flex: 1 },
    status: { ...type.mono, fontSize: 12, lineHeight: 18 },
  });
