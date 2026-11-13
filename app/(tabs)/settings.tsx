import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Linking, NativeScrollEvent, NativeSyntheticEvent, ScrollView, ScrollViewInstance, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine as useEngine } from '../../context/EngineContext';
import { Banner, ListRow, Screen, SectionHeader } from '../../components/ui';
import { BottomFade, MoreBelowPill } from '../../components/settings/MoreBelow';
import { getMoreHintSeen, markMoreHintSeen, nearEnd } from '../../utils/prefs/moreHint';
import { PixelIconName } from '../../components/PixelIcon';
import { useSearchPrefs } from '../../utils/prefs/search';
import { scheduleSummary, useSchedule } from '../../utils/prefs/schedule';
import { feedAutomationSummary, useFeedAutomation } from '../../utils/prefs/feedAutomation';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { useBrowserPrefs } from '../../utils/prefs/browser';
import { Card, formatLimit, friendlyPath } from '../../components/settings/SettingsParts';
import { spacing } from '../../constants/theme';
import { banners } from '../../constants/copy';

const ACCENT_LABEL = { lime: 'Lime', cyan: 'Cyan', pink: 'Pink', orange: 'Orange' } as const;
const MODE_LABEL = { oled: 'OLED', dim: 'Dim', light: 'Light', system: 'System' } as const;

interface RowSpec {
  icon: PixelIconName;
  title: string;
  value: string;
  route: string;
}

/** One settings row. Memoised so a telemetry tick or an unrelated change never re-renders the list. */
const SettingsRow = React.memo(function SettingsRow({ icon, title, value, route }: RowSpec) {
  const onPress = useCallback(() => router.push(`/settings/${route}` as never), [route]);
  return <ListRow icon={icon} title={title} value={value} onPress={onPress} />;
});

/** Storage row: the only row that reads the engine, kept apart so the rest of the list stays still. */
function StorageRow() {
  const { settings } = useSettings();
  const { storageStatus, defaultStoragePath } = useEngine();
  const folder = settings.downloadFolder?.displayName ?? friendlyPath(storageStatus?.path || defaultStoragePath);
  return <SettingsRow icon="folder" title="Storage" value={folder} route="storage" />;
}

/** Warning banners. Reads engine state itself, so engine ticks re-render only this block. */
function NeedsAttention() {
  const { permissionStatus, storageStatus, refreshPermissions } = useEngine();
  const attention = useMemo(() => {
    const items: React.ReactElement[] = [];
    if (permissionStatus?.notifications === 'denied') {
      items.push(
        <Banner
          key="notif"
          tone="warning"
          title={banners.settings.notificationsOff.title}
          body={banners.settings.notificationsOff.body}
          actionLabel="Open settings"
          onAction={() => void Linking.openSettings()}
        />,
      );
    }
    if (permissionStatus && !permissionStatus.batteryUnrestricted) {
      items.push(
        <Banner
          key="battery"
          tone="warning"
          title={banners.settings.batteryRestricted.title}
          actionLabel="Allow background"
          onAction={() => void maglevEngine.openBatterySettings().then(refreshPermissions)}
        />,
      );
    }
    if (permissionStatus?.legacyStorage === 'denied') {
      items.push(
        <Banner
          key="legacy"
          tone="warning"
          title={banners.settings.legacyStorageDenied.title}
          body={banners.settings.legacyStorageDenied.body}
          actionLabel="Grant access"
          onAction={() => void maglevEngine.requestLegacyStorage().then(refreshPermissions)}
        />,
      );
    }
    if (storageStatus?.safLost) {
      items.push(
        <Banner
          key="saf"
          tone="danger"
          title={banners.storage.folderAccessLost.title}
          body={banners.storage.folderAccessLost.body}
          actionLabel="Pick again"
          onAction={() => router.push('/settings/storage')}
        />,
      );
    } else if (storageStatus?.fallback) {
      items.push(
        <Banner
          key="fallback"
          tone="warning"
          title={banners.storage.appStorageFallback.title}
          body={banners.storage.appStorageFallback.body}
          actionLabel="Fix"
          onAction={() => router.push('/settings/storage')}
        />,
      );
    }
    return items;
  }, [permissionStatus, storageStatus, refreshPermissions]);

  if (attention.length === 0) return null;
  return (
    <View style={styles.section}>
      <SectionHeader title="Needs attention" />
      {attention}
    </View>
  );
}

const APP_VERSION = Constants.expoConfig?.version ?? '';

