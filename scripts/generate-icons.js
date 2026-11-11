#!/usr/bin/env node
/**
 * Regenerates the raster app assets from the vector brand files.
 *
 *   node scripts/generate-icons.js
 *
 * Needs only ImageMagick (`brew install imagemagick`, command `magick`), using its built-in
 * SVG renderer. No Rust, NDK or npm packages are involved.
 *
 * Sources: assets/brand/maglev-icon.svg (tile + mark), assets/brand/maglev-mark.svg (mark only)
 * Outputs: assets/icon.png            1024x1024  tile + mark, full bleed (Android masks it)
 *          assets/adaptive-icon.png   1024x1024  transparent, mark only, inside the 66% safe zone
 *          assets/splash.png          1284x2778  transparent, mark centered, 288px wide
 *          assets/favicon.png         48x48      tile + mark
 */
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const ICON_SVG = path.join(assets, 'brand', 'maglev-icon.svg');
const MARK_SVG = path.join(assets, 'brand', 'maglev-mark.svg');
const MARK_W = 152; // viewBox of maglev-mark.svg
const MARK_H = 200;

const magick = (...args) => execFileSync('magick', args, { stdio: 'inherit' });

// Rasterize an SVG so its viewBox height lands on `height` pixels.
function rasterize(svg, viewH, height, out) {
  const density = (96 * height) / viewH;
  magick('-background', 'none', '-density', String(density), svg, '-depth', '8', out);
}

// 1. Launcher icon
// Flattened on the tile colour: square, no alpha (iOS rejects alpha, Android applies its own mask).
const iconOut = path.join(assets, 'icon.png');
rasterize(ICON_SVG, 1024, 1024, iconOut);
magick(iconOut, '-background', '#282828', '-alpha', 'remove', '-alpha', 'off', iconOut);

// 2. Adaptive foreground: mark height 500px keeps the diagonal (~630px) inside the 676px safe circle
const adaptiveMark = path.join(assets, '.adaptive-mark.tmp.png');
rasterize(MARK_SVG, MARK_H, 500, adaptiveMark);
magick('-size', '1024x1024', 'xc:none', adaptiveMark, '-gravity', 'center', '-composite',
  path.join(assets, 'adaptive-icon.png'));

// 3. Splash: mark 288px wide on a transparent portrait canvas
const splashMark = path.join(assets, '.splash-mark.tmp.png');
rasterize(MARK_SVG, MARK_H, Math.round((288 * MARK_H) / MARK_W), splashMark);
magick('-size', '1284x2778', 'xc:none', splashMark, '-gravity', 'center', '-composite',
  path.join(assets, 'splash.png'));

// 4. Favicon
rasterize(ICON_SVG, 1024, 48, path.join(assets, 'favicon.png'));

require('fs').rmSync(adaptiveMark, { force: true });
require('fs').rmSync(splashMark, { force: true });
console.log('Icons written to', assets);
