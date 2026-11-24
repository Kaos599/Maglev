import { motion } from '../../constants/theme.ts';

/**
 * Pure data for the tab bar's signature moves. Each tab icon (24 grid, drawn at 20 px) is split
 * into named parts, written as absolute rects so they can be drawn and moved on their own. At
 * rest (progress 1) the parts draw exactly the icon in components/icons.generated.ts;
 * scripts/test-tab-glyphs.js proves it pixel for pixel.
 *
 * A track maps the move's progress (0 to 1) to one property. Steps use doubled stops so the
 * value jumps instead of easing. Every track ends at rest: 0 for translateY and rotate, 1 for
 * opacity, 1 for scale. translateX and translateY are in grid units (the component converts to px, 1 unit = 20/24 px).
 * A scale track may name an origin (grid units); the component keeps that point fixed while the part grows.
 */

export type TabGlyphName = 'tab-transfers' | 'tab-search' | 'tab-feeds' | 'tab-settings' | 'tab-assistant' | 'tab-browse';

export interface GlyphTrack {
  prop: 'translateX' | 'translateY' | 'rotate' | 'opacity' | 'scale';
  inputRange: number[];
  outputRange: number[];
  /** Ease the segments (rotate only). Everything else steps. */
  ease?: boolean;
  /** Scale only: the grid point that stays where it is while the part scales. */
  origin?: [number, number];
}

export interface GlyphPart {
  id: string;
  d: string;
  /** One track, or several that the part plays together (the loupe's handle slides in x and y). */
  track?: GlyphTrack | GlyphTrack[];
}

export interface TabGlyphDef {
  move: 'pump' | 'loupe' | 'draw' | 'spin' | 'wobble' | 'blink';
  parts: GlyphPart[];
  /** Applied to a wrapper around all parts (the gear's rotation). */
  wrapTrack?: GlyphTrack;
}

/** Every track a part plays, as a list. */
export const tracksOf = (part: GlyphPart): GlyphTrack[] => {
  if (!part.track) return [];
  return Array.isArray(part.track) ? part.track : [part.track];
};

/** Whole move, ms. Under the 250 ms ceiling. */
export const GLYPH_MOVE_MS = motion.duration.base;

/**
 * Pixel frames: each value is held for an equal share of the move, then the part is at rest
 * (0, or 1 for scale). Doubled stops make each change a jump, like sprite frames.
 */
export const frames = (
  prop: 'translateX' | 'translateY' | 'scale',
  values: number[],
  origin?: [number, number],
): GlyphTrack => {
  const rest = prop === 'scale' ? 1 : 0;
  const v = [...values, rest];
  const seg = 1 / v.length;
  const inputRange = [0];
  const outputRange = [v[0]];
  for (let i = 1; i < v.length; i++) {
    inputRange.push(i * seg, i * seg + 0.0001);
    outputRange.push(v[i - 1], v[i]);
  }
  inputRange.push(1);
  outputRange.push(rest);
  return origin ? { prop, inputRange, outputRange, origin } : { prop, inputRange, outputRange };
};

/** Hidden until `at`, then visible. Rest is visible. */
const appearAt = (at: number): GlyphTrack => ({
  prop: 'opacity',
  inputRange: [0, at, at + 0.0001, 1],
  outputRange: [0, 0, 1, 1],
});

