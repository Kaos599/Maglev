import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { maglevEngine, type DetailFile } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { OPEN_FOLDER_FAILED_TEXT } from '../../utils/downloadCopy';
import { fileKind } from '../../utils/fileKind';
import { pickMainFile } from '../../utils/mainFile';
import { Button, ListRow, Sheet } from '../ui';
import { fileName } from './torrentLabels';

interface DoneActionsProps {
  id: string;
  files: readonly DetailFile[];
  onNotice: (n: { tone: 'info' | 'danger'; text: string }) => void;
}

type Result = { ok: boolean; message?: string };

/** SM-17: Open, Share and Open folder at the top of a finished torrent. Several videos (a season pack) ask which one. */
export function DoneActions({ id, files, onNotice }: DoneActionsProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [chooser, setChooser] = useState<'open' | 'share' | null>(null);

  const pick = useMemo(() => pickMainFile(files), [files]);
  const askFirst = pick.videos.length > 1;
  const target = pick.main;
  if (!target && !askFirst) return null;

  const report = async (call: Promise<Result>, fallback: string) => {
    try {
      const res = await call;
      if (!res.ok) onNotice({ tone: 'danger', text: res.message || fallback });
    } catch {
      onNotice({ tone: 'danger', text: fallback });
    }
  };
  const open = (index: number) => report(maglevEngine.openFile(id, index), 'No app can open this file.');
  const share = (index: number) => report(maglevEngine.shareFile(id, index), 'Sharing failed.');
  const folder = () => report(maglevEngine.openFolder(id), OPEN_FOLDER_FAILED_TEXT);

  const onOpen = () => (askFirst ? setChooser('open') : target && void open(target.index));
  const onShare = () => (askFirst ? setChooser('share') : target && void share(target.index));
  const choose = (index: number) => {
    const action = chooser;
    setChooser(null);
    void (action === 'share' ? share(index) : open(index));
  };

  const isVideo = askFirst || (target ? fileKind(target.path) === 'video' : false);

  return (
    <View style={styles.wrap}>
      <Button label="Open" icon={isVideo ? 'play' : 'file'} size="lg" fullWidth onPress={onOpen} />
      <View style={styles.row}>
        <View style={styles.half}>
          <Button label="Share" icon="share" variant="secondary" fullWidth onPress={onShare} />
        </View>
        <View style={styles.half}>
          <Button label="Open folder" icon="folder" variant="secondary" fullWidth onPress={() => void folder()} />
        </View>
      </View>
      <Sheet visible={chooser !== null} onClose={() => setChooser(null)} title={chooser === 'share' ? 'Share which file?' : 'Open which file?'}>
        <Text style={styles.hint}>This torrent has several videos.</Text>
        {pick.videos.map((f) => (
          <ListRow key={f.index} title={fileName(f.path)} subtitle={formatBytes(f.length)} icon="file-video" onPress={() => choose(f.index)} />
        ))}
      </Sheet>
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { marginBottom: spacing.md, gap: spacing.sm },
    row: { flexDirection: 'row', gap: spacing.sm },
    half: { flex: 1 },
    hint: { ...type.body, fontSize: type.size.md, color: c.textMuted, paddingVertical: spacing.sm },
  });

/** Open folder works in every state, so it lives outside the finished-only actions. */
export function OpenFolderButton({ id, onNotice }: { id: string; onNotice: DoneActionsProps['onNotice'] }) {
  const onPress = async () => {
    try {
      const res = await maglevEngine.openFolder(id);
      if (!res.ok) onNotice({ tone: 'danger', text: res.message || OPEN_FOLDER_FAILED_TEXT });
    } catch {
      onNotice({ tone: 'danger', text: OPEN_FOLDER_FAILED_TEXT });
    }
  };
  return <Button label="Open folder" icon="folder" variant="secondary" fullWidth onPress={() => void onPress()} />;
}
