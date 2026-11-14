import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import {
  getBlocklistInfo,
  resetBlocklist,
  updateBlocklist,
  type BlocklistErrorCode,
  type BlocklistInfo,
} from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { browserTabs, empty, historyCopy, notices, textSizeCopy } from '../../constants/copy';
import { Button, EmptyBlock, IconButton, ListRow, RadioCard, SectionHeader, Toggle } from '../../components/ui';
import { Card, Caption, ChipGroup, InputSheet, SettingsPage } from '../../components/settings/SettingsParts';
import { DEFAULT_BLOCKLIST_URL, updateBrowserPrefs, useBrowserPrefs, type PopupPolicy } from '../../utils/prefs/browser';
import { ClearHistorySheet, type ClearMode } from '../../components/browser/ClearHistorySheet';
import { SEARCH_URLS, hostOf, isHttpsUrl, type SearchEngine } from '../../utils/browserUrl';

const ENGINES: { value: SearchEngine; title: string }[] = [
  { value: 'duckduckgo', title: 'DuckDuckGo' },
  { value: 'google', title: 'Google' },
  { value: 'bing', title: 'Bing' },
  { value: 'brave', title: 'Brave' },
];

/** Exact sizes in percent. normalizeTextZoom keeps every one of them as it is. */
const TEXT_SIZES = [80, 90, 100, 115, 130, 150, 175, 200].map((v) => ({ value: v, label: textSizeCopy.value(v) }));

const POPUP_CHOICES: { value: PopupPolicy; title: string }[] = [
  { value: 'ask', title: browserTabs.settings.ask },
  { value: 'block', title: browserTabs.settings.block },
  { value: 'allow', title: browserTabs.settings.allow },
];

const listErrorText = (code: BlocklistErrorCode): string =>
  (notices.browser.listError as Record<string, string>)[code] ?? notices.browser.listError.OTHER;

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return new Date(ms).toDateString();
  }
}