export const TAB_GLYPHS: Record<TabGlyphName, TabGlyphDef> = {
  // The arrows pump past each other: up climbs two steps, down drops two steps half a beat behind, then both settle.
  'tab-transfers': {
    move: 'pump',
    parts: [
      { id: 'up', d: 'M6 4h2v16H6zM4 6h2v4H4zM2 8h2v2H2zM8 6h2v4H8zM10 8h2v2h-2z', track: frames('translateY', [-2, -4, -2, 0]) },
      { id: 'down', d: 'M16 4h2v16h-2zM14 14h2v4h-2zM12 14h2v2h-2zM18 14h2v4h-2zM20 14h2v2h-2z', track: frames('translateY', [0, 2, 4, 2]) },
    ],
  },
  // The loupe: the lens swells about its centre (10,10) and the handle slides out diagonally to stay attached, then both snap home.
  'tab-search': {
    move: 'loupe',
    parts: [
      {
        id: 'lens',
        d: 'M6 2h8v2H6zM4 4h2v2H4zM14 4h2v2h-2zM2 6h2v8H2zM16 6h2v8h-2zM4 14h2v2H4zM14 14h2v2h-2zM6 16h8v2H6z',
        track: frames('scale', [1.25, 1.5, 1.5, 1.25], [10, 10]),
      },
      {
        id: 'handle',
        d: 'M16 16h2v2h-2zM18 18h2v2h-2zM20 20h2v2h-2z',
        track: [frames('translateX', [2, 4, 4, 2]), frames('translateY', [2, 4, 4, 2])],
      },
    ],
  },
  'tab-feeds': {
    move: 'draw',
    parts: [
      { id: 'dot', d: 'M4 16h4v4H4z' },
      { id: 'inner', d: 'M4 10h6v2H4zM10 12h2v2h-2zM12 14h2v6h-2z', track: appearAt(0.34) },
      { id: 'outer', d: 'M4 4h6v2H4zM10 6h4v2h-4zM14 8h2v2h-2zM16 10h2v4h-2zM18 14h2v6h-2z', track: appearAt(0.67) },
    ],
  },
  'tab-settings': {
    move: 'spin',
    parts: [
      {
        id: 'gear',
        d: 'M4 20h3v-2h4v4h2v-4h4v2h-2v4H9v-4H7v2H2v-5h2v3Zm18 2h-5v-2h3v-3h2v5ZM6 11H2v2h4v4H4v-2H0V9h4V7h2v4Zm14-2h4v6h-4v2h-2v-4h4v-2h-4V7h2v2Zm-6 7h-4v-2h4v2Zm-4-2H8v-4h2v4Zm6 0h-2v-4h2v4Zm-2-4h-4V8h4v2ZM7 4H4v3H2V2h5v2Zm8 0h2V2h5v5h-2V4h-3v2h-4V2h-2v4H7V4h2V0h6v4Z',
      },
    ],
    // Ease-out to a quarter turn, then snap back. The gear looks the same every 90 degrees.
    wrapTrack: { prop: 'rotate', inputRange: [0, 0.97, 0.9701, 1], outputRange: [0, 90, 0, 0], ease: true },
  },
  'tab-assistant': {
    move: 'blink',
    parts: [
      {
        id: 'head',
        d: 'M4 6h16v2H4zM4 20h16v2H4zM2 8h2v12H2zM20 8h2v12h-2zM11 4h2v4h-2zM13 2h4v2h-4zM0 12h2v2H0zM22 12h2v2h-2zM10 16h4v2h-4zM8 14h2v2H8zM14 14h2v2h-2z',
      },
      {
        id: 'eyes',
        d: 'M8 10h2v2H8zM14 10h4v2h-4z',
        track: {
          prop: 'opacity',
          inputRange: [0, 0.4, 0.4001, 0.7, 0.7001, 1],
          outputRange: [1, 1, 0, 0, 1, 1],
        },
      },
    ],
  },
  // The Browser tab draws the 'network' globe: rim first, then the equator, then the meridians.
  'tab-browse': {
    move: 'draw',
    parts: [
      {
        id: 'rim',
        // Same winding as the source icon: the reversed right-hand rects leave its 2 px equator gap.
        d: 'M6 2h12v2H6zM6 20h12v2H6zM4 4h2v2H4zM20 4h-2v2h2zM2 6h2v12H2zM22 6h-2v12h2zM4 18h2v2H4zM20 18h-2v2h2z',
      },
      { id: 'equator', d: 'M3 11h18v2H3z', track: appearAt(0.34) },
      {
        id: 'meridians',
        d: 'M9 4h2v2H9zM9 18h2v2H9zM13 18h2v2h-2zM13 4h2v2h-2zM7 6h2v12H7zM15 6h2v12h-2z',
        track: appearAt(0.67),
      },
    ],
  },
};
