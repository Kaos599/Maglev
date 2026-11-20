import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, spacing, type } from '../constants/theme';
import { haptic } from '../constants/haptics';
import { bookmarkCopy } from '../constants/bookmarkCopy';
import { EmptyBlock, IconButton, ListRow, PressableScale, Screen, Sheet, TextField } from '../components/ui';
import { BookmarkSheet } from '../components/browser/BookmarkSheet';
import { afterSheetCloses } from '../components/browser/FloatingSheet';
import { removeWithUndo } from '../components/browser/bookmarkActions';
import { filterBookmarks, moveBookmark, useBookmarks, type Bookmark } from '../utils/browser/bookmarks';
import { openBrowser } from '../utils/browser/openBrowser';

/** Every bookmark in stored order, with search. States: Empty (none saved), List, NoResults (search matched nothing). */
export default function BrowserBookmarksScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { showNotice } = useMaglevEngine();
  const bookmarks = useBookmarks();
  const [text, setText] = useState('');
  const [menuFor, setMenuFor] = useState<Bookmark | null>(null);
  const [renaming, setRenaming] = useState<Bookmark | null>(null);

  const shown = useMemo(() => filterBookmarks(bookmarks, text), [bookmarks, text]);
  const M = bookmarkCopy.menu;

  // A page opens in the browser (a new tab unless the current one is blank), then this screen is left.
  const open = useCallback(
    (url: string, newTab?: boolean) => {
      haptic('tap');
      openBrowser(router, newTab ? { url, newTab: true } : { url }, 'dismissTo');
    },
    [router],
  );
  const openMenu = (b: Bookmark) => {
    haptic('select');
    setMenuFor(b);
  };

  const body = () => {
    if (bookmarks.length === 0) {
      return <EmptyBlock icon="bookmark" title={bookmarkCopy.empty.title} body={bookmarkCopy.empty.body} />;
    }
    if (shown.length === 0) {
      return <EmptyBlock icon="search" title={bookmarkCopy.noResults.title} body={bookmarkCopy.noResults.body} />;
    }
    return (
      <FlatList
        data={shown}
        keyExtractor={(b) => b.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <View style={styles.row}>
            <PressableScale
              onPress={() => open(item.url)}
              onLongPress={() => openMenu(item)}
              accessibilityRole="button"
              accessibilityLabel={`${item.title}, ${item.host}`}
              accessibilityHint={bookmarkCopy.tileHint}
              style={styles.rowMain}
            >
              <Text style={styles.title} numberOfLines={1}>
                {item.title}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {item.host}
              </Text>
            </PressableScale>
            <IconButton icon="more" accessibilityLabel={bookmarkCopy.moreLabel(item.title)} onPress={() => openMenu(item)} />
          </View>
        )}
      />
    );
  };

  return (
    <Screen
      title={bookmarkCopy.screenTitle}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      edges={['top', 'left', 'right', 'bottom']}
    >
      {bookmarks.length > 0 ? (
        <View style={styles.search}>
          <TextField
            leadingIcon="search"
            clearable
            clearLabel="Clear search"
            value={text}
            onChangeText={setText}
            placeholder={bookmarkCopy.searchPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="search"
            accessibilityLabel={bookmarkCopy.searchLabel}
          />
        </View>
      ) : null}
      <View style={styles.fill}>{body()}</View>

      <Sheet visible={menuFor != null} onClose={() => setMenuFor(null)} title={menuFor?.title ?? bookmarkCopy.screenTitle} subtitle={menuFor?.host}>
        <ListRow
          icon="plus"
          title={M.openNewTab}
          onPress={() => {
            const b = menuFor;
            setMenuFor(null);
            if (b) open(b.url, true);
          }}
        />
        {menuFor && bookmarks[0]?.id !== menuFor.id ? (
          <ListRow
            icon="arrow-up"
            title={M.moveToTop}
            onPress={() => {
              const b = menuFor;
              setMenuFor(null);
              if (b) moveBookmark(b.id, 0);
            }}
          />
        ) : null}
        <ListRow
          icon="pencil"
          title={M.rename}
          onPress={() => {
            const b = menuFor;
            setMenuFor(null);
            if (b) afterSheetCloses(() => setRenaming(b));
          }}
        />
        <ListRow
          icon="trash"
          title={M.remove}
          destructive
          onPress={() => {
            const b = menuFor;
            setMenuFor(null);
            if (b) removeWithUndo(b.id, showNotice);
          }}
        />
      </Sheet>
      <BookmarkSheet visible={renaming != null} onClose={() => setRenaming(null)} url={renaming?.url ?? ''} title={renaming?.title ?? ''} />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    search: { marginHorizontal: spacing.lg, marginBottom: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.lg, paddingRight: spacing.xs },
    rowMain: { flex: 1, minHeight: 56, justifyContent: 'center', minWidth: 0 },
    title: { ...type.body, fontSize: type.size.md, color: c.text },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
  });
