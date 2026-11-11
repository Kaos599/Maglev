import React, { useEffect, useMemo, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { maglevEngine, type DetailFile } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Banner, Button, ListRow, Sheet } from '../ui';
import { fileName, isMediaFile } from './torrentLabels';

interface MoreSheetProps {
  visible: boolean;
  onClose: () => void;
  onCopyMagnet: () => void;
  onRecheck: () => void;
  onOpenFolder: () => void;
  onDelete: () => void;
}

export function MoreSheet({ visible, onClose, onCopyMagnet, onRecheck, onOpenFolder, onDelete }: MoreSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Torrent options">
      <ListRow title="Copy magnet link" icon="link" onPress={onCopyMagnet} />
      <ListRow title="Recheck files" icon="retry" onPress={onRecheck} />
      <ListRow title="Open folder" icon="folder" onPress={onOpenFolder} />
      <ListRow title="Delete…" icon="trash" destructive onPress={onDelete} />
    </Sheet>
  );
}

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

interface FileSheetProps {
  id: string;
  file: DetailFile | null;
  onClose: () => void;
}

/** Open / Share for completed files; Stream only for media when the engine returns a stream URL. */
export function FileActionsSheet({ id, file, onClose }: FileSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const done = !!file && file.length > 0 && file.progressBytes >= file.length;
  const media = !!file && isMediaFile(file.path);

  useEffect(() => {
    setStreamUrl(null);
    setError(null);
    if (!file || !media) return;
    let alive = true;
    maglevEngine
      .streamUrl(id, file.index)
      .then((res) => {
        if (alive && res.ok) setStreamUrl(res.url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, file, media]);

  const run = async (call: Promise<{ ok: boolean; message?: string }>, fallback: string) => {
    try {
      const res = await call;
      if (!res.ok) setError(res.message || fallback);
      else onClose();
    } catch {
      setError(fallback);
    }
  };

  return (
    <Sheet visible={!!file} onClose={onClose} title={file ? fileName(file.path) : 'File'}>
      {error ? <Banner tone="danger" title="Couldn't do that" body={error} /> : null}
      {file && done ? (
        <>
          <ListRow title="Open" icon="file" onPress={() => run(maglevEngine.openFile(id, file.index), 'No app can open this file.')} />
          <ListRow title="Share" icon="share" onPress={() => run(maglevEngine.shareFile(id, file.index), 'Sharing failed.')} />
        </>
      ) : null}
      {file && streamUrl ? (
        <ListRow
          title="Stream"
          icon="stream"
          onPress={() => {
            Linking.openURL(streamUrl).then(onClose, () => setError('No player app found for this stream.'));
          }}
        />
      ) : null}
      {file && !done && !streamUrl ? <Text style={styles.hint}>Available once the file finishes downloading.</Text> : null}
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    stack: { gap: spacing.sm, marginTop: spacing.sm },
    hint: { ...type.body, fontSize: type.size.md, color: c.textMuted, paddingVertical: spacing.md },
  });