export default function SettingsIndex() {
  const { settings } = useSettings();
  const { permissionStatus } = useEngine();
  const [searchPrefs] = useSearchPrefs();
  const [schedule] = useSchedule();
  const [feedAuto] = useFeedAutomation();
  const assistant = useAssistantPrefs();
  const [browserPrefs] = useBrowserPrefs();
  const { bandwidth: b, network: n, power: p, appearance: a } = settings;

  // Strings only, so the memoised rows below see equal props until a value really changes.
  const limits =
    b.downloadLimitBytesPerSec <= 0 && b.uploadLimitBytesPerSec <= 0
      ? 'Unlimited'
      : `↓ ${formatLimit(b.downloadLimitBytesPerSec)} · ↑ ${formatLimit(b.uploadLimitBytesPerSec)}`;
  const power =
    p.batteryCutoffThreshold > 0
      ? `Pause below ${p.batteryCutoffThreshold}%`
      : p.downloadOnlyWhileCharging
        ? 'Charging only'
        : 'Off';
  const queue = `${b.maxActiveDownloads} at a time`;
  const interfaceValue = `${MODE_LABEL[a.mode]} · ${ACCENT_LABEL[a.accent]}`;
  const network = n.wifiOnly ? 'Wi-Fi only' : 'Any network';
  const scheduling = scheduleSummary(schedule);
  const providers = `${searchPrefs.enabled.length} on`;
  const auto = feedAutomationSummary(feedAuto);

  const alerts = permissionStatus?.notifications === 'granted' ? 'On' : 'Off';

  const appRows: RowSpec[] = [
    { icon: 'about', title: 'About', value: APP_VERSION, route: 'about' },
    { icon: 'interface', title: 'Appearance', value: interfaceValue, route: 'interface' },
    { icon: 'bell', title: 'Notifications', value: alerts, route: 'notifications' },
    { icon: 'assistant', title: 'Assistant', value: assistant.enabled ? 'Experimental · On' : 'Experimental · Off', route: 'assistant' },
  ];
  const findRows: RowSpec[] = [
    { icon: 'search', title: 'Search providers', value: providers, route: 'search-providers' },
    { icon: 'feeds', title: 'Auto-download', value: auto, route: 'feeds' },
    { icon: 'network', title: 'Browser', value: browserPrefs.adBlock ? 'Ad blocking on' : 'Ad blocking off', route: 'browser' },
  ];
  const speedRow: RowSpec = { icon: 'bandwidth', title: 'Speed & queue', value: `${limits} · ${queue}`, route: 'speed' };
  const scheduleRow: RowSpec = { icon: 'schedule', title: 'Scheduling', value: scheduling, route: 'scheduling' };
  const connectionRows: RowSpec[] = [
    { icon: 'network', title: 'Network', value: network, route: 'network' },
    { icon: 'power', title: 'Power', value: power, route: 'power' },
  ];

  // "More below": a fade over the bottom edge until the end is near, and a pill that stays until the end has been reached once (or it is tapped).
  const scrollRef = useRef<ScrollViewInstance>(null);
  const metrics = useRef({ y: 0, viewport: 0, content: 0 });
  const [atEnd, setAtEnd] = useState(false);
  const [hintSeen, setHintSeen] = useState(getMoreHintSeen);
  const dismissHint = useCallback(() => {
    if (getMoreHintSeen()) return;
    markMoreHintSeen();
    setHintSeen(true);
  }, []);
  const refresh = useCallback(() => {
    const m = metrics.current;
    const end = m.viewport > 0 && m.content > 0 && nearEnd(m.y, m.viewport, m.content);
    setAtEnd((prev) => (prev === end ? prev : end));
    // Seen once the end has been reached by scrolling, not on the first nudge.
    if (end && m.y > 0) dismissHint();
  }, [dismissHint]);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      metrics.current.y = e.nativeEvent.contentOffset.y;
      refresh();
    },
    [refresh],
  );
  const scrollDown = useCallback(() => {
    const m = metrics.current;
    dismissHint();
    scrollRef.current?.scrollTo({ y: Math.min(m.y + m.viewport * 0.6, Math.max(0, m.content - m.viewport)), animated: true });
  }, [dismissHint]);

  return (
    <Screen title="SETTINGS" contentStyle={styles.body}>
      <ScrollView
        ref={scrollRef}
        style={styles.body}
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={32}
        persistentScrollbar
        onLayout={(e) => {
          metrics.current.viewport = e.nativeEvent.layout.height;
          refresh();
        }}
        onContentSizeChange={(_, h) => {
          metrics.current.content = h;
          refresh();
        }}
      >
        <NeedsAttention />
        <View style={styles.section}>
          <SectionHeader title="App" />
          <Card>
            {appRows.map((r) => (
              <SettingsRow key={r.route} {...r} />
            ))}
          </Card>
        </View>
        <View style={styles.section}>
          <SectionHeader title="Finding things" />
          <Card>
            {findRows.map((r) => (
              <SettingsRow key={r.route} {...r} />
            ))}
          </Card>
        </View>
        <View style={styles.section}>
          <SectionHeader title="Downloads" />
          <Card>
            <StorageRow />
            <SettingsRow {...speedRow} />
            <SettingsRow {...scheduleRow} />
          </Card>
        </View>
        <View style={styles.section}>
          <SectionHeader title="Connection" />
          <Card>
            {connectionRows.map((r) => (
              <SettingsRow key={r.route} {...r} />
            ))}
          </Card>
        </View>
      </ScrollView>
      <BottomFade hidden={atEnd} />
      {!hintSeen && !atEnd ? <MoreBelowPill onPress={scrollDown} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl },
  section: { gap: spacing.sm },
});
