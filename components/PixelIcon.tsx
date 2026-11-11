import React, { memo } from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { ICON_PATHS, ICON_VIEWBOX } from './icons.generated';

export type PixelIconName = keyof typeof ICON_PATHS;
export const ICON_NAMES = Object.keys(ICON_PATHS) as PixelIconName[];

/** Allowed icon sizes (px). 24 is crisp 1:1 and the default; 48 is 2x. 16/20 only for inline stats. */
export type PixelIconSize = 16 | 20 | 24 | 48;

export interface PixelIconProps {
  name: PixelIconName;
  size?: PixelIconSize;
  color?: string;
  accessibilityLabel?: string;
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
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      {...(accessibilityLabel ? { accessible: true, accessibilityRole: 'image' as const, accessibilityLabel } : null)}
      {...crisp}
    >
      <Path d={ICON_PATHS[name]} fill={fill} {...crisp} />
    </Svg>
  );
});

/** The one icon family for Maglev: pixelarticons, 24x24 grid, filled paths. */
export function PixelIcon({ name, size = 24, color, accessibilityLabel }: PixelIconProps) {
  return <PixelGlyph name={name} size={size} color={color} accessibilityLabel={accessibilityLabel} />;
}

export default PixelIcon;
