import React from 'react';
import { useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../context/ThemeContext';

/** Pixel wordmark from assets/brand/maglev-wordmark.svg, filled with the current accent. */
const PATH =
  'M0 0h8v8h-8zM32 0h8v8h-8zM0 8h8v8h-8zM8 8h8v8h-8zM24 8h8v8h-8zM32 8h8v8h-8zM0 16h8v8h-8zM16 16h8v8h-8zM32 16h8v8h-8zM0 24h8v8h-8zM16 24h8v8h-8zM32 24h8v8h-8zM0 32h8v8h-8zM32 32h8v8h-8zM0 40h8v8h-8zM32 40h8v8h-8zM0 48h8v8h-8zM32 48h8v8h-8zM56 0h8v8h-8zM64 0h8v8h-8zM72 0h8v8h-8zM48 8h8v8h-8zM80 8h8v8h-8zM48 16h8v8h-8zM80 16h8v8h-8zM48 24h8v8h-8zM56 24h8v8h-8zM64 24h8v8h-8zM72 24h8v8h-8zM80 24h8v8h-8zM48 32h8v8h-8zM80 32h8v8h-8zM48 40h8v8h-8zM80 40h8v8h-8zM48 48h8v8h-8zM80 48h8v8h-8zM104 0h8v8h-8zM112 0h8v8h-8zM120 0h8v8h-8zM96 8h8v8h-8zM128 8h8v8h-8zM96 16h8v8h-8zM96 24h8v8h-8zM112 24h8v8h-8zM120 24h8v8h-8zM128 24h8v8h-8zM96 32h8v8h-8zM128 32h8v8h-8zM96 40h8v8h-8zM128 40h8v8h-8zM104 48h8v8h-8zM112 48h8v8h-8zM120 48h8v8h-8zM144 0h8v8h-8zM144 8h8v8h-8zM144 16h8v8h-8zM144 24h8v8h-8zM144 32h8v8h-8zM144 40h8v8h-8zM144 48h8v8h-8zM152 48h8v8h-8zM160 48h8v8h-8zM168 48h8v8h-8zM176 48h8v8h-8zM192 0h8v8h-8zM200 0h8v8h-8zM208 0h8v8h-8zM216 0h8v8h-8zM224 0h8v8h-8zM192 8h8v8h-8zM192 16h8v8h-8zM192 24h8v8h-8zM200 24h8v8h-8zM208 24h8v8h-8zM216 24h8v8h-8zM192 32h8v8h-8zM192 40h8v8h-8zM192 48h8v8h-8zM200 48h8v8h-8zM208 48h8v8h-8zM216 48h8v8h-8zM224 48h8v8h-8zM240 0h8v8h-8zM272 0h8v8h-8zM240 8h8v8h-8zM272 8h8v8h-8zM240 16h8v8h-8zM272 16h8v8h-8zM240 24h8v8h-8zM272 24h8v8h-8zM240 32h8v8h-8zM272 32h8v8h-8zM248 40h8v8h-8zM264 40h8v8h-8zM256 48h8v8h-8z';

const crisp = { shapeRendering: 'crispEdges' } as object;

export function Wordmark({ width }: { width?: number }) {
  const { colors } = useTheme();
  const { width: screenW } = useWindowDimensions();
  const w = width ?? Math.min(168, Math.round(screenW * 0.4));
  return (
    <Svg
      width={w}
      height={(w * 56) / 280}
      viewBox="0 0 280 56"
      accessible
      accessibilityRole="image"
      accessibilityLabel="Maglev"
      {...crisp}
    >
      <Path fill={colors.accent} d={PATH} {...crisp} />
    </Svg>
  );
}
