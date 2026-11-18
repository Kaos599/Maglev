import React from 'react';
import type { PausedBy, TorrentState } from 'maglev-engine';
import { ListRow, Sheet } from '../ui';
import { entrySubtitle, type EntryMode } from '../subtitles/flow';
import { FIND_SUBTITLES } from '../../utils/subtitles/copy';

interface Props {
  visible: boolean;
  onClose: () => void;
  state: TorrentState;
  /** `seed_limit` turns Resume into Seed again. */
  pausedBy?: PausedBy | null;
  /** Whole seconds until "Find more peers" is allowed again, or 0. */
  retryInSecs: number;
  onTogglePause: () => void;
  onRecheck: () => void;
  onReannounce: () => void;
  onCopyMagnet: () => void;
  onShareMagnet: () => void;
  onSaveTorrent: () => void;
  onSpeedLimit: () => void;
  onMove: () => void;
  /** Short summary of the per-torrent limit, or undefined when none is set. */
  limitSummary?: string;
  onOpenFolder: () => void;
  onDelete: () => void;
  /** NATIVE_CONTRACT 47.4: a file health tag holds the torrent. It needs Recheck, so there is no Resume. */
  heldByFiles?: boolean;
  /** SM-33: the SD card is gone, so Recheck is off. */
  storageGone?: boolean;
  /** Find subtitles… (36.10): finished with exactly one video. Default hidden. */
  subtitles?: EntryMode;
  onFindSubtitles?: () => void;
}

const RUNNING: readonly TorrentState[] = ['DOWNLOADING', 'SEEDING', 'QUEUED'];

/** Detail overflow (UI_SPEC S9.3). */
export function TorrentMoreSheet({
  visible,
  onClose,
  state,
  pausedBy,
  retryInSecs,
  onTogglePause,
  onRecheck,
  onReannounce,
  onCopyMagnet,
  onShareMagnet,
  onSaveTorrent,
  onSpeedLimit,
  onMove,
  limitSummary,
  onOpenFolder,
  onDelete,
  storageGone = false,
  heldByFiles = false,
  subtitles = 'hidden',
  onFindSubtitles,
}: Props) {
  const running = RUNNING.includes(state);
  const busy = state === 'CHECKING' || state === 'INITIALIZING' || state === 'MOVING';
  const canTogglePause = !busy;
  const canReannounce = state === 'DOWNLOADING' || state === 'SEEDING';
  const waiting = canReannounce && retryInSecs > 0;
  const peersSubtitle = waiting
    ? `Try again in ${retryInSecs} s`
    : canReannounce
      ? 'Asks trackers and DHT again'
      : 'Available while downloading or seeding';
  return (
    <Sheet visible={visible} onClose={onClose} title="Torrent options">
      {heldByFiles && !running ? null : (
        <ListRow
          title={running ? 'Pause' : state === 'PAUSED' && pausedBy === 'seed_limit' ? 'Seed again' : 'Resume'}
          icon={running ? 'pause' : 'play'}
          disabled={!canTogglePause}
          onPress={onTogglePause}
        />
      )}
      <ListRow
        title="Recheck files"
        subtitle={storageGone ? "The SD card isn't there." : 'Verify everything on disk'}
        icon="recheck"
        disabled={state === 'MOVING' || storageGone}
        onPress={onRecheck}
      />
      <ListRow
        title="Find more peers"
        subtitle={peersSubtitle}
        icon="reannounce"
        disabled={!canReannounce || waiting}
        onPress={onReannounce}
      />
      <ListRow title="Copy magnet" icon="magnet" onPress={onCopyMagnet} />
      <ListRow title="Share magnet link" icon="share" onPress={onShareMagnet} />
      <ListRow
        title="Save .torrent file"
        subtitle={state === 'INITIALIZING' ? 'Available once the torrent details load' : 'Keeps the current trackers'}
        icon="file"
        disabled={state === 'INITIALIZING' || state === 'MOVING'}
        onPress={onSaveTorrent}
      />
      <ListRow title="Speed limit"subtitle={limitSummary ?? 'No limit'} icon="speed-limit" onPress={onSpeedLimit} />
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
      <ListRow title="Open folder" icon="folder" onPress={onOpenFolder} />
      <ListRow title="Delete…" icon="trash" destructive onPress={onDelete} />
    </Sheet>
  );
}
