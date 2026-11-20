import React, { memo, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { DownloadSnapshot } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, touch, type } from '../../constants/theme';
import { formatEta } from '../../utils/rates';
import { actionRoute, downloadAction, downloadProgress, downloadProgressLabel, downloadStatus, isIndeterminate, type DownloadAction } from '../../utils/downloadCopy';
import { PixelIcon } from '../PixelIcon';
import { StatusLine } from './StatusLine';
import { useStatusOpts } from './useStatusOpts';
import { IconButton, PressableScale, ProgressBar, ProgressTone } from '../ui';
import { CARD_HEIGHT } from '../TransferCard';
import { useBlockContext } from '../../utils/blocks/useActiveBlocks';
import { SwipeRow } from './SwipeRow';
import { swipePlan } from './swipe';
import { SubtitleCardIcon } from '../subtitles/SubtitleCardIcon';
import { sameCardIcon, type CardIconModel } from '../subtitles/flow';
import { downloadCardGlyph } from '../../utils/cardIcon';

export interface DownloadCardProps {
  download: DownloadSnapshot;
  /** Opens the sheet with Remove, Retry and Paste new link. */
  onPress: (id: string) => void;
  onAction: (download: DownloadSnapshot, action: DownloadAction) => void;
  /** Multi-select, same as a torrent card: a tap toggles and the action button hides. */
  selectionMode?: boolean;
  selected?: boolean;
  onLongPress?: (id: string) => void;
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
function DownloadCardImpl({ download: d, onPress, onAction: onActionProp, selectionMode = false, selected = false, onLongPress, onRemove, swipeEnabled = false, subtitle = null, onSubtitles, showFileIcon = true }: DownloadCardProps) {
  const { colors } = useTheme();
  const router = useRouter();
  // Settings actions go to their screen and Remove opens the sheet (which has the keep/delete choice) here,
  // so the card works without the list screen knowing about them. The rest go to the list screen.
  const onAction = (dl: DownloadSnapshot, a: DownloadAction) => {
    const route = actionRoute(a.kind, a.route);
    if (route) router.push(route as never);
    else if (a.kind === 'remove') onPress(dl.id);
    else onActionProp(dl, a);
  };
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const etaRef = useRef<string | null>(null);
  const etaLabel = formatEta(d.state === 'downloading' ? d.eta : -1, etaRef.current);
  etaRef.current = etaLabel === '—' ? null : etaLabel;
  const blockCtx = useBlockContext();
  const action = downloadAction(d, blockCtx);
  const statusOpts = useStatusOpts(d.id, d.state === 'downloading' ? d.downBps : 0, { hasRail: selectionMode || showFileIcon, hasPlay: false, hasAction: !!action && !selectionMode }, d.state === 'downloading');
  const status = downloadStatus(d, etaLabel, blockCtx, statusOpts);
  const pct = Math.round(downloadProgress(d) * 100);
  const indeterminate = isIndeterminate(d);

  const swipe = swipePlan({ action, busy: false, selectionMode, enabled: swipeEnabled });
  const onSwipeRight = () => {
    if (action) onAction(d, action);
  };
  const card = (
    <View style={[styles.card, selected && styles.cardSelected]}>
      <PressableScale
        onPress={() => onPress(d.id)}
        onLongPress={onLongPress ? () => onLongPress(d.id) : undefined}
        scaleTo={0.99}
        accessibilityRole="button"
        accessibilityLabel={`${d.name}, ${status.text}, ${downloadProgressLabel(d)}${selectionMode && selected ? ', selected' : ''}`}
        accessibilityActions={[
          { name: 'activate', label: selectionMode ? (selected ? 'Deselect' : 'Select') : 'Open' },
          ...(action && !selectionMode ? [{ name: action.kind, label: action.label }] : []),
          ...(onRemove && !selectionMode ? [{ name: 'remove', label: 'Remove' }] : []),
        ]}
        accessibilityState={{ selected: selectionMode ? selected : undefined }}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') onPress(d.id);
          else if (e.nativeEvent.actionName === 'remove') onRemove?.(d.id);
          else if (action && e.nativeEvent.actionName === action.kind) onAction(d, action);
        }}
        style={styles.press}
      >
        {selectionMode ? (
          <View style={styles.rail}>
            <PixelIcon name={selected ? 'select' : 'checkbox-empty'} size={24} color={selected ? colors.accentText : colors.textMuted} />
          </View>
        ) : showFileIcon ? (
          <View style={styles.rail} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
            <PixelIcon name={downloadCardGlyph(d.name, !!d.stream)} size={24} color={colors.textMuted} />
          </View>
        ) : null}
        <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2} ellipsizeMode="tail">
          {d.name}
        </Text>
        <ProgressBar progress={pct / 100} tone={toneFor(d)} indeterminate={indeterminate} accessibilityLabel={`${d.name} progress`} />
        <StatusLine status={status} />
        </View>
      </PressableScale>
      {subtitle && onSubtitles && !selectionMode ? (
        <View style={styles.subtitleAnchor}>
          <SubtitleCardIcon model={subtitle} onPress={() => onSubtitles(d.id)} />
        </View>
      ) : null}
      {action && !selectionMode ? (
        <View style={styles.actionAnchor}>
          <IconButton icon={action.icon} accessibilityLabel={`${action.label} ${d.name}`} onPress={() => onAction(d, action)} />
        </View>
      ) : null}
    </View>
  );
  return swipeEnabled ? (
    <SwipeRow id={d.id} right={swipe.right} left={swipe.left && !!onRemove} enabled={!selectionMode} onRight={onSwipeRight} onLeft={() => onRemove?.(d.id)}>
      {card}
    </SwipeRow>
  ) : (
    card
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
    a.onRemove === b.onRemove &&
    a.swipeEnabled === b.swipeEnabled &&
    a.onSubtitles === b.onSubtitles &&
    sameCardIcon(a.subtitle, b.subtitle) &&
    a.showFileIcon === b.showFileIcon &&
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
    // A row: the left rail (file icon or selection box, full card height) and the text column.
    press: {
      flexGrow: 1,
      flexDirection: 'row',
      gap: spacing.md,
      paddingLeft: spacing.lg,
      paddingRight: touch.min + spacing.sm,
      paddingVertical: spacing.md,
    },
    rail: { width: 24, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
    body: { flex: 1, gap: spacing.sm, justifyContent: 'space-between' },
    actionAnchor: { position: 'absolute', right: spacing.sm, top: '50%', marginTop: -22, width: touch.min, height: touch.min },
    subtitleAnchor: { position: 'absolute', right: spacing.sm + 8, top: 4, width: 28, height: 28 },
    cardSelected: { borderColor: c.accent, backgroundColor: alpha(c.accent, 0.08) },
    name: { ...type.mono, fontSize: type.size.md, lineHeight: 18, color: c.text, flex: 1 },
  });
