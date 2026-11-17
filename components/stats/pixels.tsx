import React from 'react';
import Svg, { Path, Text as SvgText } from 'react-native-svg';

/** A w x h rectangle as path data. Pixel art is built from these, one Path per colour. */
export const rectD = (x: number, y: number, w: number, h: number): string => (w > 0 && h > 0 ? `M${x} ${y}h${w}v${h}h${-w}z` : '');

/** A one-unit outline of a w x h box. */
export const frameD = (x: number, y: number, w: number, h: number): string =>
  rectD(x, y, w, 1) + rectD(x, y + h - 1, w, 1) + rectD(x, y + 1, 1, h - 2) + rectD(x + w - 1, y + 1, 1, h - 2);

/** 8 x 8 sprites. X is the body, * a star. */
export const SPRITES = {
  moon: ['..XXX...', '.XX...*.', 'XX......', 'XX...*..', 'XX......', 'XX......', '.XX.....', '..XXX...'],
  sun: ['...XX...', '.X....X.', '..XXXX..', 'X.XXXX.X', 'X.XXXX.X', '..XXXX..', '.X....X.', '...XX...'],
} as const;

/** A sprite grid as path data at integer scale `s`. */
export function spriteD(rows: readonly string[], x: number, y: number, s = 1): { main: string; star: string } {
  let main = '';
  let star = '';
  rows.forEach((row, j) => {
    for (let i = 0; i < row.length; i++) {
      if (row[i] === 'X') main += rectD(x + i * s, y + j * s, s, s);
      else if (row[i] === '*') star += rectD(x + i * s, y + j * s, s, s);
    }
  });
  return { main, star };
}

export interface Layer {
  d: string;
  fill: string;
}

export interface PicLabel {
  x: number;
  y: number;
  text: string;
  anchor: 'start' | 'middle' | 'end';
  fill: string;
  fontFamily: string;
}

const crisp = { shapeRendering: 'crispEdges' } as object;

/** A picture drawn crisp. `scale` is dp per unit (default 1). */
export function PixelPic({ w, h, layers, labels, label, scale = 1 }: { w: number; h: number; layers: Layer[]; labels?: PicLabel[]; label: string; scale?: number }) {
  return (
    <Svg width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} accessible accessibilityRole="image" accessibilityLabel={label} {...crisp}>
      {layers.map((l, i) => (l.d ? <Path key={i} d={l.d} fill={l.fill} {...crisp} /> : null))}
      {labels?.map((t, i) => (
        <SvgText key={`t${i}`} x={t.x} y={t.y} textAnchor={t.anchor} fontSize={11} fontFamily={t.fontFamily} fill={t.fill}>
          {t.text}
        </SvgText>
      ))}
    </Svg>
  );
}

/** Which colour an art pixel takes: `s` structure (muted), `a` the accent. */
export type Key = 's' | 'a';

/** A square pixel-art grid. Build with p/h/v/line/ring/frame, then `layers(structure, accent)` gives one path per colour. */
export class Pix {
  private cells = new Map<string, Key>();
  constructor(readonly n: number) {}
  p(x: number, y: number, k: Key): this {
    if (x >= 0 && y >= 0 && x < this.n && y < this.n) this.cells.set(`${x},${y}`, k);
    return this;
  }
  h(x0: number, x1: number, y: number, k: Key): this {
    for (let x = x0; x <= x1; x++) this.p(x, y, k);
    return this;
  }
  v(x: number, y0: number, y1: number, k: Key): this {
    for (let y = y0; y <= y1; y++) this.p(x, y, k);
    return this;
  }
  frame(x: number, y: number, w: number, hh: number, k: Key): this {
    return this.h(x, x + w - 1, y, k).h(x, x + w - 1, y + hh - 1, k).v(x, y, y + hh - 1, k).v(x + w - 1, y, y + hh - 1, k);
  }
  fill(x: number, y: number, w: number, hh: number, k: Key): this {
    for (let j = 0; j < hh; j++) this.h(x, x + w - 1, y + j, k);
    return this;
  }
  /** A one-pixel line (Bresenham). */
  line(x0: number, y0: number, x1: number, y1: number, k: Key): this {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.p(x, y, k);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
    return this;
  }
  /** A one-pixel circle outline; `pick` may choose the colour per pixel. */
  ring(cx: number, cy: number, r: number, pick: (x: number, y: number) => Key): this {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r + 0.35 && d > r - 0.85) this.p(x, y, pick(x, y));
      }
    }
    return this;
  }
  layers(structure: string, accent: string): Layer[] {
    let s = '';
    let a = '';
    this.cells.forEach((k, key) => {
      const [x, y] = key.split(',').map(Number);
      if (k === 'a') a += rectD(x, y, 1, 1);
      else s += rectD(x, y, 1, 1);
    });
    return [{ d: s, fill: structure }, { d: a, fill: accent }];
  }
}
