import React, { useState } from 'react';
import { Stack } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useSettings } from '../../context/SettingsContext';
import { Banner, Button, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Caption, Card, InputSheet, SettingsPage, parseIntIn } from '../../components/settings/SettingsParts';
import { NetworkRestartBanner, useNetworkStatus } from '../../components/settings/NetworkRestartBanner';
import { networkAdvancedCopy as copy, notices } from '../../constants/copy';
import { blocklistSubtitle } from '../../utils/networkStatus';

type Field = 'port' | 'proxyHost' | 'proxyPort' | 'proxyUser' | 'proxyPass';

/** Torrent internals: port, peer finding, proxy and the IP block list. The everyday network rules stay on Network. */
export default function NetworkAdvancedSettings() {
  const { settings, updateSettings } = useSettings();
  const { restartPending, blocklist, busy, restart } = useNetworkStatus();
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
  const blocklistLine = blocklistSubtitle(blocklistName, n.ipFilterEnabled && n.ipFilterPath ? blocklist : null);

  return (
    <SettingsPage title={copy.pageTitle}>
      <Stack.Screen options={{ headerShown: false }} />
      <NetworkRestartBanner restartPending={restartPending} busy={busy} onRestart={() => void restart()} />

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
          subtitle={blocklistLine.text}
          subtitleTone={blocklistLine.danger ? 'danger' : undefined}
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
