import React, { useState } from 'react';
import { Stack } from 'expo-router';
import { SeedingDurationLimit, SeedingRatioLimit } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { Card, ChipGroup, InputSheet, SettingsPage, parseIntIn } from '../../components/settings/SettingsParts';

const COUNTS = [1, 2, 3, 5, 10];
const RATIOS: { value: SeedingRatioLimit; label: string }[] = [
  { value: 0, label: 'Unlimited' },
  { value: 1.0, label: '1.0' },
  { value: 1.5, label: '1.5' },
  { value: 2.0, label: '2.0' },
  { value: 3.0, label: '3.0' },
];
const DURATIONS: { value: SeedingDurationLimit; label: string }[] = [
  { value: 0, label: 'Unlimited' },
  { value: 3600, label: '1 hour' },
  { value: 21600, label: '6 hours' },
  { value: 86400, label: '24 hours' },
];

type Field = 'maxActiveDownloads' | 'maxActiveUploads';

export default function QueueSettings() {
  const { settings, updateSettings } = useSettings();
  const b = settings.bandwidth;
  const [custom, setCustom] = useState<Field | null>(null);

  const set = (field: Field, n: number) =>
    updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, [field]: n } }));
  const options = (v: number) => [
    ...COUNTS.map((n) => ({ value: n, label: String(n) })),
    { value: -1, label: COUNTS.includes(v) ? 'Custom' : `Custom: ${v}` },
  ];
  const pickCount = (field: Field) => (n: number) => (n === -1 ? setCustom(field) : set(field, n));

  return (
    <SettingsPage title="TORRENTS & QUEUE">
      <Stack.Screen options={{ headerShown: false }} />
      <Card>
        <ChipGroup
          label="Active downloads"
          caption="Extra torrents wait in the queue."
          options={options(b.maxActiveDownloads)}
          value={COUNTS.includes(b.maxActiveDownloads) ? b.maxActiveDownloads : -1}
          onChange={pickCount('maxActiveDownloads')}
        />
        <ChipGroup
          label="Active seeds"
          options={options(b.maxActiveUploads)}
          value={COUNTS.includes(b.maxActiveUploads) ? b.maxActiveUploads : -1}
          onChange={pickCount('maxActiveUploads')}
        />
      </Card>
      <Card>
        <ChipGroup
          label="Seed ratio limit"
          caption="Stop seeding when this ratio is reached."
          options={RATIOS}
          value={b.seedingRatioLimit}
          onChange={(v) => updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, seedingRatioLimit: v } }))}
        />
        <ChipGroup
          label="Seed time limit"
          caption="Stop seeding after this long."
          options={DURATIONS}
          value={b.seedingDurationLimitSeconds}
          onChange={(v) => updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, seedingDurationLimitSeconds: v } }))}
        />
      </Card>
      <InputSheet
        visible={custom !== null}
        title={custom === 'maxActiveUploads' ? 'Active seeds' : 'Active downloads'}
        subtitle="Enter a number from 1 to 50."
        initial={custom ? String(b[custom]) : ''}
        numeric
        validate={(raw) => (parseIntIn(raw, 1, 50) === null ? 'Enter a whole number from 1 to 50.' : null)}
        onClose={() => setCustom(null)}
        onSubmit={(raw) => {
          const n = parseIntIn(raw, 1, 50);
          if (custom && n !== null) set(custom, n);
          setCustom(null);
        }}
      />
    </SettingsPage>
  );
}
