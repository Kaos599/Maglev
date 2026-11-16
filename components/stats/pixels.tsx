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

/** A picture at 1 unit = 1 dp, drawn crisp. */
export function PixelPic({ w, h, layers, labels, label }: { w: number; h: number; layers: Layer[]; labels?: PicLabel[]; label: string }) {
  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} accessible accessibilityRole="image" accessibilityLabel={label} {...crisp}>
      {layers.map((l, i) => (l.d ? <Path key={i} d={l.d} fill={l.fill} {...crisp} /> : null))}
      {labels?.map((t, i) => (
        <SvgText key={`t${i}`} x={t.x} y={t.y} textAnchor={t.anchor} fontSize={11} fontFamily={t.fontFamily} fill={t.fill}>
          {t.text}
        </SvgText>
      ))}
    </Svg>
  );
}
