/**
 * The card kit's pixel pictures, at 1 unit = 1 dp in fixed boxes: half tiles 44 x 44, full cards 132 x 56, the dial 132 x 88.
 * Every value comes from the caller; with nothing to show they draw an empty outline, never sample data.
 */
import React from 'react';
import { type as typeTokens } from '../../constants/theme';
import { crateUnit, fmtCount } from '../../utils/stats/format';
import { frameD, PixelPic, rectD, type Layer } from './pixels';
import type { StatsInk } from './ink';

/** A train of wagons, one crate per `crateUnit` finished downloads. */
export function Crates({ finished, ink }: { finished: number; ink: StatsInk }) {
  const per = crateUnit(finished);
  const n = finished > 0 ? Math.ceil(finished / per) : 0;
  const cars = Math.max(1, Math.ceil(n / 6));
  let wagons = '';
  let crates = '';
  let slits = '';
  for (let k = 0; k < cars; k++) {
    const x = 102 - k * 33;
    wagons += rectD(x, 48, 30, 2) + rectD(x + 3, 50, 3, 3) + rectD(x + 24, 50, 3, 3);
  }
  for (let i = 0; i < n; i++) {
    const car = Math.floor(i / 6);
    const slot = i % 6;
    const cx = 102 - car * 33 + 1 + (2 - (slot % 3)) * 10;
    const cy = slot < 3 ? 39 : 30;
    crates += rectD(cx, cy, 8, 8);
    slits += rectD(cx + 1, cy + 3, 6, 1);
  }
  const layers: Layer[] = [
    { d: rectD(0, 55, 132, 1), fill: ink.line },
    { d: wagons, fill: ink.lineStrong },
    { d: crates, fill: ink.data },
    { d: slits, fill: ink.winOff },
  ];
  return <PixelPic w={132} h={56} layers={layers} label={`${fmtCount(finished)} finished, one crate per ${per === 1 ? 'download' : `${per} downloads`}`} />;
}

/** Sand in the bottom bulb: this range's time against the most in one range. */
export function Hourglass({ fraction, ink }: { fraction: number; ink: StatsInk }) {
  const rows = fraction > 0 ? Math.max(3, Math.round(Math.min(1, fraction) * 18)) : 0;
  let glass = rectD(9, 0, 26, 2) + rectD(9, 42, 26, 2);
  let sand = '';
  for (let y = 2; y < 42; y++) {
    const d = Math.abs(y - 21.5);
    const w = 2 * Math.round(2 + (8 * d) / 19.5);
    const x0 = 22 - w / 2;
    glass += rectD(x0 - 1, y, 1, 1) + rectD(x0 + w, y, 1, 1);
    if (y >= 22 && 41 - y < rows) sand += rectD(x0, y, w, 1);
  }
  return <PixelPic w={44} h={44} layers={[{ d: glass, fill: ink.lineStrong }, { d: sand, fill: ink.data }]} label="Time against your busiest period" />;
}

/** Nine dial blocks and a stepped pixel needle. `v` and `max` in the same unit. */
export function Speedo({ v, max, ink }: { v: number; max: number; ink: StatsInk }) {
  const cx = 22;
  const cy = 40;
  const f = max > 0 ? Math.min(1, v / max) : 0;
  let lit = '';
  let dim = '';
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI * (1 - i / 8);
    const d = rectD(Math.round(cx + 18 * Math.cos(a) - 2), Math.round(cy - 18 * Math.sin(a) - 2), 4, 4);
    if (v > 0 && i / 8 <= f + 1e-6) lit += d;
    else dim += d;
  }
  // The needle points left at 0 and right at max, drawn as 2 x 2 steps so it stays pixel art.
  const ang = Math.PI * (1 - (v > 0 ? f : 0));
  let needle = rectD(cx - 2, cy - 2, 4, 4);
  for (let k = 2; k <= 13; k += 1.5) needle += rectD(Math.round(cx + k * Math.cos(ang) - 1), Math.round(cy - k * Math.sin(ang) - 1), 2, 2);
  return (
    <PixelPic
      w={44}
      h={44}
      layers={[{ d: dim, fill: ink.lineStrong }, { d: lit, fill: ink.data }, { d: needle, fill: v > 0 ? ink.text : ink.lineStrong }]}
      label="Speedometer"
    />
  );
}

