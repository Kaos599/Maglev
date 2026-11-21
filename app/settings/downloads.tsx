import React, { useCallback, useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { maglevEngine } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { useMaglevEngine } from '../../context/EngineContext';
import { Button, ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { ClipboardSetting } from '../../components/settings/ClipboardSetting';
import { PartsSection } from '../../components/settings/PartsSection';
import { RetrySection } from '../../components/settings/RetrySection';
import { quickShareCopy } from '../../constants/copy';

/** Notice text for the Update now button. */
function updateNotice(status: string, version: string | null): string {
  if (status === 'updated') return `Updated yt-dlp to ${version ?? 'the newest version'}`;
  if (status === 'current') return `yt-dlp is up to date${version ? ` (${version})` : ''}`;
  return "Couldn't update yt-dlp. Check your connection.";
}

/** The reader behind YouTube, X and Instagram links. It changes often, so the app keeps it current. */
function VideoSitesRow() {
  const { showNotice } = useMaglevEngine();
  const [version, setVersion] = useState<string | null | undefined>(undefined);
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    void maglevEngine.videoSitesVersion().then(setVersion);
  }, []);
  const update = useCallback(async () => {
    setUpdating(true);
    const res = await maglevEngine.videoSitesUpdate();
    setUpdating(false);
    if (res.ok) {
      if (res.status !== 'failed') setVersion(res.version);
      showNotice({ message: updateNotice(res.status, res.version) }, 3000);
    } else {
      showNotice({ message: updateNotice('failed', null) });
    }
  }, [showNotice]);
  return (
    <ListRow
      title="Video sites"
      subtitle={version === undefined ? ' ' : version ? `yt-dlp ${version}` : 'yt-dlp built in'}
      accessory={<Button label="Update now" icon="download" loading={updating} disabled={updating} onPress={() => void update()} />}
    />
  );
}

export default function DownloadsSettings() {
  const { settings, updateSettings } = useSettings();
  const p = settings.power;
  const set = (patch: Partial<typeof p>) => updateSettings((prev) => ({ power: { ...prev.power, ...patch } }));
  return (
    <SettingsPage title="Adding and finishing">
      <Stack.Screen options={{ headerShown: false }} />
      <SectionHeader title="Adding downloads" />
      <Card>
        <ListRow
          title={quickShareCopy.setting.title}
          subtitle={quickShareCopy.setting.subtitle}
          accessory={
            <Toggle
              value={settings.storage.addWithoutAsking}
              onValueChange={(v) => updateSettings((prev) => ({ storage: { ...prev.storage, addWithoutAsking: v } }))}
              accessibilityLabel={quickShareCopy.setting.title}
            />
          }
        />
        <ClipboardSetting />
      </Card>
      <SectionHeader title="Link downloads" />
      <PartsSection />
      <RetrySection />
      <Card>
        <VideoSitesRow />
      </Card>
      <SectionHeader title="When downloads finish" />
      <Card>
        <ListRow
          title="Close when done"
          subtitle="Exit Maglev after the last download finishes."
          accessory={<Toggle value={p.autoExitOnComplete} onValueChange={(v) => set({ autoExitOnComplete: v })} accessibilityLabel="Close when done" />}
        />
        <ListRow
          title="Resume after restart"
          subtitle="Continue downloads after the phone restarts or Maglev updates."
          accessory={<Toggle value={p.resumeAfterRestart} onValueChange={(v) => set({ resumeAfterRestart: v })} accessibilityLabel="Resume after restart" />}
        />
      </Card>
    </SettingsPage>
  );
}
