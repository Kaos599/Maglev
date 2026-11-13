import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Sheet, ListRow } from '../ui';
import { spacing } from '../../constants/theme';
import { addMenu } from '../../constants/copy';

export interface AddMenuSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Text on the clipboard, if any. A web link or magnet enables Paste link. */
  clipboard?: string;
  onPaste: () => void;
  onType: () => void;
  onOpenFile: () => void;
  onSearch: () => void;
  onBrowse: () => void;
}

/** "example.com" for a web link, "Magnet link" for a magnet, null when the text is neither. */
export function clipboardHint(clip?: string): string | null {
  const t = (clip ?? '').trim();
  if (!t) return null;
  if (/^magnet:/i.test(t)) return addMenu.magnet;
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    return new URL(t).host.replace(/^www\./, '');
  } catch {
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  }
}

/** What the + button opens: five ways to add something, one tap each. */
export function AddMenuSheet({ visible, onClose, clipboard, onPaste, onType, onOpenFile, onSearch, onBrowse }: AddMenuSheetProps) {
  const hint = clipboardHint(clipboard);
  // Close first so the sheet slides away while the next screen opens.
  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet visible={visible} onClose={onClose} title={addMenu.title} testID="add-menu-sheet">
      <View style={styles.stack}>
        <ListRow icon="clipboard" title="Paste link" subtitle={hint ?? addMenu.copyFirst} disabled={!hint} onPress={pick(onPaste)} />
        <ListRow icon="link" title="Type a link" subtitle={addMenu.typeHint} onPress={pick(onType)} />
        <ListRow icon="file" title="Open a .torrent file" subtitle={addMenu.fileHint} onPress={pick(onOpenFile)} />
        <ListRow icon="search" title="Find on Search" subtitle={addMenu.searchHint} onPress={pick(onSearch)} />
        <ListRow icon="network" title="Open the browser" subtitle={addMenu.browseHint} onPress={pick(onBrowse)} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({ stack: { gap: spacing.xs } });
