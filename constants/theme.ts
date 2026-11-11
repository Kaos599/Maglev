/**
 * Maglev theme foundation.
 *
 * STYLE PATTERN (applies to every screen and component):
 *   const { colors } = useTheme();
 *   const styles = useMemo(() => makeStyles(colors), [colors]);
 *   ...
 *   const makeStyles = (c: ThemeColors) => StyleSheet.create({ ... });
 * Never write hex or rgba literals outside this file. Use `colors.*`, and
 * `alpha(colors.accent, 0.15)` for tints. Fonts come from `type`:
 *   spread `...type.mono` for numbers, filenames and telemetry (tabular-nums),
 *   `...type.body` / `...type.bodyStrong` for copy, `...type.brand` for
 *   brand wordmark and headers only. Custom faces have no synthetic bold on
 *   Android, so never pair fontWeight with them; use the Bold/SemiBold face.
 *
 * CONTRAST (WCAG 2.x, computed by the helper below, verified with node):
 *   mode   text/bg  textMuted/bg  textFaint/bg  accentText(lime)/bg  borderStrong/bg
 *   oled   18.33    7.94          5.41           17.16                4.17
 *   dim    16.00    7.95          5.13           15.82                3.89
 *   light  16.42    6.83          4.46           6.47                 3.48
 * Light role colours on bg (#F5F5F0): download 5.43, upload 6.47, success 4.59, paused 5.51,
 * warning 5.84, danger 5.15; accent fill #4D7C0F is 4.57 on bg and 4.99 with white onAccent text.
 * First chip (light): firstFg on firstBg 12.52. selBg/selBorder are fills, not text.
 * Required: text, textMuted, accentText, download, upload, paused, success,
 * warning, danger >= 4.5 against bg; borderStrong >= 3 (interactive outlines).
 * textFaint is for disabled/placeholder hints only (>= 3 everywhere).
 * On light, accent fills use the darkened accent (white onAccent text) so the
 * fill itself has >= 3:1 against paper; lime on paper would be ~1.1:1.
 * firstBg/firstFg/firstBorder style the "First" chip; selBg/selBorder style a selected option card.
 */

export type ThemeMode = 'oled' | 'dim' | 'light';
export type AccentName = 'lime' | 'cyan' | 'pink' | 'orange';

export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  onAccent: string;
  accentText: string;
  download: string;
  upload: string;
  paused: string;
  success: string;
  warning: string;
  danger: string;
  onDanger: string;
  overlay: string;
  focus: string;
  firstBg: string;
  firstFg: string;
  firstBorder: string;
  selBg: string;
  selBorder: string;
}

/** WCAG relative luminance of a #RRGGBB color. */
export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #RRGGBB colors. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Tint a #RRGGBB color with an alpha, returning an rgba() string. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Same as `alpha`; the name the tab bar spec uses ("accent at 16%"). */
export const withAlpha = alpha;

interface Palette {
  bg: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  download: string;
  upload: string;
  paused: string;
  success: string;
  warning: string;
  danger: string;
  onDanger: string;
  overlay: string;
  dark: boolean;
}

export const palettes: Record<ThemeMode, Palette> = {
  oled: {
    bg: '#05070A', surface: '#0D1117', surfaceRaised: '#161B22',
    border: '#1F2937', borderStrong: '#6B7280',
    text: '#F3F4F6', textMuted: '#9CA3AF', textFaint: '#7D8590',
    download: '#00E5FF', upload: '#CCFF00', paused: '#8B949E',
    success: '#3DDC84', warning: '#FFB020', danger: '#FF4D79', onDanger: '#05070A',
    overlay: 'rgba(0, 0, 0, 0.85)', dark: true,
  },
  dim: {
    bg: '#111317', surface: '#181B21', surfaceRaised: '#1F232A',
    border: '#2A2F38', borderStrong: '#6B7380',
    text: '#ECEEF1', textMuted: '#A3AAB5', textFaint: '#7F8793',
    download: '#00E5FF', upload: '#CCFF00', paused: '#9AA2AD',
    success: '#3DDC84', warning: '#FFB020', danger: '#FF4D79', onDanger: '#111317',
    overlay: 'rgba(8, 9, 11, 0.85)', dark: true,
  },
  light: {
    bg: '#F5F5F0', surface: '#FFFFFF', surfaceRaised: '#ECECE4',
    border: '#DAD9CF', borderStrong: '#85837A',
    text: '#15171A', textMuted: '#52555C', textFaint: '#6F7178',
    download: '#0369A1', upload: '#3F6212', paused: '#5F636B',
    success: '#15803D', warning: '#8A5200', danger: '#C71F4B', onDanger: '#FFFFFF',
    overlay: 'rgba(21, 23, 26, 0.55)', dark: false,
  },
};

