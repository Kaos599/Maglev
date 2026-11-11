import React, { memo } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { GLYPHS, GLYPH_GRID, PixelIconName } from './pixelGlyphs';

export { GLYPHS } from './pixelGlyphs';
export type { PixelIconName } from './pixelGlyphs';

/** Allowed icon sizes (px). Anything else is a design-law violation. */
export type PixelIconSize = 16 | 20 | 24;

export interface PixelIconProps {
  name: PixelIconName;
  size?: PixelIconSize;
  color?: string;
  accessibilityLabel?: string;
}

/**
 * Parse a 12x12 string bitmap into one SVG path made of merged horizontal
 * runs ("M x y h w v1 h-w z" per run). One <Path> node per icon, no
 * anti-aliased seams between neighbouring cells.
 */
function bitmapToPath(rows: readonly string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== '#') {
        x += 1;
        continue;
      }
      let end = x;
      while (end < row.length && row[end] === '#') end += 1;
      d += `M${x} ${y}h${end - x}v1h${x - end}z`;
      x = end;
    }
  });
  return d;
}

// Parsed once per glyph, lazily, then cached.
const pathCache: Partial<Record<PixelIconName, string>> = {};
function pathFor(name: PixelIconName): string {
  let d = pathCache[name];
  if (d === undefined) {
    d = bitmapToPath(GLYPHS[name]);
    pathCache[name] = d;
  }
  return d;
}

const crisp = { shapeRendering: 'crispEdges' } as object;

/**
 * Unrestricted-size renderer. Only used by the legacy PixelIcons wrappers that
 * must keep their historical pixel sizes; new code uses <PixelIcon/>.
 */
export const PixelGlyph = memo(function PixelGlyph({
  name,
  size,
  color,
  accessibilityLabel,
}: {
  name: PixelIconName;
  size: number;
  color?: string;
  accessibilityLabel?: string;
}) {
  const { colors } = useTheme();
  const fill = color ?? colors.accentText;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_GRID} ${GLYPH_GRID}`}
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
      {...crisp}
    >
      <Path d={pathFor(name)} fill={fill} {...crisp} />
    </Svg>
  );
});

/**
 * The one icon family for Maglev. 12x12 pixel grid, filled cells only,
 * 1-cell strokes (2 for bold accents). Sizes: 16 | 20 | 24 (default 20).
 */
export function PixelIcon({ name, size = 20, color, accessibilityLabel }: PixelIconProps) {
  return <PixelGlyph name={name} size={size} color={color} accessibilityLabel={accessibilityLabel} />;
}

export default PixelIcon;
