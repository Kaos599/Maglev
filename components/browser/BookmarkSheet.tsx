import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { bookmarkCopy } from '../../constants/bookmarkCopy';
import { useBookmarks, findBookmark, renameBookmark } from '../../utils/browser/bookmarks';
import { Button, ListRow, Sheet, TextField } from '../ui';
import { addWithNotice, removeWithUndo } from './bookmarkActions';

export interface BookmarkSheetProps {
  visible: boolean;
  onClose: () => void;
  /** The page's address. A page that is already bookmarked opens the sheet in edit mode. */
  url: string;
  /** The page's title, offered as the name when adding. */
  title: string;
}

/**
 * Add or edit a bookmark. The name is editable; the address is shown as it is and can't change (a different
 * address is a different bookmark). Editing also offers Remove, with Undo.
 */
export function BookmarkSheet({ visible, onClose, url, title }: BookmarkSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const list = useBookmarks();
  const existing = findBookmark(list, url);
  const [name, setName] = useState('');

  useEffect(() => {
    if (visible) setName(existing?.title ?? title);
    // Only when the sheet opens: later list changes must not overwrite what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const save = () => {
    if (existing) renameBookmark(existing.id, name);
    else addWithNotice(url, name, showNotice);
    onClose();
  };

  const c = bookmarkCopy.sheet;
  return (
    <Sheet visible={visible} onClose={onClose} title={existing ? c.editTitle : c.addTitle} testID="bookmark-sheet">
      <View style={styles.body}>
        <TextField
          label={c.nameLabel}
          value={name}
          onChangeText={setName}
          onSubmitEditing={save}
          returnKeyType="done"
          clearable
          clearLabel="Clear name"
          onSurface
          autoCapitalize="sentences"
        />
        <View style={styles.address}>
          <Text style={styles.addressLabel}>{c.addressLabel}</Text>
          <Text style={styles.addressValue} selectable numberOfLines={2}>
            {url}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button label={c.save} onPress={save} />
          <Button label={c.cancel} variant="secondary" onPress={onClose} />
        </View>
        {existing ? (
          <ListRow
            icon="trash"
            title={bookmarkCopy.menu.remove}
            destructive
            onPress={() => {
              onClose();
              removeWithUndo(existing.id, showNotice);
            }}
          />
        ) : null}
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.md, paddingBottom: spacing.md },
    address: { gap: spacing.xs },
    addressLabel: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    addressValue: { ...type.mono, fontSize: type.size.sm, color: c.text },
    actions: { gap: spacing.sm },
  });
