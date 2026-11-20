import React, { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { useSettings } from '../../context/SettingsContext';
import { IconButton, ListRow, Toggle } from '../../components/ui';
import { Caption, Card, InputSheet, SettingsPage } from '../../components/settings/SettingsParts';
import { NetworkRestartBanner, useNetworkStatus } from '../../components/settings/NetworkRestartBanner';
import { networkAdvancedCopy as advanced } from '../../constants/copy';

type Field = 'ssid';

export default function NetworkSettings() {
  const { settings, updateSettings } = useSettings();
  const router = useRouter();
  const { restartPending, busy, restart } = useNetworkStatus();
  const n = settings.network;
  const [field, setField] = useState<Field | null>(null);

  const set = (patch: Partial<typeof n>) => updateSettings((prev) => ({ network: { ...prev.network, ...patch } }));
  const sw = (label: string, value: boolean, onValueChange: (v: boolean) => void) => (
    <Toggle value={value} onValueChange={onValueChange} accessibilityLabel={label} />
  );

  return (
    <SettingsPage title="Network">
      <Stack.Screen options={{ headerShown: false }} />
      <NetworkRestartBanner restartPending={restartPending} busy={busy} onRestart={() => void restart()} />

      <Card>
        <ListRow
          title="Wi-Fi only"
          subtitle="Pause downloads on mobile data."
          accessory={sw('Wi-Fi only', n.wifiOnly, (v) => set({ wifiOnly: v }))}
        />
        <ListRow
          title="Share on mobile data"
          subtitle="Off: finished torrents stop uploading until you're on Wi-Fi."
          accessory={sw('Share on mobile data', n.seedOnMobileData, (v) => set({ seedOnMobileData: v }))}
        />
        <ListRow
          title="Only download over a VPN"
          subtitle="Pauses when no VPN is connected."
          accessory={sw('Only download over a VPN', n.vpnOnly, (v) => set({ vpnOnly: v }))}
        />
        <ListRow
          title="Only on these networks"
          subtitle="Limit downloads to Wi-Fi names you list."
          accessory={sw('Only on these networks', n.ssidWhitelistEnabled, (v) => set({ ssidWhitelistEnabled: v }))}
        />
        {n.ssidWhitelistEnabled ? (
          <>
            {n.allowedSsids.map((name) => (
              <ListRow
                key={name}
                title={name}
                accessory={
                  <IconButton
                    icon="close"
                    size={16}
                    accessibilityLabel={`Remove ${name}`}
                    onPress={() => set({ allowedSsids: n.allowedSsids.filter((x) => x !== name) })}
                  />
                }
              />
            ))}
            <ListRow icon="plus" title="Add network name" onPress={() => setField('ssid')} />
          </>
        ) : null}
      </Card>
      {n.ssidWhitelistEnabled ? <Caption tone="warning">Needs location permission to work</Caption> : null}

      <Card>
        <ListRow
          title={advanced.rowTitle}
          subtitle={advanced.rowSubtitle}
          onPress={() => router.push('/settings/network-advanced' as never)}
        />
      </Card>
      <InputSheet
        visible={field === 'ssid'}
        title="Add network name"
        subtitle="Type the Wi-Fi name exactly as it appears."
        initial=""
        validate={(r) =>
          !r ? 'Enter a network name.' : n.allowedSsids.includes(r) ? 'That network is already in the list.' : null
        }
        submitLabel="Add"
        onClose={() => setField(null)}
        onSubmit={(r) => {
          set({ allowedSsids: [...n.allowedSsids, r] });
          setField(null);
        }}
      />
    </SettingsPage>
  );
}
