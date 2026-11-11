import React, { useState } from 'react';
import { Stack } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine as useEngine } from '../../context/EngineContext';
import { Banner, Button, ListRow } from '../../components/ui';
import { Caption, Card, SettingsPage, friendlyPath } from '../../components/settings/SettingsParts';

export default function StorageSettings() {
  const { settings, updateSettings } = useSettings();
  const { storageStatus, defaultStoragePath } = useEngine();
  const [error, setError] = useState<string | null>(null);
  const folder = settings.downloadFolder;

  const change = async () => {
    setError(null);
    try {
      const res = await maglevEngine.pickDownloadFolder();
      if ('cancelled' in res) return;
      updateSettings({ downloadFolder: { uri: res.uri, displayName: res.displayName, mode: res.mode } });
    } catch {
      setError("Couldn't open the folder picker. Try again.");
    }
  };

  const caption = !folder
    ? 'Files are saved to the default folder.'
    : folder.mode === 'staging'
      ? 'Files are copied there when they finish.'
      : 'Files are saved straight to this folder.';

  return (
    <SettingsPage title="STORAGE">
      <Stack.Screen options={{ headerShown: false }} />
      {storageStatus?.safLost ? (
        <Banner tone="danger" title="Folder access lost" body="Maglev can no longer write to your chosen folder." actionLabel="Pick again" onAction={change} />
      ) : storageStatus?.fallback ? (
        <Banner tone="warning" title="Files are saved in app storage" body="The download folder isn't available right now." actionLabel="Choose folder" onAction={change} />
      ) : null}
      {error ? <Banner tone="danger" title={error} actionLabel="Retry" onAction={change} /> : null}
      <Card>
        <ListRow
          icon="folder"
          title="Download folder"
          subtitle={folder ? folder.displayName : friendlyPath(storageStatus?.path || defaultStoragePath)}
        />
      </Card>
      <Caption>{caption}</Caption>
      <Button label="Change folder" onPress={change} variant="secondary" />
      {folder ? (
        <Button label="Use default folder" onPress={() => updateSettings({ downloadFolder: null })} variant="ghost" />
      ) : null}
    </SettingsPage>
  );
}
