import React from 'react';
import { MaglevMark } from '../brand/MaglevMark';

export interface BrandMarkProps {
  /** Rendered height in dp; width follows the mark's ratio. */
  height?: number;
}

/** The onboarding hero: the Maglev mark, cruising. */
export function BrandMark({ height = 96 }: BrandMarkProps) {
  return <MaglevMark height={height} cruising />;
}
