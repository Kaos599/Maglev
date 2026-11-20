import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { FeedRule } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, radius, spacing, type } from '../../constants/theme';
import { Button, Chip, ListRow, Sheet, TextField, Toggle } from '../ui';
import type { Feed, FeedItem } from '../../utils/feeds';
import { isInvalidPattern, matchItem } from '../../utils/feedRules';

const PREVIEW_MAX = 8;

export interface RuleEditorSheetProps {
  visible: boolean;
  rule: FeedRule;
  isNew: boolean;
  feeds: Feed[];
  /** Items from the feeds as currently loaded, by feed id. Missing means not loaded yet. */
  itemsByFeed: Record<string, FeedItem[] | undefined>;
  onClose: () => void;
  onSave: (rule: FeedRule) => void;
  onDelete?: () => void;
}

export function RuleEditorSheet({ visible, rule, isNew, feeds, itemsByFeed, onClose, onSave, onDelete }: RuleEditorSheetProps) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [draft, setDraft] = useState<FeedRule>(rule);

  useEffect(() => {
    if (visible) setDraft(rule);
  }, [visible, rule]);

  const set = (patch: Partial<FeedRule>) => setDraft((d) => ({ ...d, ...patch }));
  const allFeeds = draft.feedIds.length === 0;
  const toggleFeed = (id: string) =>
    set({ feedIds: draft.feedIds.includes(id) ? draft.feedIds.filter((f) => f !== id) : [...draft.feedIds, id] });

  const watched = allFeeds ? feeds : feeds.filter((f) => draft.feedIds.includes(f.id));
  const loaded = watched.some((f) => itemsByFeed[f.id]);
  const matches = useMemo(() => {
    const out: FeedItem[] = [];
    for (const f of watched) {
      for (const item of itemsByFeed[f.id] ?? []) if (matchItem(draft, item.title).match) out.push(item);
    }
    return out;
  }, [watched, itemsByFeed, draft]);

  const badInclude = isInvalidPattern(draft.include);
  const badExclude = isInvalidPattern(draft.exclude);
  const noInclude = draft.include.trim() === '';
  const canSave = !noInclude && !badInclude && !badExclude;

  return (
    <Sheet visible={visible} onClose={onClose} title={isNew ? 'New rule' : 'Edit rule'}>
      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.field}>
          <TextField
            onSurface
            label="Name"
            value={draft.name}
            onChangeText={(name) => set({ name })}
            placeholder="For example, My show in 1080p"
            size="lg"
            accessibilityLabel="Rule name"
          />
        </View>

        <Text style={styles.label}>Feeds to watch</Text>
        <View style={styles.wrap}>
          <Chip label="All feeds" selected={allFeeds} onPress={() => set({ feedIds: [] })} />
          {feeds.map((f) => (
            <Chip key={f.id} label={f.name} selected={draft.feedIds.includes(f.id)} onPress={() => toggleFeed(f.id)} />
          ))}
        </View>

        <View style={styles.field}>
          <TextField
            onSurface
            label="Title must include"
            value={draft.include}
            onChangeText={(include) => set({ include })}
            placeholder="show name 1080p"
            mono
            size="lg"
            help="Every word must appear. Advanced: use /pattern/ for a pattern."
            error={badInclude ? 'That pattern is not valid, so it matches nothing.' : noInclude && draft.include !== '' ? 'Enter at least one word.' : undefined}
            accessibilityLabel="Words the title must include"
          />
        </View>

        <View style={styles.field}>
          <TextField
            onSurface
            label="Skip titles with"
            value={draft.exclude}
            onChangeText={(exclude) => set({ exclude })}
            placeholder="cam hdts"
            mono
            size="lg"
            help="Any one word is enough to skip."
            error={badExclude ? 'That pattern is not valid, so it skips nothing.' : undefined}
            accessibilityLabel="Words that skip a title"
          />
        </View>

        <View style={styles.toggles}>
          <ListRow
            title="Skip episodes I already have"
            subtitle="Get each episode once, even when other qualities appear."
            accessory={
              <Toggle
                value={draft.episodes === 'new_only'}
                onValueChange={(on) => set({ episodes: on ? 'new_only' : 'all' })}
                accessibilityLabel="Skip episodes I already have"
              />
            }
          />
          <ListRow
            title="Start paused"
            subtitle="Added torrents wait until you resume them."
            accessory={<Toggle value={draft.startPaused} onValueChange={(startPaused) => set({ startPaused })} accessibilityLabel="Start paused" />}
          />
          <ListRow
            title="Rule is on"
            accessory={<Toggle value={draft.enabled} onValueChange={(enabled) => set({ enabled })} accessibilityLabel="Rule is on" />}
          />
        </View>

        <Text style={styles.label}>Preview</Text>
        {watched.length === 0 ? (
          <Text style={styles.hint}>Add a feed in the Feeds tab to see what this rule would catch.</Text>
        ) : !loaded ? (
          <Text style={styles.hint}>Loading feeds</Text>
        ) : noInclude ? (
          <Text style={styles.hint}>Add at least one word to see matches.</Text>
        ) : matches.length === 0 ? (
          <Text style={styles.hint}>Nothing in your feeds right now matches.</Text>
        ) : (
          <View style={styles.preview} accessibilityLiveRegion="polite">
            <Text style={styles.previewCount}>{`${matches.length} ${matches.length === 1 ? 'item matches' : 'items match'} right now`}</Text>
            {matches.slice(0, PREVIEW_MAX).map((m) => (
              <Text key={`${m.feedId}:${m.id}`} style={styles.previewItem} numberOfLines={2}>
                {m.title}
              </Text>
            ))}
            {matches.length > PREVIEW_MAX ? <Text style={styles.hint}>{`and ${matches.length - PREVIEW_MAX} more`}</Text> : null}
          </View>
        )}
        <Text style={styles.hint}>New items are added when feeds are checked. Items already in the feed now are not downloaded.</Text>

        <View style={styles.actions}>
          {onDelete && !isNew ? <Button label="Delete" variant="danger" onPress={onDelete} /> : null}
          <View style={styles.spacer} />
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button
            label="Save"
            disabled={!canSave}
            onPress={() => onSave({ ...draft, name: draft.name.trim() || draft.include.trim().slice(0, 40) })}
          />
        </View>
      </ScrollView>
    </Sheet>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    label: { ...type.body, fontSize: type.size.md, color: c.textMuted, marginTop: spacing.md, marginBottom: spacing.sm },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    field: { marginTop: spacing.md },
    hint: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginTop: spacing.xs },
    toggles: { marginTop: spacing.md },
    preview: { gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg },
    previewCount: { ...type.bodyStrong, fontSize: type.size.md, color: c.accentText },
    previewItem: { ...type.mono, fontSize: type.size.sm, color: c.text },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl },
    spacer: { flex: 1 },
  });
