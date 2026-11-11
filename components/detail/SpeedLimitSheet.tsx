import React, { useState } from 'react';
import type { TorrentLimits } from 'maglev-engine';
import { SPEED_PRESET_MAP } from 'maglev-engine';
import { useSettings } from '../../context/SettingsContext';
import { Caption, ChipGroup, BYTES_PER_MB, InputSheet, formatLimit } from '../settings/SettingsParts';
import { Sheet } from '../ui';

const KB = 1024;
const CUSTOM = -1;
const PRESETS = [
  { value: 0, label: 'No limit' },
  { value: 512 * KB, label: '512 KB/s' },
  { value: BYTES_PER_MB, label: '1 MB/s' },
  { value: 5 * BYTES_PER_MB, label: '5 MB/s' },
  { value: CUSTOM, label: 'Custom' },
] as const;

type Dir = 'down' | 'up';

interface Props {
  visible: boolean;
  onClose: () => void;
  limits: TorrentLimits;
  /** Applied right away, no Save button. */
  onChange: (limits: TorrentLimits) => void;
}

/** Overall limit from settings in bytes per second, 0 = none. */
function useGlobalLimit(dir: Dir): number {
  const { settings } = useSettings();
  const b = settings.bandwidth;
  const preset = dir === 'down' ? b.downloadPreset : b.uploadPreset;
  const custom = dir === 'down' ? b.downloadLimitBytesPerSec : b.uploadLimitBytesPerSec;
  return preset === 'CUSTOM' ? custom : SPEED_PRESET_MAP[preset];
}

function groupValue(bps: number, customPicked: boolean): number {
  if (customPicked) return CUSTOM;
  return PRESETS.some((p) => p.value === bps) ? bps : CUSTOM;
}

/** Per-torrent download and upload limits (NATIVE_CONTRACT 11.2). The overall limit still applies. */
export function SpeedLimitSheet({ visible, onClose, limits, onChange }: Props) {
  const [custom, setCustom] = useState<Dir | null>(null);
  const [customPicked, setCustomPicked] = useState<Record<Dir, boolean>>({ down: false, up: false });
  const globalDown = useGlobalLimit('down');
  const globalUp = useGlobalLimit('up');
  const bps = (dir: Dir) => (dir === 'down' ? limits.downBps : limits.upBps);
  const globalOf = (dir: Dir) => (dir === 'down' ? globalDown : globalUp);

  const set = (dir: Dir, value: number) =>
    onChange(dir === 'down' ? { downBps: value, upBps: limits.upBps } : { downBps: limits.downBps, upBps: value });

  const pick = (dir: Dir, value: number) => {
    if (value === CUSTOM) {
      setCustom(dir);
      return;
    }
    setCustomPicked((p) => ({ ...p, [dir]: false }));
    set(dir, value);
  };

  const caption = (dir: Dir) => {
    const own = bps(dir);
    if (own <= 0) return undefined;
    const base = `This torrent: ${formatLimit(own)}.`;
    return globalOf(dir) > 0 ? `${base} The overall limit still applies.` : base;
  };

  return (
    <>
      <Sheet visible={visible && custom === null} onClose={onClose} title="Speed limit" subtitle="Only for this torrent">
        <ChipGroup
          label="Download"
          caption={caption('down')}
          options={PRESETS}
          value={groupValue(limits.downBps, customPicked.down)}
          onChange={(v) => pick('down', v)}
        />
        <ChipGroup
          label="Upload"
          caption={caption('up')}
          options={PRESETS}
          value={groupValue(limits.upBps, customPicked.up)}
          onChange={(v) => pick('up', v)}
        />
        {globalDown > 0 || globalUp > 0 ? (
          <Caption>The overall limit in Settings still applies. The lower of the two wins.</Caption>
        ) : null}
      </Sheet>
      <InputSheet
        visible={visible && custom !== null}
        title={custom === 'up' ? 'Custom upload limit' : 'Custom download limit'}
        subtitle="Enter a speed from 0.1 to 1000 MB/s."
        initial={custom && bps(custom) > 0 ? String(Math.round((bps(custom) / BYTES_PER_MB) * 10) / 10) : ''}
        unit="MB/s"
        numeric
        decimal
        validate={(raw) => {
          const n = Number(raw);
          return raw !== '' && Number.isFinite(n) && n >= 0.1 && n <= 1000 ? null : 'Enter a number from 0.1 to 1000.';
        }}
        onClose={() => setCustom(null)}
        onSubmit={(raw) => {
          if (custom) {
            setCustomPicked((p) => ({ ...p, [custom]: true }));
            set(custom, Math.round(Number(raw) * BYTES_PER_MB));
          }
          setCustom(null);
        }}
      />
    </>
  );
}
