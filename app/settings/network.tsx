import React, { useState } from 'react';
import { Stack } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine as useEngine } from '../../context/EngineContext';
import { Banner, Button, Chip, IconButton, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, InputSheet, SettingsPage, parseIntIn } from '../../components/settings/SettingsParts';
import { notices } from '../../constants/copy';

type Field = 'port' | 'ssid' | 'proxyHost' | 'proxyPort' | 'proxyUser' | 'proxyPass';

export default function NetworkSettings() {
  const { settings, updateSettings } = useSettings();
  const { restartRequired } = useEngine();
  const n = settings.network;
  const [field, setField] = useState<Field | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const set = (patch: Partial<typeof n>) => updateSettings((prev) => ({ network: { ...prev.network, ...patch } }));
  const setProxy = (patch: Partial<typeof n.proxy>) =>
    updateSettings((prev) => ({ network: { ...prev.network, proxy: { ...prev.network.proxy, ...patch } } }));
  const sw = (label: string, value: boolean, onValueChange: (v: boolean) => void) => (
    <Toggle value={value} onValueChange={onValueChange} accessibilityLabel={label} />
  );

  const pickBlocklist = async () => {
    setFileError(null);
    try {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
      if (res.canceled || !res.assets?.[0]) return;
      const path = res.assets[0].uri.replace(/^file:\/\//, '');
      set({ ipFilterPath: path, ipFilterEnabled: true });
    } catch {
      setFileError(notices.inline.readFileFailed);
    }
  };

  const proxyHostValue = n.proxy.host || '—';
  const blocklistName = n.ipFilterPath ? decodeURIComponent(n.ipFilterPath.split('/').pop() ?? '') : '';

  return (
    <SettingsPage title="Network">
      <Stack.Screen options={{ headerShown: false }} />
      {restartRequired ? <Chip label="Takes effect next launch" selected /> : null}

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

      <SectionHeader title="Connection" />
      <Card>
        <ListRow title="Incoming port" value={String(n.listeningPort)} onPress={() => setField('port')} />
        <ListRow title="UPnP" subtitle="Open the port on your router." accessory={sw('UPnP', n.upnpEnabled, (v) => set({ upnpEnabled: v }))} />
        <ListRow title="DHT" subtitle="Find peers without a tracker." accessory={sw('DHT', n.dhtEnabled, (v) => set({ dhtEnabled: v }))} />
        <ListRow title="Local peer discovery" subtitle="Find peers on your Wi-Fi." accessory={sw('Local peer discovery', n.lsdEnabled, (v) => set({ lsdEnabled: v }))} />
      </Card>

      <SectionHeader title="Proxy" />
      <Card>
        <ListRow title="SOCKS5 proxy" accessory={sw('SOCKS5 proxy', n.proxy.enabled, (v) => setProxy({ enabled: v, type: 'SOCKS5' }))} />
        {n.proxy.enabled ? (
          <>
            <ListRow title="Host" value={proxyHostValue} onPress={() => setField('proxyHost')} />
            <ListRow title="Port" value={String(n.proxy.port)} onPress={() => setField('proxyPort')} />
            <ListRow title="Username" value={n.proxy.username || 'None'} onPress={() => setField('proxyUser')} />
            <ListRow title="Password" value={n.proxy.password ? '••••••' : 'None'} onPress={() => setField('proxyPass')} />
          </>
        ) : null}
      </Card>
      <Caption>Peer and web traffic only</Caption>

      <SectionHeader title="IP blocklist" />
      <Card>
        <ListRow
          title="Block listed IPs"
          subtitle={blocklistName || 'No file chosen'}
          accessory={sw('Block listed IPs', n.ipFilterEnabled && !!n.ipFilterPath, (v) => set({ ipFilterEnabled: v && !!n.ipFilterPath }))}
        />
      </Card>
      {fileError ? <Banner tone="danger" title={fileError} actionLabel="Retry" onAction={pickBlocklist} /> : null}
      <Button label={n.ipFilterPath ? 'Choose another file' : 'Choose blocklist file'} variant="secondary" onPress={pickBlocklist} />

      <InputSheet
        visible={field === 'port'}
        title="Incoming port"
        subtitle="Enter a port from 1024 to 65535."
        initial={String(n.listeningPort)}
        numeric
        validate={(r) => (parseIntIn(r, 1024, 65535) === null ? 'Enter a whole number from 1024 to 65535.' : null)}
        onClose={() => setField(null)}
        onSubmit={(r) => {
          const v = parseIntIn(r, 1024, 65535);
          if (v !== null) set({ listeningPort: v });
          setField(null);
        }}
      />
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
      <InputSheet
        visible={field === 'proxyHost'}
        title="Proxy host"
        initial={n.proxy.host}
        placeholder="127.0.0.1"
        validate={(r) => (/^[A-Za-z0-9.\-]+$/.test(r) ? null : 'Enter a host name or IP address.')}
        onClose={() => setField(null)}
        onSubmit={(r) => {
          setProxy({ host: r });
          setField(null);
        }}
      />
      <InputSheet
        visible={field === 'proxyPort'}
        title="Proxy port"
        subtitle="Enter a port from 1 to 65535."
        initial={String(n.proxy.port)}
        numeric
        validate={(r) => (parseIntIn(r, 1, 65535) === null ? 'Enter a whole number from 1 to 65535.' : null)}
        onClose={() => setField(null)}
        onSubmit={(r) => {
          const v = parseIntIn(r, 1, 65535);
          if (v !== null) setProxy({ port: v });
          setField(null);
        }}
      />
      <InputSheet
        visible={field === 'proxyUser'}
        title="Proxy username"
        subtitle="Leave empty for none."
        initial={n.proxy.username ?? ''}
        validate={() => null}
        onClose={() => setField(null)}
        onSubmit={(r) => {
          setProxy({ username: r || undefined });
          setField(null);
        }}
      />
      <InputSheet
        visible={field === 'proxyPass'}
        title="Proxy password"
        subtitle="Leave empty for none."
        initial={n.proxy.password ?? ''}
        secure
        validate={() => null}
        onClose={() => setField(null)}
        onSubmit={(r) => {
          setProxy({ password: r || undefined });
          setField(null);
        }}
      />
    </SettingsPage>
  );
}
