#!/usr/bin/env node
/**
 * Builds components/icons.generated.ts from the pixelarticons SVGs (MIT, devDependency only).
 * Run: node scripts/gen-icons.js
 * To change an icon, edit MAP below and re-run. Fails loudly if a file is missing.
 */
const fs = require('fs');
const path = require('path');

const SVG_DIR = path.join(__dirname, '..', 'node_modules', 'pixelarticons', 'svg');
const OUT = path.join(__dirname, '..', 'components', 'icons.generated.ts');

// ourName -> pixelarticons file name (without .svg)
const MAP = {
  // navigation and tabs
  transfers: 'sort-vertical',
  search: 'search',
  feeds: 'rss',
  settings: 'settings-cog',
  'tab-transfers': 'sort-vertical',
  'tab-search': 'search',
  'tab-feeds': 'rss',
  'tab-settings': 'settings-cog',
  // actions
  plus: 'plus',
  close: 'close',
  back: 'arrow-left',
  'chevron-right': 'chevron-right',
  more: 'more-vertical',
  check: 'check',
  pause: 'pause',
  play: 'play',
  stop: 'stop',
  retry: 'reload',
  trash: 'trash',
  folder: 'folder',
  file: 'file',
  share: 'share',
  // wave 4
  'speed-limit': 'speed-medium',
  move: 'move',
  rule: 'filter',
  calendar: 'calendar-range',
  alarm: 'alarm-clock',
  link: 'link',
  clipboard: 'clipboard',
  sort: 'arrow-down-wide-narrow',
  filter: 'filter',
  select: 'checkbox-on',
  'checkbox-empty': 'checkbox',
  copy: 'copy',
  external: 'external-link',
  magnet: 'link',
  // stats
  download: 'download',
  upload: 'upload',
  clock: 'clock',
  peers: 'users',
  tracker: 'server',
  pieces: 'grid-3x3',
  grid: 'grid-2x2-2',
  storage: 'database',
  bandwidth: 'speed-fast',
  queue: 'bulletlist',
  ratio: 'percent',
  // settings and status
  interface: 'layout',
  network: 'globe',
  wifi: 'wifi',
  power: 'battery-full',
  schedule: 'calendar',
  about: 'circle-info',
  github: 'github',
  bell: 'bell',
  shield: 'shield',
  warning: 'warning-diamond',
  stream: 'airplay',
  sun: 'sun',
  moon: 'moon',
  'power-off': 'power',
  // wave 3
  recheck: 'check-double',
  reannounce: 'radio',
  'priority-first': 'arrow-bar-up',
  'file-video': 'video',
  'file-audio': 'music',
  'file-image': 'image',
  'file-archive': 'archive',
  'file-doc': 'file-text',
  'file-app': 'android',
  'file-disc': 'target',
};

const out = {};
for (const [name, file] of Object.entries(MAP)) {
  const p = path.join(SVG_DIR, `${file}.svg`);
  if (!fs.existsSync(p)) {
    console.error(`gen-icons: missing pixelarticons file "${file}.svg" for "${name}"`);
    process.exit(1);
  }
  const ds = [...fs.readFileSync(p, 'utf8').matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
  if (!ds.length) {
    console.error(`gen-icons: no <path d> in ${file}.svg`);
    process.exit(1);
  }
  out[name] = ds.join('');
}

const body = Object.keys(out)
  .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(out[k])},`)
  .join('\n');
fs.writeFileSync(
  OUT,
  `// generated — run node scripts/gen-icons.js\n// Source: pixelarticons 2.4.2 (MIT), see assets/licenses/pixelarticons-LICENSE\n` +
    `/* eslint-disable */\nexport const ICON_VIEWBOX = 24;\n\nexport const ICON_PATHS = {\n${body}\n} as const;\n`,
);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${Object.keys(out).length} icons)`);
