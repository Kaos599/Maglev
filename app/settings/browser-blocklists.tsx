import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { getBlocklistInfo, resetBlocklist, type BlocklistErrorCode, type BlocklistInfo } from 'maglev-engine';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { listsCopy, notices } from '../../constants/copy';
import { Button, IconButton, ListRow } from '../../components/ui';
import { Card, InputSheet, Section, SettingsPage } from '../../components/settings/SettingsParts';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { getDefaultBlocklistUrls } from '../../utils/prefs/lists';
import { updateAdList } from '../../utils/lists';
import { hostOf, isHttpsUrl } from '../../utils/browserUrl';

const listErrorText = (code: BlocklistErrorCode): string =>
  (notices.browser.listError as Record<string, string>)[code] ?? notices.browser.listError.OTHER;

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return new Date(ms).toDateString();
  }
}

/** The ad and tracker block list: what it holds, when it was updated, and where it comes from. */
export default function BrowserBlocklistSettings() {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const [prefs, setPrefs] = useBrowserPrefs();
  const [info, setInfo] = useState<BlocklistInfo | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

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
    // Update now always downloads in full (conditional: false), unlike the daily check (contract 31.2).
    const res = await updateAdList({ conditional: false });
    setUpdating(false);
    if (res.ok) {
      setInfo(res);
      haptic('done');
      showNotice({ message: res.changed === false ? listsCopy.browser.upToDate : notices.browser.listUpdated(res.domains.toLocaleString()) }, 3000);
    } else {
      haptic('fail');
      showNotice({ message: listErrorText(res.code) });
    }
  };

  const reset = async () => {
    haptic('tap');
    const res = await resetBlocklist();
    // The default address now in force: the source list's, else the built-in one (contract 31.1).
    setPrefs({ blocklistUrls: getDefaultBlocklistUrls() });
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
    <SettingsPage title={browserSettingsCopy.sections.blocklists}>
      <Stack.Screen options={{ headerShown: false }} />

      <Section title={browserSettingsCopy.headers.blockList} caption={unavailable ? browserSettingsCopy.blocklists.unavailable : undefined}>
        <Card>
          <ListRow title="Domains" value={info ? info.domains.toLocaleString() : '—'} />
          <ListRow title="Status" value={status} />
          <ListRow title="Source" value={source} />
          <View style={s.actions}>
            <Button label="Update now" icon="download" loading={updating} disabled={unavailable || updating} onPress={() => void update()} />
          </View>
        </Card>
      </Section>

      <Section title={browserSettingsCopy.headers.listAddresses} caption={browserSettingsCopy.blocklists.addressesCaption}>
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
      </Section>

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
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    actions: { padding: spacing.lg, flexDirection: 'row' },
    urlRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.xs, minHeight: 56 },
    url: { ...type.mono, flex: 1, fontSize: type.size.sm, color: c.text },
  });
