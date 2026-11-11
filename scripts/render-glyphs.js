#!/usr/bin/env node
/**
 * Contact sheet for the pixel glyphs: every glyph at 1x (20px) and 4x (80px),
 * plus a mock of the bottom tab bar. Writes glyphs.html to the output dir.
 * Usage: node scripts/render-glyphs.js [outDir]
 * Then screenshot with headless Chrome (see docs/ or the task notes).
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'icons.generated.ts'), 'utf8');
const GLYPHS = new Function(`return ${/ICON_PATHS = (\{[\s\S]*?\n\}) as const;/.exec(src)[1]}`)();
const outDir = process.argv[2] || path.join(__dirname, '..', 'tmp-glyphs');
fs.mkdirSync(outDir, { recursive: true });
const NEW = ['tab-transfers', 'tab-search', 'tab-feeds', 'tab-settings', 'file-video', 'file-audio', 'file-image',
  'file-archive', 'file-doc', 'file-app', 'file-disc', 'ratio', 'recheck', 'reannounce', 'priority-first'];
const svg = (name, px, color) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 24 24" shape-rendering="crispEdges"><path d="${GLYPHS[name]}" fill="${color}"/></svg>`;
const cell = (n) =>
  `<div class="c${NEW.includes(n) ? ' new' : ''}"><div class="row">${svg(n, 24, '#E6EDF3')}${svg(n, 20, '#8B949E')}${svg(n, 16, '#8B949E')}${svg(n, 48, '#CCFF00')}</div><span>${n}</span></div>`;
const tab = (n, label, on) =>
  `<div class="tab"><div class="pill${on ? ' on' : ''}">${svg(n, 24, on ? '#CCFF00' : '#8B949E')}</div><b class="${on ? 'f' : ''}">${label}</b></div>`;

const html = `<!doctype html><meta charset="utf-8"><style>
body{background:#05070A;color:#8B949E;font:11px Inter,system-ui;margin:16px}
.g{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
.c{background:#0D1117;border:1px solid #1F2937;padding:8px;display:flex;flex-direction:column;align-items:center;gap:6px}
.c.new{border-color:#CCFF0066}.row{display:flex;gap:10px}
h3{color:#E6EDF3;margin:18px 0 8px}
.bar{display:flex;width:360px;height:64px;border-top:1px solid #1F2937;background:#05070A}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px}
.pill{width:56px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center}
.pill.on{background:rgba(204,255,0,.16)}.tab b{font-weight:400;font-size:11px}.tab b.f{font-weight:700;color:#E6EDF3}
.grey{filter:grayscale(1)}
</style>
<h3>Tab bar (Transfers focused / Search focused)</h3>
<div class="bar">${tab('tab-transfers', 'Transfers', 1)}${tab('tab-search', 'Search')}${tab('tab-feeds', 'Feeds')}${tab('tab-settings', 'Settings')}</div>
<div class="bar" style="margin-top:8px">${tab('tab-transfers', 'Transfers')}${tab('tab-search', 'Search', 1)}${tab('tab-feeds', 'Feeds')}${tab('tab-settings', 'Settings')}</div>
<h3>New glyphs (24 light, 20, 16 muted, 48 accent)</h3>
<div class="g">${NEW.map(cell).join('')}</div>
<h3>Existing glyphs</h3>
<div class="g">${Object.keys(GLYPHS).filter((n) => !NEW.includes(n)).map(cell).join('')}</div>`;
fs.writeFileSync(path.join(outDir, 'glyphs.html'), html);
console.log(`wrote ${path.join(outDir, 'glyphs.html')} (${Object.keys(GLYPHS).length} icons)`);
