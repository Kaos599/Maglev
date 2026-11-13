import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import type { FeedAutomationStatus, FeedRule } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Button, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';
import { RuleEditorSheet } from '../../components/feeds/RuleEditorSheet';
import { Feed, FeedItem, fetchFeed, loadFeeds, relativeTime } from '../../utils/feeds';
import { INTERVALS, newFeedRule, updateFeedAutomation, useFeedAutomation } from '../../utils/prefs/feedAutomation';

const STATUS_REFRESH_MS = 20_000;
/** Let the push transition finish before reading storage or calling native (InteractionManager is gone from RN 0.88). */
const SETTLE_MS = 250;

function ruleSubtitle(r: FeedRule, feeds: Feed[]): string {
  const where = r.feedIds.length === 0 ? 'All feeds' : feeds.filter((f) => r.feedIds.includes(f.id)).map((f) => f.name).join(', ') || 'Feed removed';
  return `${r.include.trim() || 'Anything'} · ${where}`;
}

export default function AutoDownloadSettings() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [auto] = useFeedAutomation();
  // The saved feed list is read after the transition, not during the first render.
  const [loadedFeeds, setFeeds] = useState<Feed[] | null>(null);
  const feeds = useMemo(() => loadedFeeds ?? [], [loadedFeeds]);
  const [itemsByFeed, setItemsByFeed] = useState<Record<string, FeedItem[] | undefined>>({});
  const [status, setStatus] = useState<FeedAutomationStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState<{ rule: FeedRule; isNew: boolean } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setFeeds(loadFeeds()), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  // Load the feeds once so the rule editor can preview matches.
  useEffect(() => {
    let alive = true;
    for (const f of feeds) {
      fetchFeed(f.url)
        .then((p) => {
          if (alive) setItemsByFeed((prev) => ({ ...prev, [f.id]: p.items.map((i) => ({ ...i, feedId: f.id })) }));
        })
        .catch(() => {
          if (alive) setItemsByFeed((prev) => ({ ...prev, [f.id]: [] }));
        });
    }
    return () => {
      alive = false;
    };
  }, [feeds]);

  const refresh = useCallback(async () => {
    try {
      setStatus(await maglevEngine.getFeedAutomationStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), SETTLE_MS);
    const timer = setInterval(() => void refresh(), STATUS_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);

  const checkNow = async () => {
    setChecking(true);
    try {
      await maglevEngine.runFeedCheckNow();
      // The check runs in the background; look again once it has had time to start.
      setTimeout(() => void refresh(), 2500);
    } catch {
      // Status below keeps showing the last known state.
    } finally {
      setChecking(false);
    }
  };

  const saveRule = (rule: FeedRule) => {
    updateFeedAutomation((p) => ({
      rules: p.rules.some((r) => r.id === rule.id) ? p.rules.map((r) => (r.id === rule.id ? rule : r)) : [...p.rules, rule],
    }));
    setEditing(null);
  };

  const deleteRule = (id: string) => {
    updateFeedAutomation((p) => ({ rules: p.rules.filter((r) => r.id !== id) }));
    setEditing(null);
  };

  return (
    <SettingsPage title="Auto-download">
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <ListRow
          icon="feeds"
          title="Download new items automatically"
          subtitle="Checks your feeds in the background and adds matching torrents."
          accessory={
            <Toggle
              value={auto.enabled}
              onValueChange={(enabled) => updateFeedAutomation({ enabled })}
              accessibilityLabel="Download new items automatically"
            />
          }
        />
      </Card>

      <ChipGroup
        label="Check every"
        options={INTERVALS.map((m) => ({ value: m, label: `${m} min` }))}
        value={auto.intervalMins}
        onChange={(intervalMins) => updateFeedAutomation({ intervalMins })}
      />

      <View style={styles.section}>
        <SectionHeader title="Rules" />
        {loadedFeeds !== null && feeds.length === 0 ? (
          <Caption>You do not follow any feeds yet. Add one in the Feeds tab, then make a rule here.</Caption>
        ) : null}
        {auto.rules.length === 0 ? (
          feeds.length > 0 ? <Caption>No rules yet. A rule picks which new items to download.</Caption> : null
        ) : (
          <Card>
            {auto.rules.map((r) => (
              <ListRow
                key={r.id}
                title={r.name || 'Untitled rule'}
                subtitle={ruleSubtitle(r, feeds)}
                value={r.enabled ? undefined : 'Off'}
                onPress={() => setEditing({ rule: r, isNew: false })}
              />
            ))}
          </Card>
        )}
        {feeds.length > 0 ? (
          <Button label="Add rule" icon="plus" variant="secondary" onPress={() => setEditing({ rule: newFeedRule(), isNew: true })} />
        ) : (
          <Button label="Open Feeds" icon="feeds" variant="secondary" onPress={() => router.navigate('/(tabs)/feeds')} />
        )}
      </View>

      <View style={styles.section}>
        <SectionHeader title="Status" />
        <Card>
          <ListRow title="Last checked" value={status?.lastRunAt ? relativeTime(status.lastRunAt) : 'Not yet'} />
          <ListRow title="Added so far" value={String(status?.addedTotal ?? 0)} />
          <ListRow title="Waiting to be added" value={String(status?.pending ?? 0)} />
        </Card>
        {status?.lastError ? (
          <Text style={styles.error} accessibilityRole="alert">
            {status.lastError}
          </Text>
        ) : null}
        <Button label="Check now" icon="recheck" variant="secondary" loading={checking} onPress={checkNow} />
      </View>

      {editing ? (
        <RuleEditorSheet
          visible
          rule={editing.rule}
          isNew={editing.isNew}
          feeds={feeds}
          itemsByFeed={itemsByFeed}
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
    section: { gap: spacing.sm },
    error: { ...type.body, fontSize: 13, color: c.danger },
  });
