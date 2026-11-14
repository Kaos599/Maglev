import React, { useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { FoundItem } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { useSettings } from '../../context/SettingsContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { formatBytes } from '../../constants/format';
import { banners, foundTray, mobileDataLine } from '../../constants/copy';
import { useDownloadAdmission } from '../../utils/useDownloadAdmission';
import { Banner, Button } from '../ui';
import { FloatingSheet, NoteRow } from './FloatingSheet';
import { batchTotals } from './foundBatch';
import { isInstaller } from './foundFilter';
import { knownSizeOf } from './useFoundSize';

/**
 * The confirm step for several files. One free-space check covers the summed known sizes. Sizes that are not
 * known are counted and named, never guessed. Each file then goes through the single-download path.
 */
export function BatchSheet({ items, onClose, onStart }: { items: FoundItem[] | null; onClose: () => void; onStart: (items: FoundItem[]) => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { onMeteredNetwork } = useMaglevEngine();
  const { settings } = useSettings();
  const last = useRef<FoundItem[]>([]);
  if (items) last.current = items;
  const list = items ?? last.current;
  const totals = useMemo(() => batchTotals(list, knownSizeOf), [list]);
  const { doesntFit } = useDownloadAdmission(totals.knownBytes, items != null);
  const installers = list.some((i) => isInstaller(i));
  const mobileNote = mobileDataLine(onMeteredNetwork, settings.network.wifiOnly, totals.unknownCount > 0 ? null : totals.knownBytes);

  return (
    <FloatingSheet visible={items != null} onClose={onClose} title={foundTray.batchTitle(list.length)}>
      <View style={styles.body}>
        <Text style={styles.meta}>{totals.knownCount > 0 ? foundTray.batchKnown(formatBytes(totals.knownBytes)) : 'Size unknown'}</Text>
        {totals.unknownCount > 0 && totals.knownCount > 0 ? <NoteRow text={foundTray.unknownSizes(totals.unknownCount)} /> : null}
        {mobileNote ? <NoteRow text={mobileNote} /> : null}
        {installers ? <Banner tone="warning" title={banners.browser.installer.title} body={banners.browser.installer.body} /> : null}
        {doesntFit ? <Banner tone="danger" title={banners.addDownload.notEnoughSpace.title} body={banners.addDownload.notEnoughSpace.body} /> : null}
        <View style={styles.actions}>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button
            label="Start"
            disabled={doesntFit || list.length === 0}
            onPress={() => {
              onStart(list);
              onClose();
            }}
          />
        </View>
      </View>
    </FloatingSheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.sm },
    meta: { ...type.mono, fontSize: type.size.sm, color: c.textMuted },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  });
