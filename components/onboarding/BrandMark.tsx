import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';

export interface BrandMarkProps {
  /** Rendered height in dp; width follows the 152:200 artwork ratio. */
  height?: number;
}

/** The Maglev mark (assets/brand/maglev-mark.svg, from screens/1.css), filled with the current accent. */
export function BrandMark({ height = 96 }: BrandMarkProps) {
  const { colors } = useTheme();
  const width = (height * 152) / 200;
  return (
    <Svg width={width} height={height} viewBox="0 0 152 200" accessibilityLabel="Maglev">
      <Path d="M75.96 76.06L0.31 1.20L1.17 164.80L36.09 199.35L35.49 85.07L76.22 125.38L114.00 87.21L114.00 37.62Z" fill={colors.accent} />
      <Path d="M150.82 0.41L128.00 23.47L128.00 112.42L151.46 120.90Z" fill={colors.accent} />
    </Svg>
  );
}
