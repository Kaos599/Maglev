import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTheme } from '../../context/ThemeContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { Chip, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';
import { ProviderRow } from '../../components/search-providers/ProviderRow';
import { ProviderSheet, TestOutcome } from '../../components/search-providers/ProviderSheet';
import { TorznabDraft, TorznabSheet } from '../../components/search-providers/TorznabSheet';
import { CATEGORY_LABEL, ProviderInfo, TORZNAB_PREFIX, allProviderInfo, coverage, formatSeconds } from '../../components/search/meta';
import { loadExtraProviders } from '../../components/search/extra';
import { clearCookies } from 'maglev-engine';
import { SearchPrefs, clearSiteChecks, deleteTorznabApiKey, setTorznabApiKey, useSearchPrefs } from '../../utils/prefs/search';
import { listsCopy } from '../../constants/copy';
import { useListsVersion } from '../../utils/lists/hooks';
import { CloudflareSolverSheet } from '../../components/search/CloudflareSolverSheet';
import { testProvider } from '../../utils/search/aggregate';
import { CATEGORY_ORDER, type Category } from '../../utils/search/types';
import { providerCovers } from '../../utils/search/providerFilter';

const WAITS = [
  { value: 5, label: '5 s' },
  { value: 8, label: '8 s' },
  { value: 15, label: '15 s' },
] as const;
const LIMITS = [
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
] as const;

/** Torznab entries default to every category except adult; the user narrows it per source. */
const TORZNAB_DEFAULT_CATEGORIES: Category[] = ['movies', 'tv', 'anime', 'music', 'apps', 'games', 'books', 'other'];

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

