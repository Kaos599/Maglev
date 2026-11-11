import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import type { ScheduleRule, ScheduleStatus } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, SettingsPage } from '../../components/settings/SettingsParts';
import { RuleSheet } from '../../components/schedule/RuleSheet';
import {
  NIGHT_PRESET,
  actionLabel,
  daysLabel,
  formatClock,
  isAllDay,
  isOvernight,
  pauseRule,
  updateSchedule,
  useSchedule,
} from '../../utils/prefs/schedule';

const STATUS_REFRESH_MS = 30_000;

function statusLine(status: ScheduleStatus | null, rules: ScheduleRule[], enabled: boolean): string {
  if (!enabled) return 'Schedule is off';
  if (!status) return 'Checking the schedule';
  const until = status.nextBoundary ? formatClock(status.nextBoundary) : null;
  if (status.paused) return until ? `Paused now · resumes ${until}` : 'Paused now';
  const active = rules.filter((r) => status.activeRuleIds.includes(r.id));
  const limit = active.find((r) => r.action === 'limit');
  if (limit) return `Active rule: ${actionLabel(limit)}${until ? ` until ${until}` : ''}`;
  return 'No rule active';
}

export default function SchedulingSettings() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [schedule] = useSchedule();
  const [status, setStatus] = useState<ScheduleStatus | null>(null);
  const [editing, setEditing] = useState<{ rule: ScheduleRule; isNew: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await maglevEngine.getScheduleStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  // Native applies the new schedule asynchronously, so look again shortly after a change.
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 250); // after the push transition
    const quick = setTimeout(() => void refresh(), 600);
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearTimeout(quick);
      clearInterval(timer);
    };
  }, [refresh, schedule]);

  const hasNightRule = schedule.rules.some(
    (r) => r.action === 'pause' && r.start === NIGHT_PRESET.end && r.end === NIGHT_PRESET.start && r.days.length === 7,
  );

  const saveRule = (rule: ScheduleRule) => {
    updateSchedule((s) => ({
      rules: s.rules.some((r) => r.id === rule.id) ? s.rules.map((r) => (r.id === rule.id ? rule : r)) : [...s.rules, rule],
    }));
    setEditing(null);
  };

  const deleteRule = (id: string) => {
    updateSchedule((s) => ({ rules: s.rules.filter((r) => r.id !== id) }));
    setEditing(null);
  };

  return (
    <SettingsPage title="SCHEDULING">
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <ListRow
          icon="schedule"
          title="Use a schedule"
          subtitle="Pause or slow downloads at set times."
          accessory={
            <Toggle
              value={schedule.enabled}
              onValueChange={(enabled) => updateSchedule({ enabled })}
              accessibilityLabel="Use a schedule"
            />
          }
        />
      </Card>
      <Text style={styles.status} accessibilityLiveRegion="polite">
        {statusLine(status, schedule.rules, schedule.enabled)}
      </Text>

      {hasNightRule ? null : (
        <Button
          label={`Only download at night (${NIGHT_PRESET.start}–${NIGHT_PRESET.end})`}
          variant="secondary"
          icon="moon"
          onPress={() => {
            // "Only at night" means paused outside 07:00-01:00, so the pause window is the daytime.
            updateSchedule((s) => ({ enabled: true, rules: [...s.rules, pauseRule(NIGHT_PRESET.end, NIGHT_PRESET.start)] }));
          }}
        />
      )}

      <View style={styles.section}>
        <SectionHeader title="Rules" />
        {schedule.rules.length === 0 ? (
          <Caption>No rules yet. Add one to pause or limit speed at certain times.</Caption>
        ) : (
          <Card>
            {schedule.rules.map((r) => (
              <ListRow
                key={r.id}
                title={`${r.start}–${r.end} · ${actionLabel(r)}`}
                subtitle={`${daysLabel(r.days)}${isAllDay(r) ? ' · All day' : isOvernight(r) ? ' · Overnight' : ''}`}
                onPress={() => setEditing({ rule: r, isNew: false })}
              />
            ))}
          </Card>
        )}
        <Button
          label="Add rule"
          icon="plus"
          variant="secondary"
          onPress={() => setEditing({ rule: pauseRule('09:00', '17:00'), isNew: true })}
        />
      </View>

      {editing ? (
        <RuleSheet
          visible
          rule={editing.rule}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
          onSave={saveRule}
          onDelete={() => deleteRule(editing.rule.id)}
        />
      ) : null}
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    status: { ...type.mono, fontSize: 13, color: c.textMuted, paddingHorizontal: spacing.xs },
    section: { gap: spacing.sm },
  });