/** Street lamps for the last days of the range: lit when something finished, today in the accent. */
export function Lamps({ days, today, ink }: { days: { day: number; finished: number }[]; today: number; ink: StatsInk }) {
  const shown = days.slice(-11);
  const L = shown.length;
  let lit = '';
  let litToday = '';
  let off = '';
  let poles = '';
  shown.forEach((d, j) => {
    const x = 132 - (L - j) * 12 + 2;
    const head = rectD(x + 1, 34, 6, 8) + rectD(x, 35, 8, 6);
    if (d.finished > 0) {
      if (d.day === today) litToday += head;
      else lit += head;
    } else off += frameD(x, 34, 8, 8);
    poles += rectD(x + 3, 42, 2, 12) + rectD(x + 1, 54, 6, 2);
  });
  return (
    <PixelPic
      w={132}
      h={56}
      layers={[{ d: poles + off, fill: ink.lineStrong }, { d: lit, fill: ink.data }, { d: litToday, fill: ink.hi }]}
      label={`The last ${L} days: lit when something finished`}
    />
  );
}

/** Mobile data against the monthly limit. */
export function Battery({ used, limit, ink }: { used: number; limit: number; ink: StatsInk }) {
  const over = used > limit;
  const n = over ? 5 : Math.min(5, Math.round((5 * used) / limit));
  let cells = '';
  for (let i = 0; i < n; i++) cells += rectD(4 + i * 6, 16, 5, 14);
  const fill = over ? ink.danger : ink.data;
  return (
    <PixelPic
      w={44}
      h={44}
      layers={[
        { d: frameD(0, 12, 38, 22) + frameD(1, 13, 36, 20), fill: ink.lineStrong },
        { d: rectD(38, 18, 4, 10), fill: over ? ink.danger : ink.lineStrong },
        { d: cells, fill },
      ]}
      label="Mobile data against your monthly limit"
    />
  );
}

/** A phone, when there is no limit to measure against. */
export function Phone({ ink }: { ink: StatsInk }) {
  return (
    <PixelPic
      w={44}
      h={44}
      layers={[{ d: rectD(15, 13, 14, 25), fill: ink.raised }, { d: frameD(12, 10, 20, 34) + rectD(19, 40, 6, 1), fill: ink.lineStrong }]}
      label="Mobile"
    />
  );
}

/** Downloaded against uploaded, as two bars with arrows. */
export function UpDown({ down, up, ink }: { down: number; up: number; ink: StatsInk }) {
  const hd = down > 0 ? 34 : 0;
  const hu = down > 0 ? Math.max(up > 0 ? 2 : 0, Math.round(34 * Math.min(1, up / down))) : 0;
  const arrow = (x: number, y: number, dir: 1 | -1) => {
    let s = '';
    for (let k = 0; k < 4; k++) s += rectD(x + k, y + dir * k, 9 - 2 * k, 1);
    return s;
  };
  return (
    <PixelPic
      w={44}
      h={44}
      layers={[
        { d: rectD(0, 43, 44, 1), fill: ink.line },
        { d: rectD(9, 43 - hd, 9, hd) + arrow(9, 4, 1), fill: down > 0 ? ink.data : ink.lineStrong },
        { d: rectD(28, 43 - hu, 9, hu) + arrow(28, 43 - hu - 2, -1), fill: up > 0 ? ink.text : ink.lineStrong },
      ]}
      label="Downloaded against uploaded"
    />
  );
}

/** Finishes by hour on a half dial, the usual hour in the accent. */
export function HourDial({ hours, peak, ink }: { hours: number[] | null; peak: number | null; ink: StatsInk }) {
  const cx = 66;
  const cy = 70;
  const mx = hours ? Math.max(1, ...hours) : 1;
  let empty = '';
  const heat = ['', '', ''];
  let hi = '';
  for (let h = 0; h < 24; h++) {
    const a = Math.PI * (1 - (h + 0.5) / 24);
    const x = Math.round(cx + 52 * Math.cos(a) - 3);
    const y = Math.round(cy - 52 * Math.sin(a) - 3);
    const f = hours ? hours[h] / mx : 0;
    if (!hours || f < 0.05) empty += frameD(x, y, 6, 6);
    else if (h === peak) hi += rectD(x, y, 6, 6);
    else heat[f < 0.45 ? 0 : f < 0.8 ? 1 : 2] += rectD(x, y, 6, 6);
  }
  const font = typeTokens.body.fontFamily;
  return (
    <PixelPic
      w={132}
      h={88}
      layers={[
        { d: empty, fill: ink.lineStrong },
        { d: heat[0], fill: ink.heat[0] },
        { d: heat[1], fill: ink.heat[1] },
        { d: heat[2], fill: ink.heat[2] },
        { d: hi, fill: ink.hi },
      ]}
      labels={[
        { x: cx, y: 10, text: '12', anchor: 'middle', fill: ink.muted, fontFamily: font },
        { x: 0, y: 87, text: '00', anchor: 'start', fill: ink.muted, fontFamily: font },
        { x: 132, y: 87, text: '23', anchor: 'end', fill: ink.muted, fontFamily: font },
      ]}
      label="Finishes by hour of the day"
    />
  );
}
