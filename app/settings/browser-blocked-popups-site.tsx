import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../../context/ThemeContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { ThemeColors, spacing, type } from '../../constants/theme';
import { haptic } from '../../constants/haptics';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { Button, EmptyBlock } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { relativeTime } from '../../utils/feeds';
import { addSiteHost, normalizeSiteHost, removeSiteHost } from '../../utils/browser/popups';
import { clearPopupSite, loadPopupLog, savePopupLog, type PopupLog } from '../../utils/browser/popupLog';
import { useBrowserPrefs } from '../../utils/prefs/browser';

const copy = browserSettingsCopy.blockedPopups;

/**
 * The blocked links of one site, newest first. Press and hold a link to copy it. Unblock removes the site from the block
 * list, Allow instead moves it to the allow list, and Clear log forgets its links (the block stays).
 */
export default function BrowserBlockedPopupsSite() {
  const router = useRouter();
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { showNotice } = useMaglevEngine();
  const params = useLocalSearchParams<{ host?: string }>();
  const host = normalizeSiteHost(typeof params.host === 'string' ? params.host : '');
  const [prefs, setPrefs] = useBrowserPrefs();
  const [log, setLog] = useState<PopupLog>(() => loadPopupLog());
  useFocusEffect(useCallback(() => setLog(loadPopupLog()), []));

  const site = log[host];
  const items = site?.items ?? [];
  const listed = prefs.popupBlockHosts.some((h) => normalizeSiteHost(h) === host);
  const now = Date.now();

  const copyLink = async (url: string) => {
    try {
      await Clipboard.setStringAsync(url);
      haptic('done');
      showNotice({ message: copy.copied }, 2500);
    } catch {
      haptic('fail');
    }
  };

  const unblock = () => {
    haptic('tap');
    setPrefs({ popupBlockHosts: removeSiteHost(prefs.popupBlockHosts, host) });
  };

  const allowInstead = () => {
    haptic('tap');
    setPrefs({
      popupBlockHosts: removeSiteHost(prefs.popupBlockHosts, host),
      popupAllowHosts: addSiteHost(prefs.popupAllowHosts, host),
    });
  };

  const clearLog = () => {
    haptic('tap');
    const next = clearPopupSite(log, host);
    savePopupLog(next);
    setLog(next);
    // Nothing left to show for this site once it is also not blocked.
    if (!listed) router.back();
  };

  return (
    <SettingsPage title={host || copy.siteTitle}>
      <Stack.Screen options={{ headerShown: false }} />

      {items.length === 0 ? (
        <EmptyBlock icon="shield" title={copy.siteEmpty.title} body={copy.siteEmpty.body} />
      ) : (
        <>
          <Text style={s.hint}>{copy.copyHint}</Text>
          <Card>
            {items.map((item, i) => (
              <Pressable
                key={`${item.at}-${i}`}
                style={s.item}
                accessibilityRole="button"
                accessibilityLabel={`${item.url}. Press and hold to copy.`}
                onLongPress={() => void copyLink(item.url)}
                delayLongPress={400}
              >
                <Text style={s.url} numberOfLines={2}>
                  {item.url}
                </Text>
                <Text style={s.meta}>
                  {copy.kinds[item.kind] ?? copy.kinds.window} · {relativeTime(item.at, now)}
                </Text>
              </Pressable>
            ))}
          </Card>
        </>
      )}

      <View style={s.actions}>
        {listed ? (
          <>
            <Button label={copy.unblock} variant="secondary" fullWidth onPress={unblock} />
            <Text style={s.caption}>{copy.unblockBody}</Text>
          </>
        ) : null}
        <Button label={copy.allowInstead} variant="secondary" fullWidth onPress={allowInstead} />
        <Text style={s.caption}>{copy.allowInsteadBody}</Text>
        {site ? (
          <>
            <Button label={copy.clearLog} variant="danger" fullWidth onPress={clearLog} />
            <Text style={s.caption}>{copy.clearLogBody}</Text>
          </>
        ) : null}
      </View>
    </SettingsPage>
  );
}

const makeStyles = (c: ThemeColors) =>
  StyleSheet.create({
    hint: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginBottom: spacing.sm },
    item: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, minHeight: 56, gap: 2 },
    url: { ...type.mono, fontSize: type.size.sm, color: c.text },
    meta: { ...type.body, fontSize: type.size.xs, color: c.textMuted },
    actions: { gap: spacing.sm, marginTop: spacing.lg },
    caption: { ...type.body, fontSize: type.size.sm, color: c.textMuted, marginBottom: spacing.xs },
  });