/** Bright brand accent (dark modes) and its AA-safe darker variant (light mode). */
export const accents: Record<AccentName, { bright: string; deep: string; deepText: string }> = {
  lime: { bright: '#CCFF00', deep: '#4D7C0F', deepText: '#3F6212' },
  cyan: { bright: '#00E5FF', deep: '#00697A', deepText: '#00697A' },
  pink: { bright: '#FF5CA8', deep: '#B8135F', deepText: '#B8135F' },
  orange: { bright: '#FF9F1C', deep: '#9A4F00', deepText: '#9A4F00' },
};

export const DEFAULT_MODE: ThemeMode = 'oled';
export const DEFAULT_ACCENT: AccentName = 'lime';

export function isDarkMode(mode: ThemeMode): boolean {
  return palettes[mode].dark;
}

export function buildColors(mode: ThemeMode, accent: AccentName, pureBlack = false): ThemeColors {
  const p = palettes[mode];
  const a = accents[accent];
  const dark = p.dark;
  const accentFill = dark ? a.bright : a.deep;
  return {
    bg: pureBlack && mode === 'oled' ? '#000000' : p.bg,
    surface: pureBlack && mode === 'oled' ? '#07090D' : p.surface,
    surfaceRaised: p.surfaceRaised,
    border: p.border,
    borderStrong: p.borderStrong,
    text: p.text,
    textMuted: p.textMuted,
    textFaint: p.textFaint,
    accent: accentFill,
    onAccent: dark ? '#05070A' : '#FFFFFF',
    accentText: dark ? a.bright : a.deepText,
    // Cyan accent would make "downloading" indistinguishable from active/primary state.
    download: accent === 'cyan' ? (dark ? '#5AA9FF' : '#1F5FBF') : p.download,
    upload: p.upload,
    paused: p.paused,
    success: p.success,
    warning: p.warning,
    danger: p.danger,
    onDanger: p.onDanger,
    overlay: p.overlay,
    focus: dark ? '#00E5FF' : '#00697A',
    // "First" chip and selected option card. Light mode uses a lime highlighter for lime only.
    firstBg: dark || accent !== 'lime' ? alpha(accentFill, 0.1) : '#D9F99D',
    firstFg: dark || accent !== 'lime' ? (dark ? a.bright : a.deepText) : '#1A2E05',
    firstBorder: accentFill,
    selBg: dark || accent !== 'lime' ? alpha(accentFill, 0.08) : '#F4FCE3',
    selBorder: accentFill,
  };
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 40 } as const;

export const radius = { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 } as const;

/** Minimum interactive target, in dp. */
export const touch = { min: 44 } as const;

export const fontFamily = {
  brand: 'Silkscreen',
  mono: 'SpaceMono',
  monoBold: 'SpaceMonoBold',
  body: 'Inter',
  bodyStrong: 'InterSemiBold',
} as const;

export const type = {
  family: fontFamily,
  size: { xs: 11, sm: 12, md: 13, lg: 15, xl: 17, xxl: 22 },
  brand: { fontFamily: fontFamily.brand },
  mono: { fontFamily: fontFamily.mono, fontVariant: ['tabular-nums' as const] },
  monoBold: { fontFamily: fontFamily.monoBold, fontVariant: ['tabular-nums' as const] },
  body: { fontFamily: fontFamily.body },
  bodyStrong: { fontFamily: fontFamily.bodyStrong },
} as const;

export type Type = typeof type;
export type Spacing = typeof spacing;
export type Radius = typeof radius;

/** Alias of `type` for modules where the bare word `type` reads badly. */
export const fonts = type;
