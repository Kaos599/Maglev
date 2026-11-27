import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { TorrentState } from 'maglev-engine';
import { IconActionRow, ListRow, Sheet } from '../ui';
import { spacing } from '../../constants/theme';
import { entrySubtitle, type EntryMode } from '../subtitles/flow';
import { FIND_SUBTITLES } from '../../utils/subtitles/copy';

interface Props {
  visible: boolean;
  onClose: () => void;
  state: TorrentState;
  onCopyMagnet: () => void;
  onShareMagnet: () => void;
  onSaveTorrent: () => void;
  onSpeedLimit: () => void;
  onMove: () => void;
  /** Short summary of the per-torrent limit, or undefined when none is set. */
  limitSummary?: string;
  onOpenFolder: () => void;
  onDelete: () => void;
  /** Opens the Fix problems sheet (the caller closes this menu first). */
  onFixProblems: () => void;
  /** Find subtitles…: finished with exactly one video. Default hidden. */
  subtitles?: EntryMode;
  onFindSubtitles?: () => void;
}

/** Detail overflow: four quick actions, then the settings-like rows, then Fix problems. */
export function TorrentMoreSheet({
  visible,
  onClose,
  state,
  onCopyMagnet,
  onShareMagnet,
  onSaveTorrent,
  onSpeedLimit,
  onMove,
  limitSummary,
  onOpenFolder,
  onDelete,
  onFixProblems,
  subtitles = 'hidden',
  onFindSubtitles,
}: Props) {
  const busy = state === 'CHECKING' || state === 'INITIALIZING' || state === 'MOVING';
  const styles = useMemo(() => makeStyles(), []);
  return (
    <Sheet visible={visible} onClose={onClose} title="Torrent options">
      <IconActionRow
        actions={[
          { key: 'folder', icon: 'folder', label: 'Folder', onPress: onOpenFolder },
          { key: 'share', icon: 'share', label: 'Share', onPress: onShareMagnet },
          { key: 'copy', icon: 'magnet', label: 'Copy link', onPress: onCopyMagnet },
          { key: 'delete', icon: 'trash', label: 'Delete', destructive: true, onPress: onDelete },
        ]}
      />
      <ListRow title="Speed limit" value={limitSummary ?? 'No limit'} icon="speed-limit" onPress={onSpeedLimit} />
      <ListRow
        title="Move to…"
        subtitle={state === 'MOVING' ? 'Moving now' : busy ? 'Wait for the current step to finish' : undefined}
        icon="move"
        disabled={busy}
        onPress={onMove}
      />
      {subtitles !== 'hidden' ? (
        <ListRow
          title={FIND_SUBTITLES}
          subtitle={entrySubtitle(subtitles)}
          icon="file-doc"
          disabled={subtitles !== 'enabled'}
          onPress={onFindSubtitles}
        />
      ) : null}
      <ListRow
        title="Save .torrent file"
        subtitle={state === 'INITIALIZING' ? 'Available once the torrent details load' : undefined}
        icon="file"
        disabled={state === 'INITIALIZING' || state === 'MOVING'}
        onPress={onSaveTorrent}
      />
      <View style={styles.gap} />
      <ListRow title="Fix problems…" icon="recheck" onPress={onFixProblems} />
    </Sheet>
  );
}

interface FixProps {
  visible: boolean;
  onClose: () => void;
  state: TorrentState;
  /** Whole seconds until "Find more peers" is allowed again, or 0. */
  retryInSecs: number;
  onRecheck: () => void;
  onReannounce: () => void;
  /** The SD card is gone, so Recheck is off. */
  storageGone?: boolean;
}

/** Second sheet of the torrent menu: Recheck files and Find more peers. */
export function FixProblemsSheet({ visible, onClose, state, retryInSecs, onRecheck, onReannounce, storageGone = false }: FixProps) {
  const canReannounce = state === 'DOWNLOADING' || state === 'SEEDING';
  const waiting = canReannounce && retryInSecs > 0;
  const peersSubtitle = waiting
    ? `Try again in ${retryInSecs} s`
    : canReannounce
      ? 'Asks trackers again now'
      : 'Available while downloading or seeding';
  return (
    <Sheet visible={visible} onClose={onClose} title="Fix problems" subtitle="Use these when a download is stuck or a file looks wrong.">
      <ListRow
        title="Recheck files"
        subtitle={storageGone ? "The SD card isn't there." : 'Checks every piece against the torrent'}
        icon="recheck"
        disabled={state === 'INITIALIZING' || state === 'CHECKING' || state === 'MOVING' || storageGone}
        onPress={onRecheck}
      />
      <ListRow title="Find more peers" subtitle={peersSubtitle} icon="reannounce" disabled={!canReannounce || waiting} onPress={onReannounce} />
    </Sheet>
  );
}

const makeStyles = () => StyleSheet.create({ gap: { height: spacing.sm } });
