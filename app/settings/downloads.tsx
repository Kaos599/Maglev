import React from 'react';
import { Stack } from 'expo-router';
import { useSettings } from '../../context/SettingsContext';
import { ListRow, SectionHeader, Toggle } from '../../components/ui';
import { Card, SettingsPage } from '../../components/settings/SettingsParts';
import { ClipboardSetting } from '../../components/settings/ClipboardSetting';
import { PartsSection } from '../../components/settings/PartsSection';
import { RetrySection } from '../../components/settings/RetrySection';
import { quickShareCopy } from '../../constants/copy';

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
