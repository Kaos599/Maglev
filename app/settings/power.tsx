import React from 'react';
import { Stack } from 'expo-router';
import { BatteryCutoffThreshold } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { ListRow, Toggle } from '../../components/ui';
import { Card, ChipGroup, SettingsPage } from '../../components/settings/SettingsParts';

const CUTOFFS: { value: BatteryCutoffThreshold; label: string }[] = [
  { value: 0, label: 'Off' },
  { value: 15, label: '15%' },
  { value: 20, label: '20%' },
  { value: 30, label: '30%' },
];

export default function PowerSettings() {
  const { settings, updateSettings } = useSettings();
  const p = settings.power;
  const set = (patch: Partial<typeof p>) => updateSettings((prev) => ({ power: { ...prev.power, ...patch } }));
  return (
    <SettingsPage title="POWER">
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <ListRow
          title="Charging only"
          subtitle="Download only while plugged in."
          accessory={<Toggle value={p.downloadOnlyWhileCharging} onValueChange={(v) => set({ downloadOnlyWhileCharging: v })} accessibilityLabel="Charging only" />}
        />
        <ListRow
          title="Close when done"
          subtitle="Exit Maglev after the last download finishes."
          accessory={<Toggle value={p.autoExitOnComplete} onValueChange={(v) => set({ autoExitOnComplete: v })} accessibilityLabel="Close when done" />}
        />
      </Card>
      <Card>
        <ChipGroup
          label="Pause below"
          caption="Downloads pause when the battery drops under this level."
          options={CUTOFFS}
          value={p.batteryCutoffThreshold}
          onChange={(v) => set({ batteryCutoffThreshold: v })}
        />
      </Card>
    </SettingsPage>
  );
}
