/**
 * Font styles: Clean (default), Retro, Mono. Pure data, no imports, so node tests can load it.
 *
 * Screens never name a font file. They use semantic slots through `type` in constants/theme.ts:
 *   brand       the MAGLEV wordmark. Silkscreen in every style.
 *   heading     screen and sheet titles.
 *   mono        file names, sizes, speeds and other telemetry (tabular-nums).
 *   monoBold    the same, emphasised.
 *   body        copy.
 *   bodyStrong  emphasised copy.
 * `fontFamilies` maps each style to the font loaded under that name in app/_layout.tsx.
 */

export const FONT_STYLES = ['clean', 'retro', 'mono'] as const;
export type FontStyleName = (typeof FONT_STYLES)[number];
export const DEFAULT_FONT_STYLE: FontStyleName = 'clean';

/** Names the fonts are registered under (app/_layout.tsx loads one file per name). */
export const FONT_NAMES = {
  silkscreen: 'Silkscreen',
  spaceMono: 'SpaceMono',
  spaceMonoBold: 'SpaceMonoBold',
  inter: 'Inter',
  interMedium: 'InterMedium',
  interSemiBold: 'InterSemiBold',
  interBold: 'InterBold',
} as const;

export const FONT_SLOTS = ['brand', 'heading', 'mono', 'monoBold', 'body', 'bodyStrong'] as const;
export type FontSlot = (typeof FONT_SLOTS)[number];

const N = FONT_NAMES;

export const fontFamilies: Record<FontStyleName, Record<FontSlot, string>> = {
  clean: {
    brand: N.silkscreen,
    heading: N.interBold,
    mono: N.interMedium,
    monoBold: N.interSemiBold,
    body: N.inter,
    bodyStrong: N.interSemiBold,
  },
  retro: {
    brand: N.silkscreen,
    heading: N.silkscreen,
    mono: N.spaceMono,
    monoBold: N.spaceMonoBold,
    body: N.inter,
    bodyStrong: N.interSemiBold,
  },
  mono: {
    brand: N.silkscreen,
    heading: N.spaceMonoBold,
    mono: N.spaceMono,
    monoBold: N.spaceMonoBold,
    body: N.inter,
    bodyStrong: N.interSemiBold,
  },
};

/**
 * Glyph advance as a share of the font size, for sizing fixed-width value slots.
 * Space Mono is 612/1000 for every glyph. Inter's tabular digits are fixed but its letters vary;
 * the widest speed and size strings average 0.579 em per glyph (measured from the TTFs), so 0.6 holds them.
 */
export const slotAdvance: Record<FontStyleName, number> = { clean: 0.6, retro: 0.612, mono: 0.612 };

/** Any stored or unknown value becomes a valid style. */
export function resolveFontStyle(raw: unknown): FontStyleName {
  return (FONT_STYLES as readonly unknown[]).includes(raw) ? (raw as FontStyleName) : DEFAULT_FONT_STYLE;
}
