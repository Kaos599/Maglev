/**
 * Pure data for the tab bar's signature moves. Each tab icon (24 grid, drawn at 20 px) is split
 * into named parts, written as absolute rects so they can be drawn and moved on their own. At
 * rest (progress 1) the parts draw exactly the icon in components/icons.generated.ts;
 * scripts/test-tab-glyphs.js proves it pixel for pixel.
 *
 * A track maps the move's progress (0 to 1) to one property. Steps use doubled stops so the
 * value jumps instead of easing. Every track ends at rest: 0 for translateY and rotate, 1 for
 * opacity. translateY is in grid units (the component converts to px, 1 unit = 20/24 px).
 */

export type TabGlyphName = 'tab-transfers' | 'tab-search' | 'tab-feeds' | 'tab-settings' | 'tab-assistant' | 'tab-browse';

export interface GlyphTrack {
  prop: 'translateY' | 'rotate' | 'opacity';
  inputRange: number[];
  outputRange: number[];
  /** Ease the segments (rotate only). Everything else steps. */
  ease?: boolean;
}

export interface GlyphPart {
  id: string;
  d: string;
  track?: GlyphTrack;
}

export interface TabGlyphDef {
  move: 'hop' | 'draw' | 'spin' | 'wobble' | 'blink';
  parts: GlyphPart[];
  /** Applied to a wrapper around all parts (the gear's rotation). */
  wrapTrack?: GlyphTrack;
}

/** Whole move, ms. Under the 250 ms ceiling. */
export const GLYPH_MOVE_MS = 220;

/** Hop by `units` for the first half, then back and still. */
const hop = (units: number): GlyphTrack => ({
  prop: 'translateY',
  inputRange: [0, 0.0001, 0.5, 0.5001, 1],
  outputRange: [0, units, units, 0, 0],
});

/** Hidden until `at`, then visible. Rest is visible. */
const appearAt = (at: number): GlyphTrack => ({
  prop: 'opacity',
  inputRange: [0, at, at + 0.0001, 1],
  outputRange: [0, 0, 1, 1],
});

export const TAB_GLYPHS: Record<TabGlyphName, TabGlyphDef> = {
  'tab-transfers': {
    move: 'hop',
    parts: [
      { id: 'up', d: 'M6 4h2v16H6zM4 6h2v4H4zM2 8h2v2H2zM8 6h2v4H8zM10 8h2v2h-2z', track: hop(-2) },
      { id: 'down', d: 'M16 4h2v16h-2zM14 14h2v4h-2zM12 14h2v2h-2zM18 14h2v4h-2zM20 14h2v2h-2z', track: hop(2) },
    ],
  },
  'tab-search': {
    move: 'hop',
    parts: [
      {
        id: 'glass',
        d: 'M22 22h-2v-2h2v2Zm-2-2h-2v-2h2v2Zm-6-2H6v-2h8v2Zm4 0h-2v-2h2v2ZM6 16H4v-2h2v2Zm10 0h-2v-2h2v2ZM4 14H2V6h2v8Zm14 0h-2V6h2v8ZM6 6H4V4h2v2Zm10 0h-2V4h2v2Zm-2-2H6V2h8v2Z',
        track: hop(-2),
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
