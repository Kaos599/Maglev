#!/usr/bin/env node
// Tab glyph parts: each tab icon is split into named parts for its signature move. At rest the parts
// must draw exactly the original icon, and every stepped track must end at its rest value.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// Axis-aligned paths only: M m H h V v L-free, Z z. Returns a list of closed polygons (absolute points).
function parsePolys(d) {
  const toks = d.match(/[MmHhVvZz]|-?\d*\.?\d+/g);
  const polys = [];
  let pts = null;
  let x = 0, y = 0, sx = 0, sy = 0, i = 0, cmd = '';
  const num = () => parseFloat(toks[i++]);
  const isCmd = (t) => /[A-Za-z]/.test(t);
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++];
    switch (cmd) {
      case 'M': case 'm': {
        const nx = num(), ny = num();
        if (pts && pts.length) polys.push(pts);
        x = cmd === 'M' ? nx : x + nx;
        y = cmd === 'M' ? ny : y + ny;
        sx = x; sy = y;
        pts = [[x, y]];
        cmd = cmd === 'M' ? 'L' : 'l'; // implicit lineto never used here
        break;
      }
      case 'H': x = num(); pts.push([x, y]); break;
      case 'h': x += num(); pts.push([x, y]); break;
      case 'V': y = num(); pts.push([x, y]); break;
      case 'v': y += num(); pts.push([x, y]); break;
      case 'Z': case 'z':
        polys.push(pts);
        x = sx; y = sy;
        pts = [[x, y]];
        break;
      default: throw new Error('unsupported command ' + cmd + ' in ' + d);
    }
  }
  return polys.filter((p) => p.length > 1);
}

// Nonzero fill sampled at pixel centres; vertical edges only matter for a ray cast to the right.
function raster(d) {
  const polys = parsePolys(d);
  const grid = [];
  for (let py = 0; py < 24; py++) {
    const row = [];
    for (let px = 0; px < 24; px++) {
      const cx = px + 0.5, cy = py + 0.5;
      let wind = 0;
      for (const p of polys) {
        for (let k = 0; k < p.length; k++) {
          const [x1, y1] = p[k];
          const [x2, y2] = p[(k + 1) % p.length];
          if (x1 !== x2 || x1 <= cx) continue;
          const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
          if (cy > lo && cy < hi) wind += y2 > y1 ? 1 : -1;
        }
      }
      row.push(wind !== 0 ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

const same = (a, b) => a.every((row, y) => row.every((v, x) => v === b[y][x]));
const count = (g) => g.flat().reduce((s, v) => s + v, 0);

async function main() {
  const { ICON_PATHS } = await import('../components/icons.generated.ts');
  const G = await import('../components/tabs/tabGlyphs.ts');
  const names = ['tab-transfers', 'tab-search', 'tab-feeds', 'tab-settings', 'tab-assistant'];

  check('glyphs: exactly the five tab icons', JSON.stringify(Object.keys(G.TAB_GLYPHS).sort()) === JSON.stringify([...names].sort()));

  for (const name of names) {
    const glyph = G.TAB_GLYPHS[name];
    const want = raster(ICON_PATHS[name]);
    const got = raster(glyph.parts.map((p) => p.d).join(''));
    check(`${name}: parts rasterize to the original icon`, same(want, got), `want ${count(want)} px, got ${count(got)} px`);
    check(`${name}: has named parts`, glyph.parts.length > 0 && glyph.parts.every((p) => p.id && p.d));
    const ids = glyph.parts.map((p) => p.id);
    check(`${name}: part ids are unique`, new Set(ids).size === ids.length);
  }

  // Gear: invisible reset needs 4-fold symmetry about (12,12). 90 deg clockwise: (x,y) -> (23-y, x).
  const gear = raster(ICON_PATHS['tab-settings']);
  const rot = gear.map((row, y) => row.map((_, x) => gear[23 - x][y]));
  const symmetric = same(gear, rot);
  console.log(`  info gear 90-degree symmetry: ${symmetric}`);
  check('settings: gear is 4-fold symmetric (spin then reset is invisible)', symmetric);
  check('settings: move matches the symmetry result', G.TAB_GLYPHS['tab-settings'].move === (symmetric ? 'spin' : 'wobble'));

  // Tracks: strictly valid and resting at the end.
  const REST = { translateY: 0, rotate: 0, opacity: 1 };
  for (const name of names) {
    const glyph = G.TAB_GLYPHS[name];
    const tracks = [...(glyph.parts.map((p) => p.track)), glyph.wrapTrack].filter(Boolean);
    for (const t of tracks) {
      const inR = t.inputRange, outR = t.outputRange;
      check(`${name}: ${t.prop} track lengths match`, inR.length === outR.length);
      check(`${name}: ${t.prop} track input is non-decreasing, 0 to 1`, inR[0] === 0 && inR[inR.length - 1] === 1 && inR.every((v, k) => k === 0 || v > inR[k - 1]));
      check(`${name}: ${t.prop} track ends at rest`, outR[outR.length - 1] === REST[t.prop], String(outR[outR.length - 1]));
    }
    if (tracks.length === 0) check(`${name}: has at least one track`, false);
  }

  check('move total is at most 250 ms', G.GLYPH_MOVE_MS > 0 && G.GLYPH_MOVE_MS <= 250);

  const feeds = G.TAB_GLYPHS['tab-feeds'];
  const op0 = (p) => (p.track ? p.track.outputRange[0] : 1);
  const dot = feeds.parts.find((p) => p.id === 'dot');
  check('feeds: starts at dot only', dot && op0(dot) === 1 && feeds.parts.filter((p) => p.id !== 'dot').every((p) => op0(p) === 0));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