export default function SearchProvidersSettings() {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [prefs, update] = useSearchPrefs();
  const [openId, setOpenId] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>('all');
  const [torznabOpen, setTorznabOpen] = useState(false);
  const [tests, setTests] = useState<Record<string, TestOutcome>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [solving, setSolving] = useState<string | null>(null);

  // A new source list changes mirrors, warnings and which sources are turned off.
  const listsVersion = useListsVersion();
  const all = useMemo(() => allProviderInfo(prefs), [prefs, listsVersion]);
  const byId = useMemo(() => new Map(all.map((p) => [p.id, p])), [all]);
  // Sources that last sat behind a Cloudflare check get their own section on top and are not listed twice.
  const checkList = useMemo(
    () => prefs.needsCheck.filter((id) => prefs.enabled.includes(id) && !byId.get(id)?.turnedOff).map((id) => byId.get(id)).filter((p): p is ProviderInfo => !!p?.cloudflare),
    [prefs.needsCheck, prefs.enabled, byId],
  );
  const checkIds = useMemo(() => new Set(checkList.map((p) => p.id)), [checkList]);
  const onList = useMemo(() => prefs.enabled.filter((id) => !checkIds.has(id)).map((id) => byId.get(id)).filter((p): p is ProviderInfo => !!p && !p.turnedOff), [prefs.enabled, byId, checkIds]);
  const offList = useMemo(
    () => all.filter((p) => (!prefs.enabled.includes(p.id) || !!p.turnedOff) && (prefs.adult || !p.nsfw)),
    [all, prefs.enabled, prefs.adult],
  );
  // The category filter narrows On and Off; sources needing a check always show.
  const shownOn = useMemo(() => onList.filter((p) => providerCovers(p, category)), [onList, category]);
  const shownOff = useMemo(() => offList.filter((p) => providerCovers(p, category)), [offList, category]);

  const setEnabled = useCallback(
    (id: string, on: boolean) =>
      update((p) => ({ enabled: on ? (p.enabled.includes(id) ? p.enabled : [...p.enabled, id]) : p.enabled.filter((x) => x !== id) })),
    [update],
  );

  const move = useCallback(
    (id: string, delta: -1 | 1) =>
      update((p) => {
        const i = p.enabled.indexOf(id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= p.enabled.length) return {};
        const next = [...p.enabled];
        [next[i], next[j]] = [next[j], next[i]];
        return { enabled: next };
      }),
    [update],
  );

  const runTest = useCallback(
    async (id: string) => {
      setTesting(id);
      try {
        const extraProviders = await loadExtraProviders(prefs.torznab);
        const r = await testProvider(id, { extraProviders, mirrorOverride: prefs.mirrorOverride, waitSeconds: prefs.waitSeconds });
        setTests((t) => ({ ...t, [id]: { ok: r.ok, ms: r.ms, message: r.message } }));
      } catch {
        setTests((t) => ({ ...t, [id]: { ok: false, ms: 0, message: "Didn't answer" } }));
      } finally {
        setTesting(null);
      }
    },
    [prefs],
  );

  const addTorznab = useCallback(
    async (draft: TorznabDraft) => {
      const id = uuid();
      await setTorznabApiKey(id, draft.apiKey);
      update((p) => ({
        torznab: [...p.torznab, { id, name: draft.name, url: draft.url, categories: TORZNAB_DEFAULT_CATEGORIES }],
        enabled: [...p.enabled, `${TORZNAB_PREFIX}${id}`],
      }));
      setTorznabOpen(false);
    },
    [update],
  );

  const removeTorznab = useCallback(
    (providerId: string) => {
      const bare = providerId.slice(TORZNAB_PREFIX.length);
      void deleteTorznabApiKey(bare);
      update((p) => {
        const useFor = { ...p.useFor };
        delete useFor[providerId];
        return {
          torznab: p.torznab.filter((t) => t.id !== bare),
          enabled: p.enabled.filter((x) => x !== providerId),
          useFor,
        };
      });
      setOpenId(null);
    },
    [update],
  );

  const setAddress = useCallback(
    (p: ProviderInfo, value: string) => {
      if (p.custom) {
        if (!value) return;
        const bare = p.id.slice(TORZNAB_PREFIX.length);
        update((s) => ({ torznab: s.torznab.map((t) => (t.id === bare ? { ...t, url: value } : t)) }));
        return;
      }
      update((s) => {
        const mirrorOverride = { ...s.mirrorOverride };
        if (value) mirrorOverride[p.id] = value;
        else delete mirrorOverride[p.id];
        return { mirrorOverride };
      });
    },
    [update],
  );

  const setUseFor = useCallback(
    (id: string, cats: Category[] | null) =>
      update((s: SearchPrefs) => {
        const useFor = { ...s.useFor };
        if (cats) useFor[id] = cats;
        else delete useFor[id];
        return { useFor };
      }),
    [update],
  );

  const note = (p: ProviderInfo): { text: string; tone: 'normal' | 'warning' | 'danger' } => {
    if (p.turnedOff) return { text: p.turnedOff.note ? listsCopy.providers.turnedOffWithNote(p.turnedOff.note) : listsCopy.providers.turnedOff, tone: 'warning' };
    const t = tests[p.id];
    if (t && !t.ok) return { text: `${coverage(p)} · not responding`, tone: 'danger' };
    if (p.unsafeReason) return { text: p.unsafeReason, tone: 'warning' };
    return { text: t?.ok ? `${coverage(p)} · ${formatSeconds(t.ms)}` : coverage(p), tone: 'normal' };
  };

  const solvingProvider = solving ? byId.get(solving) : undefined;
  const open = openId ? byId.get(openId) ?? null : null;
  const openPos = open ? prefs.enabled.indexOf(open.id) : -1;

  return (
    <SettingsPage title="Search sources">
      <Stack.Screen options={{ headerShown: false }} />
      <Caption>Maglev asks every source you turn on at the same time. Open a source to set which one wins when two return the same torrent.</Caption>

      {checkList.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Needs a quick check" />
          <Card>
            {checkList.map((p, i) => (
              <ProviderRow
                key={p.id}
                provider={p}
                enabled
                note="Tap ? to open the site once"
                noteTone="accent"
                first={i === 0}
                onOpen={() => setOpenId(p.id)}
                onToggle={(on) => setEnabled(p.id, on)}
                onCheck={() => setSolving(p.id)}
              />
            ))}
          </Card>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title="What sources to show" />
        <Card>
          <ListRow
            title="Show adult sources"
            subtitle={prefs.adult ? 'Adult sources are listed under Off' : 'Hidden until you turn this on'}
            accessory={<Toggle value={prefs.adult} onValueChange={(adult) => update({ adult })} accessibilityLabel="Show adult sources" />}
          />
          <ListRow
            title="Warn about risky sources"
            subtitle="Mark results from sources known for fake or harmful uploads."
            accessory={<Toggle value={prefs.warnUnsafe} onValueChange={(warnUnsafe) => update({ warnUnsafe })} accessibilityLabel="Warn about risky sources" />}
          />
          {prefs.clearances.length > 0 ? (
            <ListRow
              icon="trash"
              title="Clear site checks"
              subtitle={`Forget the checks you passed on ${prefs.clearances.length} ${prefs.clearances.length === 1 ? 'site' : 'sites'}. You'll be asked again.`}
              onPress={() => {
                const hosts = clearSiteChecks();
                void clearCookies(hosts.map((h) => `https://${h.host}/`));
              }}
            />
          ) : null}
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="How search behaves" />
        <Card>
          <ChipGroup
            label="Wait for slow sources"
            options={WAITS}
            value={prefs.waitSeconds}
            onChange={(waitSeconds) => update({ waitSeconds })}
          />
          <ChipGroup label="Results per source" options={LIMITS} value={prefs.limit} onChange={(limit) => update({ limit })} />
          <ListRow
            title="Hide dead torrents"
            subtitle="Results no one is sharing"
            accessory={<Toggle value={prefs.hideDead} onValueChange={(hideDead) => update({ hideDead })} accessibilityLabel="Hide dead torrents" />}
          />
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title="Show sources for" />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow} accessibilityRole="radiogroup" accessibilityLabel="Show sources for">
          {CATEGORY_ORDER.filter((c) => c !== 'adult' || prefs.adult).map((c) => (
            <Chip key={c} label={CATEGORY_LABEL[c]} role="radio" selected={category === c} onPress={() => setCategory(c)} />
          ))}
        </ScrollView>
      </View>

      <View style={styles.section}>
        <SectionHeader title={`On · ${onList.length + checkList.length}`} />
        <Card>
          {onList.length === 0 ? <Text style={styles.empty}>Nothing is on. Turn on a source below.</Text> : shownOn.length === 0 ? <Text style={styles.empty}>No source that's on covers {CATEGORY_LABEL[category]}.</Text> : null}
          {shownOn.map((p, i) => {
            const n = note(p);
            return (
              <ProviderRow
                key={p.id}
                provider={p}
                enabled
                position={prefs.enabled.indexOf(p.id) + 1}
                note={n.text}
                noteTone={n.tone}
                first={i === 0}
                onOpen={() => setOpenId(p.id)}
                onToggle={(on) => setEnabled(p.id, on)}
              />
            );
          })}
        </Card>
      </View>

      {shownOff.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Off" />
          <Card>
            {shownOff.map((p, i) => {
              const n = note(p);
              return (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  enabled={false}
                  note={n.text}
                  noteTone={n.tone}
                  first={i === 0}
                  locked={!!p.turnedOff}
                  onOpen={() => setOpenId(p.id)}
                  onToggle={(on) => setEnabled(p.id, on)}
                />
              );
            })}
          </Card>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeader title="Your own indexer" />
        <Card>
          <ListRow
            icon="plus"
            title="Connect Jackett or Prowlarr"
            subtitle="Search any tracker your server supports, including private ones"
            onPress={() => setTorznabOpen(true)}
          />
        </Card>
      </View>

      <Caption>Maglev doesn't host or index anything. Sources are third-party websites; you're responsible for what you download.</Caption>

      <ProviderSheet
        provider={open}
        prefs={prefs}
        enabled={!!open && prefs.enabled.includes(open.id) && !open.turnedOff}
        position={openPos}
        onCount={prefs.enabled.length}
        test={open ? tests[open.id] : undefined}
        testing={!!open && testing === open.id}
        onClose={() => setOpenId(null)}
        onTest={() => open && runTest(open.id)}
        onToggle={(on) => open && setEnabled(open.id, on)}
        onMove={(d) => open && move(open.id, d)}
        onUseFor={(cats) => open && setUseFor(open.id, cats)}
        onAddress={(v) => open && setAddress(open, v)}
        onRemove={open?.custom ? () => removeTorznab(open.id) : undefined}
      />
      {solvingProvider?.cloudflare ? (
        <CloudflareSolverSheet
          visible
          providerName={solvingProvider.name}
          solverUrl={solvingProvider.cloudflare.solverUrl}
          onClose={() => setSolving(null)}
          onSolved={() => {
            const id = solving;
            setSolving(null);
            if (id) update((p) => ({ needsCheck: p.needsCheck.filter((x) => x !== id) }));
          }}
        />
      ) : null}
      <TorznabSheet visible={torznabOpen} onClose={() => setTorznabOpen(false)} onAdd={addTorznab} />
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    filterRow: { gap: spacing.sm, paddingVertical: spacing.xs },
    section: { gap: spacing.sm },
    empty: { ...type.body, fontSize: 13, color: c.textMuted, padding: spacing.lg },
  });
