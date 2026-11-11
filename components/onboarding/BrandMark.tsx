import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';

export interface BrandMarkProps {
  /** Rendered height in dp; width follows the 200:261 artwork ratio. */
  height?: number;
}

/** The Maglev mark (assets/brand/maglev-mark.svg), filled with the current accent. */
export function BrandMark({ height = 96 }: BrandMarkProps) {
  const { colors } = useTheme();
  const width = (height * 200) / 261;
  return (
    <Svg width={width} height={height} viewBox="0 0 200 261" accessibilityLabel="Maglev">
      <Path d="M0 0H52V205L0 261Z" fill={colors.accent} />
      <Path d="M60 0L100 92L140 0V72L100 175L60 72Z" fill={colors.accent} />
      <Path d="M148 0H200V180H148Z" fill={colors.accent} />
    </Svg>
  );
}
