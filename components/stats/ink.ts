import { alpha, type ThemeColors } from '../../constants/theme';

/**
 * Stats colours, all from theme tokens. Cyan (`download`) is data and downloading; the accent is only the busiest
 * building, today's lamp and the usual hour. Categories stay cyan, text and grey.
 */
export function statsInk(c: ThemeColors) {
  return {
    sky: c.bg,
    skyDay: c.surface,
    bldA: c.border,
    bldB: alpha(c.borderStrong, 0.3),
    winOn: alpha(c.download, 0.55),
    winOff: c.bg,
    groundA: c.border,
    groundB: c.surfaceRaised,
    line: c.border,
    lineStrong: c.borderStrong,
    raised: c.surfaceRaised,
    data: c.download,
    dataSoft: alpha(c.download, 0.5),
    heat: [alpha(c.download, 0.45), alpha(c.download, 0.7), c.download] as const,
    /** Card pictures: structure is muted at 60%, plus one accent (accent for done and finish, `data` cyan for time and speed). */
    pic: alpha(c.textMuted, 0.6),
    hi: c.accentText,
    text: c.text,
    muted: c.textMuted,
    faint: c.textFaint,
    danger: c.danger,
    /** Most downloaded: first, second, third, then Other. */
    categories: [c.download, alpha(c.download, 0.5), c.text, c.paused] as const,
  };
}

export type StatsInk = ReturnType<typeof statsInk>;
