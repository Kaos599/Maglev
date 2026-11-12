import React, { useCallback, useMemo } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine as useEngine } from '../../context/EngineContext';
import { Banner, ListRow, Screen, SectionHeader } from '../../components/ui';
import { PixelIconName } from '../../components/PixelIcon';
import { useSearchPrefs } from '../../utils/prefs/search';
import { scheduleSummary, useSchedule } from '../../utils/prefs/schedule';
import { feedAutomationSummary, useFeedAutomation } from '../../utils/prefs/feedAutomation';
import { useAssistantPrefs } from '../../utils/prefs/assistantApp';
import { Card, formatLimit, friendlyPath } from '../../components/settings/SettingsParts';
import { spacing } from '../../constants/theme';

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
          title="Notifications are off"
          body="Downloads may stop in the background."
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
          title="Android may stop downloads to save battery"
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
          title="Storage access denied"
          body="Files are saved in app storage instead."
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
          title="Folder access lost"
          body="Maglev can no longer write to your chosen folder."
          actionLabel="Pick again"
          onAction={() => router.push('/settings/storage')}
        />,
      );
    } else if (storageStatus?.fallback) {
      items.push(
        <Banner
          key="fallback"
          tone="warning"
          title="Files are saved in app storage"
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
  const [searchPrefs] = useSearchPrefs();
  const [schedule] = useSchedule();
  const [feedAuto] = useFeedAutomation();
  const assistant = useAssistantPrefs();
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

  const rows: RowSpec[] = [
    { icon: 'bandwidth', title: 'Bandwidth', value: limits, route: 'bandwidth' },
    { icon: 'queue', title: 'Torrents & queue', value: queue, route: 'queue' },
    { icon: 'interface', title: 'Interface', value: interfaceValue, route: 'interface' },
    { icon: 'network', title: 'Network', value: network, route: 'network' },
    { icon: 'power', title: 'Power', value: power, route: 'power' },
    { icon: 'schedule', title: 'Scheduling', value: scheduling, route: 'scheduling' },
    { icon: 'search', title: 'Search providers', value: providers, route: 'search-providers' },
    { icon: 'feeds', title: 'Auto-download', value: auto, route: 'feeds' },
    { icon: 'assistant', title: 'Assistant', value: assistant.enabled ? 'Experimental · On' : 'Experimental · Off', route: 'assistant' },
    { icon: 'about', title: 'About', value: APP_VERSION, route: 'about' },
  ];

  return (
    <Screen title="SETTINGS" scroll contentStyle={styles.content}>
      <NeedsAttention />
      <Card>
        <StorageRow />
        {rows.map((r) => (
          <SettingsRow key={r.route} {...r} />
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl },
  section: { gap: spacing.sm },
});
