import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { FreeSpace } from 'maglev-engine';
import { useTheme } from '../context/ThemeContext';
import { useMaglevEngine } from '../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../constants/theme';
import { formatBytes } from '../constants/format';
import { storageCopy } from '../constants/copy';
import { Button, EmptyBlock, Screen } from '../components/ui';
import { Checkbox } from '../components/detail/Checkbox';
import { DeleteSheet } from '../components/transfers/DeleteSheet';
import { buildFinishedRows, reserveBytes, selectedBytes, usableFree, type FinishedRow } from '../components/transfers/freeSpace';

/**
 * Free up space (docs/contracts-0.19/play-and-storage.md section 3): free space against the reserve, then finished
 * torrents and finished link downloads, largest first. Sizes come from the engine; an unknown one shows a dash.
 */
export default function FreeSpaceScreen() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const { telemetry, downloads, getFreeSpace, deleteTorrent, removeDownload, removeTransfers, showNotice } = useMaglevEngine();
  const [space, setSpace] = useState<FreeSpace | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Real free space, read again whenever the list changes (a delete frees bytes).
  const rows = useMemo(() => buildFinishedRows(telemetry.torrents, downloads), [telemetry.torrents, downloads]);
  useEffect(() => {
    let alive = true;
    getFreeSpace()
      .then((res) => {
        if (alive) setSpace(res.ok ? res : null);
      })
      .catch(() => {
        if (alive) setSpace(null);
      });
    return () => {
      alive = false;
    };
  }, [getFreeSpace, rows.length]);

  const free = usableFree(space);
  const reserve = space ? reserveBytes(space.totalBytes) : null;
  const low = free !== null && reserve !== null && free < reserve;
  const bytes = selectedBytes(rows, selected);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const remove = useCallback(
    async (ids: readonly string[], deleteFiles: boolean) => {
      const chosen = rows.filter((r) => ids.includes(r.id));
      if (!deleteFiles) {
        removeTransfers(
          chosen.filter((r) => r.kind === 'torrent').map((r) => r.id),
          chosen.filter((r) => r.kind === 'download').map((r) => r.id),
        );
        setSelected(new Set());
        return;
      }
      const results = await Promise.all(
        chosen.map((r) => (r.kind === 'torrent' ? deleteTorrent(r.id, true) : removeDownload(r.id, true)).catch(() => false)),
      );
      const done = results.filter(Boolean).length;
      setSelected(new Set());
      showNotice({ message: done === chosen.length ? storageCopy.removed(done) : storageCopy.removeFailed });
    },
    [rows, deleteTorrent, removeDownload, removeTransfers, showNotice],
  );

  const renderRow = useCallback(
    ({ item }: { item: FinishedRow }) => {
      const on = selected.has(item.id);
      return (
        <View style={[styles.row, on && styles.rowOn]}>
          <Checkbox checked={on} onChange={() => toggle(item.id)} accessibilityLabel={`Select ${item.name}`} />
          <View style={styles.rowText}>
            <Text style={styles.name} numberOfLines={2}>
              {item.name}
            </Text>
            <Text style={styles.size}>{item.size === null ? storageCopy.unknown : formatBytes(item.size)}</Text>
          </View>
          <Button
            label={storageCopy.removeAction}
            icon="trash"
            variant="ghost"
            onPress={() => {
              setSelected(new Set([item.id]));
              setConfirmOpen(true);
            }}
          />
        </View>
      );
    },
    [selected, styles, toggle],
  );

  return (
    <Screen title={storageCopy.screenTitle} onBack={() => router.back()}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.summary}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>{storageCopy.freeLabel}</Text>
          <Text style={[styles.statValue, low && { color: colors.danger }]}>{free === null ? storageCopy.unknown : formatBytes(free)}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>{storageCopy.reserveLabel}</Text>
          <Text style={styles.statValue}>{reserve === null ? storageCopy.unknown : formatBytes(reserve)}</Text>
        </View>
      </View>
      {low ? <Text style={styles.low}>{storageCopy.pausedTitle}</Text> : null}
      {rows.length === 0 ? (
        <EmptyBlock icon="folder" title={storageCopy.emptyTitle} body={storageCopy.emptyBody} />
      ) : (
        <>
          <View style={styles.listHead}>
            <Text style={styles.listTitle}>{storageCopy.listTitle}</Text>
            <Button
              label={selected.size === rows.length ? storageCopy.selectNone : storageCopy.selectAll}
              variant="ghost"
                onPress={() => setSelected(selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)))}
            />
          </View>
          <FlatList data={rows} keyExtractor={(r) => r.key} renderItem={renderRow} extraData={selected} contentContainerStyle={styles.list} />
        </>
      )}
      {selected.size > 0 ? (
        <View style={styles.bar}>
          <Button label={storageCopy.removeSelected(selected.size)} icon="trash" variant="danger" fullWidth onPress={() => setConfirmOpen(true)} />
        </View>
      ) : null}
      <DeleteSheet
        visible={confirmOpen}
        count={selected.size}
        bytes={bytes}
        onClose={() => setConfirmOpen(false)}
        onConfirm={(deleteFiles) => {
          setConfirmOpen(false);
          void remove([...selected], deleteFiles);
        }}
      />
    </Screen>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    summary: { flexDirection: 'row', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
    stat: { flex: 1, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, padding: spacing.md, gap: spacing.xs },
    statLabel: { ...type.body, fontSize: type.size.sm, color: c.textMuted },
    statValue: { ...type.mono, fontSize: type.size.lg, color: c.text },
    low: { ...type.body, fontSize: type.size.md, color: c.danger, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
    listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg },
    listTitle: { ...type.body, fontSize: type.size.sm, color: c.textMuted, flex: 1 },
    list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 56, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.lg, paddingRight: spacing.sm },
    rowOn: { borderColor: c.accent },
    rowText: { flex: 1, gap: 2 },
    name: { ...type.mono, fontSize: 13, color: c.text },
    size: { ...type.mono, fontSize: 12, color: c.textMuted },
    bar: { padding: spacing.lg, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg },
  });
