import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { clearBrowserData } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { historyCopy, notices } from '../../constants/copy';
import { PixelIcon } from '../PixelIcon';
import { Banner, Button, ListRow, Sheet } from '../ui';
import { clearHistoryRange } from '../../utils/history';
import { clearSiteChecks } from '../../utils/prefs/search';

export type ClearRange = 'hour' | 'today' | 'week' | 'all';
export type ClearMode = 'range' | 'browsing-data';

const RANGES: ClearRange[] = ['hour', 'today', 'week', 'all'];

/** Machine H3 (NATIVE_CONTRACT 24.9): Choosing, then Clearing, then Done or Failed. */
type Phase = 'choosing' | 'clearing' | 'failed';

interface Data {
  history: boolean;
  cookies: boolean;
  cache: boolean;
}

/**
 * One sheet for both clears. 'range' picks how far back history goes. 'browsing-data' has three checkboxes,
 * all ticked at first. Clear stays disabled until something is chosen.
 */
export function ClearHistorySheet({ visible, mode, onClose }: { visible: boolean; mode: ClearMode; onClose: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const [phase, setPhase] = useState<Phase>('choosing');
  const [range, setRange] = useState<ClearRange | null>(null);
  const [data, setData] = useState<Data>({ history: true, cookies: true, cache: true });

  // Every opening starts at Choosing.
  useEffect(() => {
    if (!visible) return;
    setPhase('choosing');
    setRange(null);
    setData({ history: true, cookies: true, cache: true });
  }, [visible]);

  const chosen = mode === 'range' ? range !== null : data.history || data.cookies || data.cache;
  const busy = phase === 'clearing';

  const run = async () => {
    if (!chosen || busy) return;
    haptic('tap');
    setPhase('clearing');
    try {
      if (mode === 'range') {
        await clearHistoryRange(range as ClearRange);
      } else {
        if (data.cookies || data.cache) {
          const res = await clearBrowserData({ cookies: data.cookies, cache: data.cache });
          if (!res.ok) throw new Error('clearBrowserData');
          // The Cloudflare checks live in the same cookies, so Search forgets them too.
          if (data.cookies) clearSiteChecks();
        }
        if (data.history) await clearHistoryRange('all');
      }
    } catch {
      haptic('fail');
      setPhase('failed');
      return;
    }
    haptic('done');
    showNotice({ message: mode === 'range' ? notices.browser.historyCleared : notices.browser.dataCleared }, 3000);
    setPhase('choosing');
    onClose();
  };

  const copy = historyCopy.sheet;
  const tick = (key: keyof Data) => {
    haptic('select');
    setData((d) => ({ ...d, [key]: !d[key] }));
  };

  return (
    <Sheet
      visible={visible}
      onClose={() => !busy && onClose()}
      title={mode === 'range' ? copy.rangeTitle : copy.dataTitle}
      subtitle={mode === 'range' ? copy.rangeSubtitle : copy.dataSubtitle}
    >
      <View style={styles.body}>
        {mode === 'range'
          ? RANGES.map((r) => (
              <ListRow
                key={r}
                title={copy.ranges[r]}
                selected={range === r}
                disabled={busy}
                onPress={() => {
                  haptic('select');
                  setRange(r);
                }}
              />
            ))
          : (
              [
                ['history', copy.history],
                ['cookies', copy.cookies],
                ['cache', copy.cache],
              ] as [keyof Data, string][]
            ).map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => tick(key)}
                disabled={busy}
                accessibilityRole="checkbox"
                accessibilityLabel={label}
                accessibilityState={{ checked: data[key], disabled: busy }}
                style={styles.checkRow}
              >
                <View style={[styles.box, data[key] && styles.boxOn]}>
                  {data[key] ? <PixelIcon name="check" size={16} color={colors.onAccent} /> : null}
                </View>
                <Text style={styles.checkLabel}>{label}</Text>
              </Pressable>
            ))}
        {phase === 'failed' ? (
          <Banner tone="danger" title={mode === 'range' ? notices.browser.historyClearFailed : notices.browser.dataClearFailed} />
        ) : null}
        <View style={styles.actions}>
          <Button label={copy.cancel} variant="ghost" disabled={busy} onPress={onClose} />
          <Button
            label={phase === 'failed' ? copy.retry : copy.clear}
            variant="danger"
            loading={busy}
            disabled={!chosen || busy}
            onPress={() => void run()}
          />
        </View>
      </View>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    body: { gap: spacing.xs },
    checkRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.xs },
    box: {
      width: 24,
      height: 24,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
    },
    boxOn: { backgroundColor: c.accent, borderColor: c.accent },
    checkLabel: { ...type.body, fontSize: type.size.md, color: c.text, flex: 1 },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.md },
  });
