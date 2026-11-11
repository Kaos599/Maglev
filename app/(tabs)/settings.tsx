import React, { useMemo } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine as useEngine } from '../../context/EngineContext';
import { Banner, ListRow, Screen, SectionHeader } from '../../components/ui';
import { PixelIconName } from '../../components/PixelIcon';
import { useSearchPrefs } from '../../utils/prefs/search';
import { Card, formatLimit, friendlyPath } from '../../components/settings/SettingsParts';
import { spacing } from '../../constants/theme';

const ACCENT_LABEL = { lime: 'Lime', cyan: 'Cyan', pink: 'Pink', orange: 'Orange' } as const;
const MODE_LABEL = { oled: 'OLED', dim: 'Dim', light: 'Light', system: 'System' } as const;

export default function SettingsIndex() {
  const router = useRouter();
  const { settings } = useSettings();
  const { permissionStatus, storageStatus, defaultStoragePath, refreshPermissions } = useEngine();
  const [searchPrefs] = useSearchPrefs();
  const { bandwidth: b, network: n, power: p, appearance: a } = settings;

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
  }, [permissionStatus, storageStatus, refreshPermissions, router]);

  const folder = settings.downloadFolder?.displayName ?? friendlyPath(storageStatus?.path || defaultStoragePath);
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

  const rows: { icon: PixelIconName; title: string; value: string; route: string }[] = [
    { icon: 'folder', title: 'Storage', value: folder, route: 'storage' },
    { icon: 'bandwidth', title: 'Bandwidth', value: limits, route: 'bandwidth' },
    { icon: 'queue', title: 'Torrents & queue', value: `${b.maxActiveDownloads} at a time`, route: 'queue' },
    { icon: 'interface', title: 'Interface', value: `${MODE_LABEL[a.mode]} · ${ACCENT_LABEL[a.accent]}`, route: 'interface' },
    { icon: 'network', title: 'Network', value: n.wifiOnly ? 'Wi-Fi only' : 'Any network', route: 'network' },
    { icon: 'power', title: 'Power', value: power, route: 'power' },
    { icon: 'schedule', title: 'Scheduling', value: 'Coming soon', route: 'scheduling' },
    { icon: 'search', title: 'Search providers', value: `${searchPrefs.enabled.length} on`, route: 'search-providers' },
    { icon: 'feeds', title: 'Feeds', value: 'Feeds tab', route: 'feeds' },
    { icon: 'about', title: 'About', value: Constants.expoConfig?.version ?? '', route: 'about' },
  ];

  return (
    <Screen title="SETTINGS" scroll contentStyle={styles.content}>
      {attention.length > 0 ? (
        <View style={styles.section}>
          <SectionHeader title="Needs attention" />
          {attention}
        </View>
      ) : null}
      <Card>
        {rows.map((r) => (
          <ListRow
            key={r.route}
            icon={r.icon}
            title={r.title}
            value={r.value}
            onPress={() => router.push(`/settings/${r.route}` as never)}
          />
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl },
  section: { gap: spacing.sm },
});