export default function BrowserSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const router = useRouter();
  const [prefs, setPrefs] = useBrowserPrefs();
  const [info, setInfo] = useState<BlocklistInfo | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [clearMode, setClearMode] = useState<ClearMode | null>(null);
  // The sheet keeps its last mode while it slides out.
  const lastMode = useRef<ClearMode>('browsing-data');
  if (clearMode) lastMode.current = clearMode;

  const refresh = useCallback(async () => {
    const res = await getBlocklistInfo();
    if (res.ok) {
      setInfo(res);
      setUnavailable(false);
    } else {
      setUnavailable(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = async () => {
    haptic('tap');
    setUpdating(true);
    const res = await updateBlocklist(prefs.blocklistUrls);
    setUpdating(false);
    if (res.ok) {
      setInfo(res);
      haptic('done');
      showNotice({ message: notices.browser.listUpdated(res.domains.toLocaleString()) }, 3000);
    } else {
      haptic('fail');
      showNotice({ message: listErrorText(res.code) });
    }
  };

  const reset = async () => {
    haptic('tap');
    const res = await resetBlocklist();
    setPrefs({ blocklistUrls: [DEFAULT_BLOCKLIST_URL] });
    if (res.ok) {
      setInfo(res);
      showNotice({ message: notices.browser.listReset }, 3000);
    } else {
      haptic('fail');
      showNotice({ message: listErrorText(res.code) });
    }
  };

  const status = info ? (info.updatedAt != null ? `Updated ${formatDate(info.updatedAt)}` : 'Built-in list') : '—';
  const source = prefs.blocklistUrls.length === 1 ? hostOf(prefs.blocklistUrls[0]) : `${prefs.blocklistUrls.length} lists`;

  return (
    <SettingsPage title="Browser">
      <Stack.Screen options={{ headerShown: false }} />

      <Card>
        <ListRow
          title="Ad blocking"
          subtitle="Blocks ads and trackers on the pages you open."
          accessory={<Toggle value={prefs.adBlock} onValueChange={(adBlock) => setPrefs({ adBlock })} accessibilityLabel="Ad blocking" />}
        />
      </Card>

      <View style={s.section}>
        <SectionHeader title="Block list" />
        <Card>
          <ListRow title="Domains" value={info ? info.domains.toLocaleString() : '—'} />
          <ListRow title="Status" value={status} />
          <ListRow title="Source" value={source} />
          <View style={s.actions}>
            <Button label="Update now" icon="download" loading={updating} disabled={unavailable || updating} onPress={() => void update()} />
          </View>
        </Card>
        {unavailable ? <Caption>The block list isn't available in this build.</Caption> : null}
      </View>

      <View style={s.section}>
        <SectionHeader title="List addresses" />
        <Card>
          {prefs.blocklistUrls.map((u) => (
            <View key={u} style={s.urlRow}>
              <Text style={s.url} numberOfLines={2}>
                {u}
              </Text>
              <IconButton
                icon="close"
                accessibilityLabel={`Remove ${hostOf(u)}`}
                disabled={prefs.blocklistUrls.length <= 1}
                onPress={() => {
                  haptic('tap');
                  setPrefs({ blocklistUrls: prefs.blocklistUrls.filter((x) => x !== u) });
                }}
              />
            </View>
          ))}
          <ListRow icon="plus" title="Add list address" onPress={() => setAddOpen(true)} />
          <ListRow icon="retry" title="Reset to built-in list" onPress={() => void reset()} />
        </Card>
        <Caption>Lists load over https and merge into one. Press Update now to fetch them.</Caption>
      </View>

      <View style={s.section}>
        <SectionHeader title="Sites allowed to show ads" />
        {prefs.allowAdsHosts.length === 0 ? (
          <EmptyBlock icon="shield" title={empty.browser.noAllowedSites.title} body={empty.browser.noAllowedSites.body} />
        ) : (
          <Card>
            {prefs.allowAdsHosts.map((h) => (
              <View key={h} style={s.urlRow}>
                <Text style={s.url} numberOfLines={1}>
                  {h}
                </Text>
                <IconButton
                  icon="close"
                  accessibilityLabel={`Block ads on ${h}`}
                  onPress={() => {
                    haptic('tap');
                    setPrefs({ allowAdsHosts: prefs.allowAdsHosts.filter((x) => x !== h) });
                  }}
                />
              </View>
            ))}
          </Card>
        )}
      </View>

      <View style={s.section}>
        <SectionHeader title={browserTabs.settings.section} />
        <Card>
          {POPUP_CHOICES.map((c) => (
            <ListRow
              key={c.value}
              title={c.title}
              selected={prefs.popupPolicy === c.value}
              accessibilityLabel={c.title}
              onPress={() => {
                haptic('select');
                setPrefs({ popupPolicy: c.value });
              }}
            />
          ))}
        </Card>
      </View>

      {prefs.popupAllowHosts.length > 0 ? (
        <View style={s.section}>
          <SectionHeader title={browserTabs.settings.allowedSites} />
          <Card>
            {prefs.popupAllowHosts.map((h) => (
              <View key={h} style={s.urlRow}>
                <Text style={s.url} numberOfLines={1}>
                  {h}
                </Text>
                <IconButton
                  icon="close"
                  accessibilityLabel={`${browserTabs.settings.remove} ${h}`}
                  onPress={() => {
                    haptic('tap');
                    setPrefs({ popupAllowHosts: prefs.popupAllowHosts.filter((x) => x !== h) });
                  }}
                />
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      <View style={s.section}>
        <SectionHeader title="Search engine" />
        {ENGINES.map((e) => (
          <RadioCard
            key={e.value}
            icon="search"
            title={e.title}
            description={hostOf(SEARCH_URLS[e.value])}
            selected={prefs.searchEngine === e.value}
            onPress={() => setPrefs({ searchEngine: e.value })}
          />
        ))}
        <Caption>Used when you type words instead of an address.</Caption>
      </View>

      <Card>
        <ListRow
          title="Desktop site"
          subtitle="Ask sites for their desktop version by default."
          accessory={<Toggle value={prefs.desktopMode} onValueChange={(desktopMode) => setPrefs({ desktopMode })} accessibilityLabel="Desktop site" />}
        />
      </Card>

      <ChipGroup label={textSizeCopy.settingsLabel} options={TEXT_SIZES} value={prefs.browserTextZoom} onChange={(browserTextZoom) => setPrefs({ browserTextZoom })} />

      <View style={s.section}>
        <SectionHeader title={historyCopy.settings.section} />
        <Card>
          <ListRow
            title={historyCopy.settings.save}
            subtitle={historyCopy.settings.saveSubtitle}
            accessory={<Toggle value={prefs.saveHistory} onValueChange={(saveHistory) => setPrefs({ saveHistory })} accessibilityLabel={historyCopy.settings.save} />}
          />
          <ListRow
            title={historyCopy.settings.suggest}
            subtitle={historyCopy.settings.suggestSubtitle}
            accessory={<Toggle value={prefs.suggestFromHistory} onValueChange={(suggestFromHistory) => setPrefs({ suggestFromHistory })} accessibilityLabel={historyCopy.settings.suggest} />}
          />
          <ListRow
            title={historyCopy.settings.clearOnClose}
            subtitle={historyCopy.settings.clearOnCloseSubtitle}
            accessory={<Toggle value={prefs.clearHistoryOnClose} onValueChange={(clearHistoryOnClose) => setPrefs({ clearHistoryOnClose })} accessibilityLabel={historyCopy.settings.clearOnClose} />}
          />
          <ListRow icon="clock" title={historyCopy.settings.open} onPress={() => router.push('/browser-history')} />
          <ListRow
            icon="trash"
            title={historyCopy.settings.clear}
            destructive
            onPress={() => {
              haptic('warn');
              setClearMode('range');
            }}
          />
        </Card>
      </View>

      <Card>
        <ListRow
          icon="trash"
          title="Clear browsing data"
          destructive
          onPress={() => {
            haptic('warn');
            setClearMode('browsing-data');
          }}
        />
      </Card>

      <InputSheet
        visible={addOpen}
        title="Add list address"
        subtitle="A link to a hosts file or a domain list."
        initial="https://"
        placeholder="https://"
        submitLabel="Add"
        validate={(raw) => (isHttpsUrl(raw) ? null : 'Use an address that starts with https.')}
        onClose={() => setAddOpen(false)}
        onSubmit={(raw) => {
          setAddOpen(false);
          if (!prefs.blocklistUrls.includes(raw)) setPrefs({ blocklistUrls: [...prefs.blocklistUrls, raw] });
          showNotice({ message: notices.browser.listAddressAdded }, 2500);
        }}
      />

      <ClearHistorySheet visible={clearMode != null} mode={lastMode.current} onClose={() => setClearMode(null)} />
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    section: { gap: spacing.sm },
    actions: { padding: spacing.lg, flexDirection: 'row' },
    urlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.xs, minHeight: 56 },
    url: { ...type.mono, flex: 1, fontSize: type.size.sm, color: c.text },
  });
