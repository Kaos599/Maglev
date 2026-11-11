import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ScheduleRule } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button, Chip, SegmentedControl, Sheet } from '../ui';
import { PressableScale } from '../ui/PressableScale';
import { DAY_LABELS, LIMIT_PRESETS, isAllDay, isOvernight } from '../../utils/prefs/schedule';
import { TimePickerSheet } from './TimePickerSheet';

export interface RuleSheetProps {
  visible: boolean;
  /** The rule being edited; a fresh draft for "Add rule". */
  rule: ScheduleRule;
  isNew: boolean;
  onClose: () => void;
  onSave: (rule: ScheduleRule) => void;
  onDelete?: () => void;
}

function TimeButton({ label, value, onPress }: { label: string; value: string; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} time ${value}`}
      style={() => [styles.time]}
    >
      <Text style={styles.timeLabel}>{label}</Text>
      <Text style={styles.timeValue}>{value}</Text>
    </PressableScale>
  );
}

export function RuleSheet({ visible, rule, isNew, onClose, onSave, onDelete }: RuleSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [draft, setDraft] = useState<ScheduleRule>(rule);
  const [picking, setPicking] = useState<'start' | 'end' | null>(null);

  useEffect(() => {
    if (visible) setDraft(rule);
  }, [visible, rule]);

  const toggleDay = (d: number) =>
    setDraft((r) => ({ ...r, days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort() }));

  const setAction = (action: 'pause' | 'limit') =>
    setDraft((r) =>
      action === 'pause'
        ? { id: r.id, days: r.days, start: r.start, end: r.end, action }
        : { ...r, action, downBps: r.downBps || LIMIT_PRESETS[2].bps, upBps: r.upBps ?? 0 },
    );

  const noDays = draft.days.length === 0;
  const noLimit = draft.action === 'limit' && !draft.downBps && !draft.upBps;
  const note = isAllDay(draft)
    ? 'Start and end are the same, so this runs all day.'
    : isOvernight(draft)
      ? `Runs overnight, from ${draft.start} until ${draft.end} the next morning. Days mean the day it starts.`
      : null;

  return (
    <Sheet visible={visible} onClose={onClose} title={isNew ? 'New rule' : 'Edit rule'}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={styles.label}>Days</Text>
        <View style={styles.wrap}>
          {DAY_LABELS.map((label, d) => (
            <Chip key={label} label={label} selected={draft.days.includes(d)} onPress={() => toggleDay(d)} />
          ))}
        </View>

        <Text style={styles.label}>Time</Text>
        <View style={styles.timeRow}>
          <TimeButton label="From" value={draft.start} onPress={() => setPicking('start')} />
          <TimeButton label="Until" value={draft.end} onPress={() => setPicking('end')} />
        </View>
        {note ? <Text style={styles.note}>{note}</Text> : null}

        <Text style={styles.label}>What happens</Text>
        <SegmentedControl
          accessibilityLabel="Rule action"
          options={[
            { value: 'pause', label: 'Pause' },
            { value: 'limit', label: 'Limit speed' },
          ]}
          value={draft.action}
          onChange={setAction}
        />

        {draft.action === 'limit' ? (
          <>
            <Text style={styles.label}>Download limit</Text>
            <View style={styles.wrap}>
              {LIMIT_PRESETS.map((p) => (
                <Chip key={p.bps} label={p.label} selected={(draft.downBps ?? 0) === p.bps} onPress={() => setDraft((r) => ({ ...r, downBps: p.bps }))} />
              ))}
            </View>
            <Text style={styles.label}>Upload limit</Text>
            <View style={styles.wrap}>
              {LIMIT_PRESETS.map((p) => (
                <Chip key={p.bps} label={p.label} selected={(draft.upBps ?? 0) === p.bps} onPress={() => setDraft((r) => ({ ...r, upBps: p.bps }))} />
              ))}
            </View>
            {noLimit ? <Text style={styles.error}>Pick a download or upload limit.</Text> : null}
          </>
        ) : null}
        {noDays ? <Text style={styles.error}>Pick at least one day.</Text> : null}

        <View style={styles.actions}>
          {onDelete && !isNew ? <Button label="Delete" variant="danger" onPress={onDelete} /> : null}
          <View style={styles.spacer} />
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button label="Save" onPress={() => onSave(draft)} disabled={noDays || noLimit} />
        </View>
      </ScrollView>
      <TimePickerSheet
        visible={picking !== null}
        title={picking === 'start' ? 'Start time' : 'End time'}
        value={picking === 'end' ? draft.end : draft.start}
        onClose={() => setPicking(null)}
        onSubmit={(v) => {
          setDraft((r) => (picking === 'end' ? { ...r, end: v } : { ...r, start: v }));
          setPicking(null);
        }}
      />
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    label: { ...type.body, fontSize: 13, color: c.textMuted, marginTop: spacing.md, marginBottom: spacing.sm },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    timeRow: { flexDirection: 'row', gap: spacing.md },
    time: {
      flex: 1,
      minHeight: 56,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: c.bg,
      justifyContent: 'center',
    },
    timeLabel: { ...type.body, fontSize: 12, color: c.textMuted },
    timeValue: { ...type.mono, fontSize: 18, color: c.text },
    note: { ...type.body, fontSize: 12, color: c.textMuted, marginTop: spacing.sm },
    error: { ...type.body, fontSize: 13, color: c.danger, marginTop: spacing.sm },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl },
    spacer: { flex: 1 },
  });
