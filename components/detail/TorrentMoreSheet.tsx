import React from 'react';
import type { TorrentState } from 'maglev-engine';
import { ListRow, Sheet } from '../ui';

interface Props {
  visible: boolean;
  onClose: () => void;
  state: TorrentState;
  /** Whole seconds until "Find more peers" is allowed again, or 0. */
  retryInSecs: number;
  onTogglePause: () => void;
  onRecheck: () => void;
  onReannounce: () => void;
  onCopyMagnet: () => void;
  onOpenFolder: () => void;
  onDelete: () => void;
}

const RUNNING: readonly TorrentState[] = ['DOWNLOADING', 'SEEDING', 'QUEUED'];

/** Detail overflow (UI_SPEC S9.3). */
export function TorrentMoreSheet({
  visible,
  onClose,
  state,
  retryInSecs,
  onTogglePause,
  onRecheck,
  onReannounce,
  onCopyMagnet,
  onOpenFolder,
  onDelete,
}: Props) {
  const running = RUNNING.includes(state);
  const canTogglePause = state !== 'CHECKING' && state !== 'INITIALIZING';
  const canReannounce = state === 'DOWNLOADING' || state === 'SEEDING';
  const waiting = canReannounce && retryInSecs > 0;
  const peersSubtitle = waiting
    ? `Try again in ${retryInSecs} s`
    : canReannounce
      ? 'Asks trackers and DHT again'
      : 'Available while downloading or seeding';
  return (
    <Sheet visible={visible} onClose={onClose} title="Torrent options">
      <ListRow
        title={running ? 'Pause' : 'Resume'}
        icon={running ? 'pause' : 'play'}
        disabled={!canTogglePause}
        onPress={onTogglePause}
      />
      <ListRow title="Recheck files" subtitle="Verify everything on disk" icon="recheck" onPress={onRecheck} />
      <ListRow
        title="Find more peers"
        subtitle={peersSubtitle}
        icon="reannounce"
        disabled={!canReannounce || waiting}
        onPress={onReannounce}
      />
      <ListRow title="Copy magnet" icon="magnet" onPress={onCopyMagnet} />
      <ListRow title="Open folder" icon="folder" onPress={onOpenFolder} />
      <ListRow title="Delete…" icon="trash" destructive onPress={onDelete} />
    </Sheet>
  );
}
