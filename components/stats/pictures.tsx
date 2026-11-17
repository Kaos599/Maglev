/**
 * The card kit's pixel pictures. One rule for all of them: a 20 x 20 art grid at 2 dp a pixel, so every picture sits in the same
 * 40 dp box (bottom-right of its card), strokes one art pixel, structure muted at 60% plus one accent colour for the part that
 * means something (lime for done and finish, cyan for time and speed). No text inside pictures. With nothing to show they draw an
 * empty outline, never sample data.
 */
import React from 'react';
import { crateUnit, fmtCount } from '../../utils/stats/format';
import { handTip, isPm } from './clockMath';
import { Pix, PixelPic } from './pixels';
import type { StatsInk } from './ink';
import type { FireStage } from '../../utils/stats/delight';

const N = 20;
const SCALE = 2;
const pic = (p: Pix, structure: string, accent: string, label: string) => <PixelPic w={N} h={N} scale={SCALE} layers={p.layers(structure, accent)} label={label} />;

/** How many crates the Finished picture shows at most. */
export const CRATE_CAP = 6;

/** A wagon of crates, one crate per `crateUnit` finished downloads (never more than six). */
export function Crates({ finished, ink }: { finished: number; ink: StatsInk }) {
  const per = crateUnit(finished, CRATE_CAP);
  const n = finished > 0 ? Math.min(CRATE_CAP, Math.ceil(finished / per)) : 0;
  const P = new Pix(N);
  P.h(0, 19, 16, 's').fill(3, 17, 3, 2, 's').fill(14, 17, 3, 2, 's').p(19, 15, 's');
  for (let i = 0; i < n; i++) {
    const x = 1 + (i % 3) * 6;
    const y = i < 3 ? 11 : 5;
    P.frame(x, y, 5, 5, 'a').h(x + 1, x + 3, y + 2, 'a');
  }
  return pic(P, ink.pic, ink.hi, `${fmtCount(finished)} finished, one crate per ${per === 1 ? 'download' : `${per} downloads`}`);
}

/** Sand in the bottom bulb: this range's time against the most in one range. */
export function Hourglass({ fraction, ink }: { fraction: number; ink: StatsInk }) {
  const o = 2;
  const sides: Record<number, number> = { 3: 2, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 6, 10: 5, 11: 4, 12: 3, 13: 2, 14: 2 };
  const P = new Pix(N);
  P.h(o + 1, o + 14, o + 2, 's').h(o + 1, o + 14, o + 15, 's');
  Object.keys(sides).forEach((ys) => {
    const y = Number(ys);
    P.p(o + sides[y], o + y, 's').p(o + 15 - sides[y], o + y, 's');
  });
  const bottom = [14, 13, 12, 11, 10];
  const top = [7, 6, 5, 4, 3];
  const f = Math.max(0, Math.min(1, fraction));
  const k = f > 0 ? Math.max(1, Math.min(5, Math.round(f * 5))) : 0;
  for (let i = 0; i < k; i++) P.h(o + sides[bottom[i]] + 1, o + 14 - sides[bottom[i]], o + bottom[i], 'a');
  for (let j = 0; j < 5 - k && f > 0; j++) P.h(o + sides[top[j]] + 1, o + 14 - sides[top[j]], o + top[j], 'a');
  if (f > 0 && f < 1) P.v(o + 7, o + 8, o + bottom[k - 1] - 1, 'a');
  return pic(P, ink.pic, ink.data, 'Time against your busiest period');
}

/** A compact gauge: a one-pixel arc lit up to the value, and a needle. `v` and `max` in the same unit. */
export function Speedo({ v, max, ink }: { v: number; max: number; ink: StatsInk }) {
  const cx = 10;
  const cy = 16;
  const f = max > 0 && v > 0 ? Math.min(1, v / max) : 0;
  const P = new Pix(N);
  for (let y = cy - 7; y <= cy; y++) {
    for (let x = cx - 7; x <= cx + 7; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > 7.35 || d <= 6.15) continue;
      const t = 1 - Math.atan2(cy - y, x - cx) / Math.PI;
      P.p(x, y, f > 0 && t <= f + 0.02 ? 'a' : 's');
    }
  }
  P.h(3, 17, 17, 's');
  const ang = Math.PI * (1 - f);
  P.line(cx, cy, Math.round(cx + 5 * Math.cos(ang)), Math.round(cy - 5 * Math.sin(ang)), f > 0 ? 'a' : 's');
  return pic(P, ink.pic, ink.data, 'Speedometer');
}

