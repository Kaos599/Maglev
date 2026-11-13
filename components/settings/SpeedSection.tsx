import React, { useState } from 'react';
import { SpeedPreset } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { ListRow } from '../ui';
import {
  BYTES_PER_MB,
  Card,
  ChipGroup,
  InputSheet,
  formatLimit,
  parseIntIn,
} from './SettingsParts';

const PRESETS = [
  { value: 'UNLIMITED', label: 'Unlimited' },
  { value: '1MB', label: '1 MB/s' },
  { value: '2MB', label: '2 MB/s' },
  { value: '5MB', label: '5 MB/s' },
  { value: '10MB', label: '10 MB/s' },
  { value: 'CUSTOM', label: 'Custom' },
] as const;

/** Download and upload limits and connections per torrent. Rendered on Settings > Speed & queue. */
export function SpeedSection() {
  const { settings, updateSettings, setSpeedPreset } = useSettings();
  const b = settings.bandwidth;
  const [sheet, setSheet] = useState<'download' | 'upload' | 'conns' | null>(null);

  const pick = (dir: 'download' | 'upload', p: SpeedPreset) => {
    if (p === 'CUSTOM') {
      setSheet(dir);
      return;
    }
    setSpeedPreset(dir, p);
  };
  const customLabel = (preset: SpeedPreset, bps: number) =>
    preset === 'CUSTOM' ? `Custom: ${formatLimit(bps)}` : undefined;

  return (
    <>
      <Card>
        <ChipGroup
          label="Download limit"
          caption={customLabel(b.downloadPreset, b.downloadLimitBytesPerSec)}
          options={PRESETS}
          value={b.downloadPreset}
          onChange={(p) => pick('download', p)}
        />
        <ChipGroup
          label="Upload limit"
          caption={customLabel(b.uploadPreset, b.uploadLimitBytesPerSec)}
          options={PRESETS}
          value={b.uploadPreset}
          onChange={(p) => pick('upload', p)}
        />
      </Card>
      <Card>
        <ListRow
          title="Connections per torrent"
          value={String(b.maxConnectionsPerTorrent)}
          onPress={() => setSheet('conns')}
        />
      </Card>

      <InputSheet
        visible={sheet === 'download' || sheet === 'upload'}
        title={sheet === 'upload' ? 'Custom upload limit' : 'Custom download limit'}
        subtitle="Enter a speed from 0.1 to 1000 MB/s."
        initial={String(
          Math.round(((sheet === 'upload' ? b.uploadLimitBytesPerSec : b.downloadLimitBytesPerSec) / BYTES_PER_MB) * 10) / 10 || '',
        )}
        unit="MB/s"
        numeric
        decimal
        validate={(raw) => {
          const n = Number(raw);
          return raw !== '' && Number.isFinite(n) && n >= 0.1 && n <= 1000 ? null : 'Enter a number from 0.1 to 1000.';
        }}
        onClose={() => setSheet(null)}
        onSubmit={(raw) => {
          if (sheet === 'download' || sheet === 'upload') setSpeedPreset(sheet, 'CUSTOM', Math.round(Number(raw) * BYTES_PER_MB));
          setSheet(null);
        }}
      />
      <InputSheet
        visible={sheet === 'conns'}
        title="Connections per torrent"
        subtitle="Enter a number from 10 to 500."
        initial={String(b.maxConnectionsPerTorrent)}
        numeric
        validate={(raw) => (parseIntIn(raw, 10, 500) === null ? 'Enter a whole number from 10 to 500.' : null)}
        onClose={() => setSheet(null)}
        onSubmit={(raw) => {
          const n = parseIntIn(raw, 10, 500);
          if (n !== null) updateSettings((prev) => ({ bandwidth: { ...prev.bandwidth, maxConnectionsPerTorrent: n } }));
          setSheet(null);
        }}
      />
    </>
  );
}
