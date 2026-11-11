import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, alpha, radius, spacing, type } from '../../constants/theme';
import { PixelIcon } from '../PixelIcon';
import { PressableScale } from '../ui';
import type { SourceStatus } from '../../utils/search/types';

export interface ScoreboardEntry {
  status: SourceStatus;
  name: string;
}

function outcome(s: SourceStatus): { text: string; kind: 'ok' | 'empty' | 'fail' | 'wait' | 'check' } {
  switch (s.state) {
    case 'searching':
      return { text: '', kind: 'wait' };
    case 'done':
      return { text: String(s.count), kind: 'ok' };
    case 'empty':
      return { text: '0', kind: 'empty' };
    case 'timeout':
      return { text: 'timed out', kind: 'fail' };
    case 'challenge':
      return { text: 'Needs a quick check', kind: 'check' };
    case 'blocked':
      return { text: 'blocked', kind: 'fail' };
    default:
      return { text: 'failed', kind: 'fail' };
  }
}

/** Three small squares, static: marks a source that has not answered yet. */
function WaitMark({ color }: { color: string }) {
  return (
    <View style={waitStyles.row} accessible={false}>
      {[0.4, 0.7, 1].map((o) => (
        <View key={o} style={[waitStyles.sq, { backgroundColor: color, opacity: o }]} />
      ))}
    </View>
  );
}
const waitStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 2 },
  sq: { width: 3, height: 3 },
});

export function SourceScoreboard({
  entries,
  selected,
  onSelect,
  onSolve,
}: {
  entries: ScoreboardEntry[];
  /** Provider id the list is filtered to, or null. */
  selected: string | null;
  onSelect: (providerId: string | null) => void;
  /** Tapping a source that needs a Cloudflare check opens the solver for it. */
  onSolve?: (providerId: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.wrap}>
      {entries.map(({ status, name }) => {
        const o = outcome(status);
        const isSel = selected === status.providerId;
        const tone = o.kind === 'fail' || o.kind === 'check' ? colors.danger : o.kind === 'empty' ? colors.textMuted : colors.text;
        const canFilter = o.kind === 'ok';
        const canSolve = o.kind === 'check' && !!onSolve;
        const label =
          o.kind === 'wait' ? `${name}, still searching` : `${name}, ${o.kind === 'ok' ? `${status.count} results` : o.kind === 'empty' ? 'no results' : o.text}`;
        return (
          <PressableScale
            key={status.providerId}
            onPress={canFilter ? () => onSelect(isSel ? null : status.providerId) : canSolve ? () => onSolve?.(status.providerId) : undefined}
            disabled={!canFilter && !canSolve}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={canFilter ? (isSel ? 'Show all sources' : 'Show only this source') : canSolve ? 'Opens a quick check for this source' : undefined}
            accessibilityState={{ selected: isSel, disabled: !canFilter && !canSolve }}
            style={() => [
              styles.chip,
              o.kind === 'ok' && styles.ok,
              o.kind === 'empty' && styles.empty,
              (o.kind === 'fail' || o.kind === 'check') && styles.fail,
              o.kind === 'wait' && styles.wait,
              isSel && styles.selected,
            ]}
          >
            {o.kind === 'fail' || o.kind === 'check' ? <PixelIcon name="warning" size={16} color={colors.danger} /> : null}
            <Text style={[styles.name, { color: isSel ? colors.accentText : o.kind === 'wait' ? colors.textMuted : colors.text }]} numberOfLines={1}>
              {name}
            </Text>
            {o.kind === 'wait' ? <WaitMark color={colors.accentText} /> : <Text style={[styles.count, { color: tone }]}>{o.text}</Text>}
          </PressableScale>
        );
      })}
    </View>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
    },
    ok: { backgroundColor: c.surface, borderColor: c.border },
    empty: { backgroundColor: 'transparent', borderColor: c.borderStrong, borderStyle: 'dashed' },
    fail: { backgroundColor: alpha(c.danger, 0.12), borderColor: c.danger },
    wait: { backgroundColor: 'transparent', borderColor: c.border },
    selected: { borderColor: c.accentText, backgroundColor: alpha(c.accent, 0.15) },
    name: { ...type.body, fontSize: 12 },
    count: { ...type.monoBold, fontSize: 12 },
  });
