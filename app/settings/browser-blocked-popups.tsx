import React, { useCallback, useMemo, useState } from 'react';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { browserSettingsCopy } from '../../constants/browserSettingsCopy';
import { SettingsPage } from '../../components/settings/SettingsParts';
import { HostList } from '../../components/browser/HostList';
import { relativeTime } from '../../utils/feeds';
import { blockedSiteRows, loadPopupLog, type BlockedSiteRow, type PopupLog } from '../../utils/browser/popupLog';
import { useBrowserPrefs } from '../../utils/prefs/browser';

const copy = browserSettingsCopy.blockedPopups;

/** The second line of a site row: "3 blocked · last 2 h ago", "Always blocked", or both. */
function siteSubtitle(row: BlockedSiteRow, now: number): string {
  const parts: string[] = [];
  if (row.last !== null && row.blocked > 0) parts.push(copy.countLine(row.blocked, relativeTime(row.last, now)));
  if (row.listed) parts.push(copy.alwaysBlocked);
  return parts.join(' · ');
}

/** Settings › Browser › Blocking › Blocked pop-ups: every site in the block list or the log, newest first. */
export default function BrowserBlockedPopups() {
  const router = useRouter();
  const [prefs] = useBrowserPrefs();
  const [snap, setSnap] = useState<{ log: PopupLog; now: number }>(() => ({ log: loadPopupLog(), now: Date.now() }));
  // The log changes on the site screen, so read it again whenever this screen comes back.
  useFocusEffect(useCallback(() => setSnap({ log: loadPopupLog(), now: Date.now() }), []));

  const rows = useMemo(() => blockedSiteRows(prefs.popupBlockHosts, snap.log), [prefs.popupBlockHosts, snap.log]);
  const byHost = useMemo(() => new Map(rows.map((r) => [r.host, r])), [rows]);

  return (
    <SettingsPage title={copy.title}>
      <Stack.Screen options={{ headerShown: false }} />
      <HostList
        hosts={rows.map((r) => r.host)}
        empty={{ icon: 'shield', title: copy.empty.title, body: copy.empty.body }}
        subtitle={(h) => {
          const r = byHost.get(h);
          return r ? siteSubtitle(r, snap.now) : undefined;
        }}
        onOpen={(h) => router.push(`/settings/browser-blocked-popups-site?host=${encodeURIComponent(h)}` as never)}
        matches={(host, q) => host.includes(q) || (snap.log[host]?.items.some((i) => i.url.toLowerCase().includes(q)) ?? false)}
      />
    </SettingsPage>
  );
}