/** A 12-hour face with one lime hand, and a tiny moon (pm) or sun (am) in the corner. `hour` null: not enough data, no accent. */
export function Clock({ hour, ink }: { hour: number | null; ink: StatsInk }) {
  const cx = 9;
  const cy = 11;
  const P = new Pix(N);
  P.ring(cx, cy, 6, () => 's');
  if (hour != null) {
    const tip = handTip(hour, 4);
    P.line(cx, cy, cx + tip.dx, cy + tip.dy, 'a');
    if (isPm(hour)) P.p(16, 2, 's').p(15, 3, 's').p(16, 4, 's');
    else P.p(16, 2, 's').p(15, 3, 's').p(17, 3, 's').p(16, 4, 's');
  } else P.p(cx, cy, 's');
  return pic(P, ink.pic, ink.hi, hour == null ? 'Not enough downloads yet' : `Usually around ${hour}:00`);
}

const FIRE_SHAPES: Record<1 | 2, string[]> = {
  1: ['', '', '', '', '', '', '.......X', '.......XX', '......XXX', '......XXXX', '.....XXXXX', '.....XXXXXX', '.....XXXXXX', '.....XXXXXX'],
  2: ['', '', '.......X', '.......X....X', '......XX...XX', '...X..XXX..XX', '...X..XXX.XXX', '...XX.XXXXXXX', '..XXX.XXXXXXX', '..XXXXXXXXXXXX', '..XXXXXXXXXXXX', '..XXXXXXXXXXXX', '...XXXXXXXXXX', '....XXXXXXXX'],
};
const FIRE_CORE: Record<1 | 2, [number, number][]> = {
  1: [[7, 10], [7, 11], [8, 11], [7, 12], [8, 12]],
  2: [[7, 8], [7, 9], [8, 9], [6, 10], [7, 10], [8, 10], [9, 10], [6, 11], [7, 11], [8, 11], [9, 11]],
};

/** Pixel fire on muted logs: an ember, a flame, a full fire. A broken streak is just the ember again. */
export function Fire({ stage, ink }: { stage: FireStage; ink: StatsInk }) {
  const o = 2;
  const P = new Pix(N);
  P.h(o + 2, o + 13, o + 14, 's').h(o + 1, o + 3, o + 15, 's').h(o + 12, o + 14, o + 15, 's').p(o + 5, o + 13, 's').p(o + 10, o + 13, 's');
  if (stage === 0) {
    // An ember: three pixels on the logs.
    P.p(o + 7, o + 12, 'a').p(o + 8, o + 12, 'a').p(o + 8, o + 11, 'a');
  } else {
    const rows = FIRE_SHAPES[stage];
    const on = (x: number, y: number) => y >= 0 && y < rows.length && rows[y].charAt(x) === 'X';
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < 16; x++) {
        if (!on(x, y)) continue;
        if (!on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1)) P.p(o + x, o + y, 'a');
      }
    }
    for (const [x, y] of FIRE_CORE[stage]) P.p(o + x, o + y, 'a');
  }
  return pic(P, ink.pic, ink.hi, ['An ember: no streak right now', 'A flame: a streak has started', 'A full fire: a week or more in a row'][stage]);
}

/** Mobile data against the monthly limit: a battery. */
export function Battery({ used, limit, ink }: { used: number; limit: number; ink: StatsInk }) {
  const over = used > limit;
  const n = over ? 5 : Math.min(5, Math.round((5 * used) / limit));
  const P = new Pix(N);
  P.frame(1, 5, 16, 10, 's').fill(17, 8, 2, 4, 's');
  for (let i = 0; i < n; i++) P.fill(3 + i * 3, 7, 2, 6, 'a');
  return pic(P, ink.pic, over ? ink.danger : ink.data, 'Mobile data against your monthly limit');
}

/** A phone, when there is no limit to measure against. */
export function Phone({ ink }: { ink: StatsInk }) {
  const P = new Pix(N);
  P.frame(5, 1, 10, 18, 's').h(8, 11, 16, 'a');
  return pic(P, ink.pic, ink.data, 'Mobile');
}

/** Downloaded against uploaded: two bars under two arrows. */
export function UpDown({ down, up, ink }: { down: number; up: number; ink: StatsInk }) {
  const hd = down > 0 ? 12 : 0;
  const hu = down > 0 ? Math.max(up > 0 ? 1 : 0, Math.round(12 * Math.min(1, up / down))) : 0;
  const P = new Pix(N);
  P.h(1, 18, 18, 's');
  // Down arrow over the left bar, up arrow over the right.
  P.h(3, 9, 1, 'a').h(4, 8, 2, 'a').h(5, 7, 3, 'a').p(6, 4, 'a');
  P.p(13, 1, 's').h(12, 14, 2, 's').h(11, 15, 3, 's').p(13, 4, 's');
  if (hd) P.fill(4, 18 - hd, 5, hd, 'a');
  if (hu) P.fill(11, 18 - hu, 5, hu, 's');
  return pic(P, ink.pic, ink.data, 'Downloaded against uploaded');
}
