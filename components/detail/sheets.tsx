import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { maglevEngine, type DetailFile, type PausedBy, type TorrentState } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Banner, Button, ListRow, Sheet } from '../ui';
import { fileName, isStreamable, streamReadiness } from './torrentLabels';

interface DeleteSheetProps {
  visible: boolean;
  name: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRemove: () => void;
  onDeleteFiles: () => void;
}

export function DeleteSheet({ visible, name, busy, error, onClose, onRemove, onDeleteFiles }: DeleteSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Sheet visible={visible} onClose={onClose} title="Delete torrent?" subtitle={name}>
      {error ? <Banner tone="danger" title="Couldn't delete" body={error} /> : null}
      <View style={styles.stack}>
        <Button label="Remove from list" variant="secondary" fullWidth loading={busy} onPress={onRemove} />
        <Button label="Delete with files" variant="danger" fullWidth disabled={busy} onPress={onDeleteFiles} />
        <Button label="Cancel" variant="ghost" fullWidth disabled={busy} onPress={onClose} />
      </View>
    </Sheet>
  );
}

interface SavedTorrentSheetProps {
  /** The result of `exportTorrent`, or null when the sheet is closed. */
  saved: { path: string; name: string; folder: string } | null;
  onClose: () => void;
}

/** Shown after "Save .torrent file": where it went, and a Share button (NATIVE_CONTRACT 15). */
export function SavedTorrentSheet({ saved, onClose }: SavedTorrentSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [saved]);

  const share = async () => {
    if (!saved) return;
    try {
      const res = await maglevEngine.shareExportedTorrent(saved.path);
      if (!res.ok) setError(res.message || 'Sharing failed.');
      else onClose();
    } catch {
      setError('Sharing failed.');
    }
  };

  return (
    <Sheet visible={!!saved} onClose={onClose} title="Saved" subtitle={saved ? `${saved.folder}/${saved.name}` : undefined}>
      {error ? <Banner tone="danger" title="Couldn't share" body={error} /> : null}
      <Text style={styles.hint}>The file keeps this torrent's current trackers.</Text>
      <View style={styles.stack}>
        <Button label="Share" icon="share" variant="secondary" fullWidth onPress={share} />
        <Button label="Done" variant="ghost" fullWidth onPress={onClose} />
      </View>
    </Sheet>
  );
}

interface FileSheetProps {
  id: string;
  file: DetailFile | null;
  torrentState: TorrentState;
  pausedBy: PausedBy | null;
  /** Resumes the torrent; resolves true on success. */
  onResume: () => Promise<boolean>;
  onNotice: (text: string) => void;
  onClose: () => void;
}

/** Open and Share for finished files; Stream for video and audio, finished or not (NATIVE_CONTRACT 11.4). */
export function FileActionsSheet({ id, file, torrentState, pausedBy, onResume, onNotice, onClose }: FileSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [file]);

  const done = !!file && file.length > 0 && file.progressBytes >= file.length;
  const streamable = !!file && isStreamable(file.path);
  const skipped = !!file && file.priority === 'skip';
  const moving = torrentState === 'MOVING';
  const readiness = file ? streamReadiness(file) : null;

  const run = async (call: Promise<{ ok: boolean; message?: string }>, fallback: string) => {
    try {
      const res = await call;
      if (!res.ok) setError(res.message || fallback);
      else onClose();
    } catch {
      setError(fallback);
    }
  };

  const stream = async () => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const userPaused = torrentState === 'PAUSED' && pausedBy === 'user';
      if (userPaused && !(await onResume())) {
        setError("Couldn't resume the torrent.");
        return;
      }
      const url = await maglevEngine.streamUrl(id, file.index);
      if (!url.ok) {
        setError(url.message || "Couldn't start the stream.");
        return;
      }
      const res = await maglevEngine.openStream(url.url, url.mime, fileName(file.path));
      if (!res.ok) {
        setError(res.message || 'No video player found. Install VLC or another player.');
        return;
      }
      if (userPaused) onNotice('Resumed to stream');
      onClose();
    } catch {
      setError("Couldn't start the stream.");
    } finally {
      setBusy(false);
    }
  };

  const streamSubtitle = skipped
    ? "Skipped files can't be streamed. Set a priority first."
    : moving
      ? 'Wait for the move to finish'
      : readiness?.ready
        ? 'Ready to play'
        : `Starting may pause to buffer (${readiness?.percent ?? 0}% ready)`;

  return (
    <Sheet visible={!!file} onClose={onClose} title={file ? fileName(file.path) : 'File'}>
      {error ? <Banner tone="danger" title="Couldn't do that" body={error} /> : null}
      {file && done ? (
        <>
          <ListRow title="Open" icon="file" onPress={() => run(maglevEngine.openFile(id, file.index), 'No app can open this file.')} />
          <ListRow title="Share" icon="share" onPress={() => run(maglevEngine.shareFile(id, file.index), 'Sharing failed.')} />
        </>
      ) : null}
      {file && streamable ? (
        <ListRow title="Stream" subtitle={streamSubtitle} icon="stream" disabled={skipped || moving || busy} onPress={stream} />
      ) : null}
      {file && !done && !streamable ? <Text style={styles.hint}>Available once the file finishes downloading.</Text> : null}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm, marginTop: spacing.sm },
    hint: { ...type.body, fontSize: type.size.md, color: c.textMuted, paddingVertical: spacing.md },
  });
