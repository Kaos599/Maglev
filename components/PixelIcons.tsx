import React from 'react';
import Svg, { Rect } from 'react-native-svg';

interface IconProps {
  size?: number;
  color?: string;
}

// 1. 8-Bit Pixel Grid (ALL Filter)
export const PixelGridIcon: React.FC<IconProps> = ({ size = 14, color = '#CCFF00' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={0} y={0} width={3} height={3} fill={color} />
    <Rect x={5} y={0} width={3} height={3} fill={color} />
    <Rect x={0} y={5} width={3} height={3} fill={color} />
    <Rect x={5} y={5} width={3} height={3} fill={color} />
  </Svg>
);

// 2. 8-Bit Pixel Arrow Down (DOWNLOADING Filter)
export const PixelArrowDownIcon: React.FC<IconProps> = ({ size = 14, color = '#00E5FF' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={3} y={0} width={2} height={4} fill={color} />
    <Rect x={1} y={4} width={6} height={1} fill={color} />
    <Rect x={2} y={5} width={4} height={1} fill={color} />
    <Rect x={3} y={6} width={2} height={1} fill={color} />
  </Svg>
);

// 3. 8-Bit Pixel Arrow Up (SEEDING Filter)
export const PixelArrowUpIcon: React.FC<IconProps> = ({ size = 14, color = '#CCFF00' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={3} y={1} width={2} height={1} fill={color} />
    <Rect x={2} y={2} width={4} height={1} fill={color} />
    <Rect x={1} y={3} width={6} height={1} fill={color} />
    <Rect x={3} y={4} width={2} height={4} fill={color} />
  </Svg>
);

// 4. 8-Bit Pixel Pause Bars (PAUSED Filter / PAUSE Action)
export const PixelPauseBarsIcon: React.FC<IconProps> = ({ size = 14, color = '#8B949E' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={1} y={1} width={2} height={6} fill={color} />
    <Rect x={5} y={1} width={2} height={6} fill={color} />
  </Svg>
);

// 5. 8-Bit Pixel Play Triangle (START / RESUME Action)
export const PixelPlayTriangleIcon: React.FC<IconProps> = ({ size = 14, color = '#CCFF00' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={1} y={1} width={2} height={6} fill={color} />
    <Rect x={3} y={2} width={2} height={4} fill={color} />
    <Rect x={5} y={3} width={2} height={2} fill={color} />
  </Svg>
);

// 6. 8-Bit Pixel Stop Block (STOP Action)
export const PixelStopSquareIcon: React.FC<IconProps> = ({ size = 12, color = '#FF007F' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={1.5} y={1.5} width={5} height={5} fill={color} />
  </Svg>
);

// 7. 8-Bit Pixel Clock (ETA Badge)
export const PixelClockIcon: React.FC<IconProps> = ({ size = 10, color = '#00E5FF' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={2} y={0} width={4} height={1} fill={color} />
    <Rect x={1} y={1} width={6} height={6} fill={color} />
    <Rect x={2} y={2} width={4} height={4} fill="#0D1117" />
    <Rect x={3} y={3} width={1} height={2} fill={color} />
    <Rect x={4} y={4} width={2} height={1} fill={color} />
  </Svg>
);

// 8. 8-Bit Pixel Checkmark (DONE Badge)
export const PixelCheckDoneIcon: React.FC<IconProps> = ({ size = 10, color = '#CCFF00' }) => (
  <Svg width={size} height={size} viewBox="0 0 8 8">
    <Rect x={5} y={1} width={2} height={2} fill={color} />
    <Rect x={4} y={3} width={2} height={2} fill={color} />
    <Rect x={3} y={5} width={2} height={2} fill={color} />
    <Rect x={1} y={4} width={2} height={2} fill={color} />
  </Svg>
);

// 9. 8-Bit Pixel Search Icon (Header)
export const PixelSearchIcon: React.FC<IconProps> = ({ size = 16, color = '#D1D5DB' }) => (
  <Svg width={size} height={size} viewBox="0 0 10 10">
    <Rect x={2} y={0} width={4} height={1} fill={color} />
    <Rect x={1} y={1} width={6} height={1} fill={color} />
    <Rect x={0} y={2} width={2} height={4} fill={color} />
    <Rect x={6} y={2} width={2} height={4} fill={color} />
    <Rect x={1} y={6} width={6} height={1} fill={color} />
    <Rect x={2} y={7} width={4} height={1} fill={color} />
    <Rect x={6} y={6} width={2} height={2} fill={color} />
    <Rect x={8} y={8} width={2} height={2} fill={color} />
  </Svg>
);

// 10. 8-Bit Pixel Plus Icon (FAB)
export const PixelPlusFabIcon: React.FC<IconProps> = ({ size = 24, color = '#000000' }) => (
  <Svg width={size} height={size} viewBox="0 0 12 12">
    <Rect x={4.5} y={1.5} width={3} height={9} fill={color} />
    <Rect x={1.5} y={4.5} width={9} height={3} fill={color} />
  </Svg>
);

// 11. Bottom Nav: 8-Bit Pixel Transfers Icon
export const PixelNavTransfersIcon: React.FC<IconProps> = ({ size = 20, color = '#CCFF00' }) => (
  <Svg width={size} height={size} viewBox="0 0 10 10">
    <Rect x={2} y={0} width={2} height={1} fill={color} />
    <Rect x={1} y={1} width={4} height={1} fill={color} />
    <Rect x={0} y={2} width={6} height={1} fill={color} />
    <Rect x={2} y={3} width={2} height={4} fill={color} />
    <Rect x={6} y={3} width={2} height={4} fill={color} />
    <Rect x={4} y={7} width={6} height={1} fill={color} />
    <Rect x={5} y={8} width={4} height={1} fill={color} />
    <Rect x={6} y={9} width={2} height={1} fill={color} />
  </Svg>
);

// 12. Bottom Nav: 8-Bit Pixel Search Icon
export const PixelNavSearchIcon: React.FC<IconProps> = ({ size = 20, color = '#8B949E' }) => (
  <Svg width={size} height={size} viewBox="0 0 10 10">
    <Rect x={2} y={0} width={4} height={1} fill={color} />
    <Rect x={1} y={1} width={6} height={1} fill={color} />
    <Rect x={0} y={2} width={2} height={4} fill={color} />
    <Rect x={6} y={2} width={2} height={4} fill={color} />
    <Rect x={1} y={6} width={6} height={1} fill={color} />
    <Rect x={2} y={7} width={4} height={1} fill={color} />
    <Rect x={6} y={6} width={2} height={2} fill={color} />
    <Rect x={8} y={8} width={2} height={2} fill={color} />
  </Svg>
);

// 13. Bottom Nav: 8-Bit Pixel Feeds Icon
export const PixelNavFeedsIcon: React.FC<IconProps> = ({ size = 20, color = '#8B949E' }) => (
  <Svg width={size} height={size} viewBox="0 0 10 10">
    <Rect x={0} y={8} width={2} height={2} fill={color} />
    <Rect x={0} y={4} width={2} height={2} fill={color} />
    <Rect x={2} y={4} width={3} height={2} fill={color} />
    <Rect x={4} y={5} width={2} height={4} fill={color} />
    <Rect x={0} y={0} width={2} height={2} fill={color} />
    <Rect x={2} y={0} width={6} height={2} fill={color} />
    <Rect x={8} y={2} width={2} height={7} fill={color} />
  </Svg>
);

// 14. Bottom Nav: 8-Bit Pixel Config Icon
export const PixelNavConfigIcon: React.FC<IconProps> = ({ size = 20, color = '#8B949E' }) => (
  <Svg width={size} height={size} viewBox="0 0 10 10">
    <Rect x={1} y={0} width={2} height={10} fill={color} />
    <Rect x={7} y={0} width={2} height={10} fill={color} />
    <Rect x={0} y={2} width={4} height={2} fill="#070A0E" />
    <Rect x={0} y={2} width={4} height={2} fill={color} />
    <Rect x={6} y={6} width={4} height={2} fill="#070A0E" />
    <Rect x={6} y={6} width={4} height={2} fill={color} />
  </Svg>
);
