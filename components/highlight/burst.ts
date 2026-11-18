/** One pixel of the burst, before it is placed. Whole mark units (u), so the layout is the same on every run. */
export interface Particle {
  /** Where it ends sideways, up and out (u). Negative is up. */
  x: number;
  y: number;
  /** How far it falls back after the top of its arc (u). */
  fall: number;
  /** Side, in u. */
  size: number;
  /** Which wave it leaves in (0 to 3), 15 ms apart. */
  wave: number;
  /** 0 takes the first colour (lime), 1 the second (cyan). */
  tint: 0 | 1;
}

/** Deterministic pseudo-random number in [0, 1) for pixel `i`, channel `k`. */
function hash(i: number, k: number): number {
  const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * `count` square pixels on an upward fan (about 198 to 342 degrees, screen-y down). Sizes come from `sizes`
 * (2, 3 or 4 train pixels), waves cycle 0 to 3, every third pixel is cyan. Positions are whole units.
 */
export function burstLayout(count: number, sizes: readonly number[], waves: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const ang = Math.PI * (1.1 + (i / (count - 1)) * 0.8) + (hash(i, 1) - 0.5) * 0.18;
    const dist = 12 + Math.round(hash(i, 2) * 12);
    out.push({
      x: Math.round(Math.cos(ang) * dist * 1.25),
      y: Math.round(Math.sin(ang) * dist),
      fall: 10 + Math.round(hash(i, 3) * 8),
      size: sizes[i % sizes.length],
      wave: i % waves,
      tint: i % 3 === 2 ? 1 : 0,
    });
  }
  return out;
}

/** The badge's two segments for a highlight key: the lime word and the version cut into the card. */
export function badgeParts(version: string): { label: string; version: string } {
  return { label: 'NEW', version };
}
