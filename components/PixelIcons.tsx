import React from 'react';
import { PixelGlyph, PixelIconName } from './PixelIcon';

/**
 * Legacy named icons, kept so existing imports keep working. Each is a thin
 * wrapper over the unified 12x12 glyph set in PixelIcon. Prefer
 * <PixelIcon name=... size={16|20|24} /> in new code.
 */
interface IconProps {
  size?: number;
  color?: string | any;
}

const make = (name: PixelIconName, defSize: number, defColor: string): React.FC<IconProps> =>
  function LegacyPixelIcon({ size = defSize, color = defColor }) {
    return <PixelGlyph name={name} size={size} color={color} />;
  };

export const PixelGridIcon = make('grid', 14, '#CCFF00');
export const PixelArrowDownIcon = make('download', 14, '#00E5FF');
export const PixelArrowUpIcon = make('upload', 14, '#CCFF00');
export const PixelPauseBarsIcon = make('pause', 14, '#8B949E');
export const PixelPlayTriangleIcon = make('play', 14, '#CCFF00');
export const PixelStopSquareIcon = make('stop', 12, '#FF007F');
export const PixelClockIcon = make('clock', 10, '#00E5FF');
export const PixelCheckDoneIcon = make('check', 10, '#CCFF00');
export const PixelSearchIcon = make('search', 16, '#D1D5DB');
export const PixelPlusFabIcon = make('plus', 24, '#000000');
export const PixelNavTransfersIcon = make('transfers', 20, '#CCFF00');
export const PixelNavSearchIcon = make('search', 20, '#8B949E');
export const PixelNavFeedsIcon = make('feeds', 20, '#8B949E');
export const PixelNavConfigIcon = make('settings', 20, '#8B949E');
