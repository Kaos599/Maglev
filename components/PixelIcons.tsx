import React from 'react';
import { useTheme } from '../context/ThemeContext';
import type { ThemeColors } from '../constants/theme';
import { PixelGlyph, PixelIconName } from './PixelIcon';

/**
 * Legacy named icons, kept so existing imports keep working. Each is a thin
 * wrapper over the Pixelarticons set in PixelIcon. Prefer
 * <PixelIcon name=... size={16|20|24} /> in new code.
 */
interface IconProps {
  size?: number;
  color?: string | any;
}

const make = (name: PixelIconName, defSize: number, role: keyof ThemeColors): React.FC<IconProps> =>
  function LegacyPixelIcon({ size = defSize, color }) {
    const { colors } = useTheme();
    return <PixelGlyph name={name} size={size} color={color ?? colors[role]} />;
  };

export const PixelGridIcon = make('grid', 14, 'accentText');
export const PixelArrowDownIcon = make('download', 14, 'download');
export const PixelArrowUpIcon = make('upload', 14, 'accentText');
export const PixelPauseBarsIcon = make('pause', 14, 'textMuted');
export const PixelPlayTriangleIcon = make('play', 14, 'accentText');
export const PixelStopSquareIcon = make('stop', 12, 'danger');
export const PixelClockIcon = make('clock', 10, 'download');
export const PixelCheckDoneIcon = make('check', 10, 'accentText');
export const PixelSearchIcon = make('search', 16, 'text');
export const PixelPlusFabIcon = make('plus', 24, 'onAccent');
export const PixelNavTransfersIcon = make('transfers', 20, 'accentText');
export const PixelNavSearchIcon = make('search', 20, 'textMuted');
export const PixelNavFeedsIcon = make('feeds', 20, 'textMuted');
export const PixelNavConfigIcon = make('settings', 20, 'textMuted');
