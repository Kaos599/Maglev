export const TOKENS = {
  colors: {
    bgOled: '#05070A',
    surfaceCard: '#0D1117',
    surfaceBorder: '#1F2937',
    surfacePill: '#161B22',
    accentLime: '#CCFF00',
    accentCyan: '#00E5FF',
    statusPaused: '#8B949E',
    statusDanger: '#FF3366',
    statusPink: '#FF007F',
    textPrimary: '#F3F4F6',
    textMuted: '#8B949E',
    navBg: '#070A0E',
    navBorder: '#161C26',
    blockUnavailable: '#161D26',
    blockInFlight: '#CCFF00',
    blockVerified: '#00E5FF',
    blockCorrupt: '#FF3366',
  },
  fonts: {
    pixel: 'Silkscreen',
    pixelBold: 'SilkscreenBold',
    mono: 'SpaceMono',
    monoBold: 'SpaceMonoBold',
    code: 'JetBrainsMono',
    codeBold: 'JetBrainsMonoBold',
    sans: 'Inter',
    sansBold: 'InterBold',
  },
  touchTarget: {
    minHeight: 44,
    minWidth: 44,
  },
  typography: {
    appTitle: {
      fontFamily: 'Silkscreen',
      fontSize: 14,
      fontWeight: '700' as const,
      letterSpacing: -0.28,
    },
    cardFilename: {
      fontFamily: 'SpaceMono',
      fontSize: 13,
      fontWeight: '700' as const,
      letterSpacing: -0.13,
    },
    pillButton: {
      fontFamily: 'Silkscreen',
      fontSize: 10,
      fontWeight: '700' as const,
      letterSpacing: 0,
    },
    telemetry: {
      fontFamily: 'SpaceMono',
      fontSize: 11,
      fontWeight: '500' as const,
      fontVariant: ['tabular-nums' as const],
    },
    uiCopy: {
      fontFamily: 'Inter',
      fontSize: 13,
      fontWeight: '400' as const,
    },
    navLabel: {
      fontFamily: 'Silkscreen',
      fontSize: 8,
      fontWeight: '700' as const,
      letterSpacing: 0.4,
    },
  },
};

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}
