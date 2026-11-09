const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// Ensure assets directory exists
const assetsDir = path.resolve(__dirname, '../assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

// Color palette
const VOID_BG = [5, 7, 10, 255];       // #05070A
const ACID_LIME = [204, 255, 0, 255];   // #CCFF00
const CYBER_CYAN = [0, 229, 255, 255];  // #00E5FF
const TRANSPARENT = [0, 0, 0, 0];
const BORDER_COLOR = [31, 41, 55, 255]; // #1F2937
const CARD_BG = [13, 17, 23, 255];     // #0D1117

// Line segment distance helper
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Triangle point-in-polygon helper
function pointInTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const area = 0.5 * (-y2 * x3 + y1 * (-x2 + x3) + x1 * (y2 - y3) + x2 * y3);
  const s = 1 / (2 * area) * (y1 * x3 - x1 * y3 + (y3 - y1) * px + (x1 - x3) * py);
  const t = 1 / (2 * area) * (x1 * y2 - y1 * x2 + (y1 - y2) * px + (x2 - x1) * py);
  return s >= 0 && t >= 0 && (1 - s - t) >= 0;
}

// Function to sample Maglev icon at (x, y) on 1024x1024 grid
// Returns [r, g, b, a]
function sampleIcon(x, y, isAdaptiveForeground = false) {
  // Safe zone radius is ~340 around (512, 512)
  const cx = 512;
  const cy = 512;

  // Background for regular icon (not adaptive foreground)
  let bg = isAdaptiveForeground ? TRANSPARENT : VOID_BG;

  // Draw background card rounded rect for regular icon
  if (!isAdaptiveForeground) {
    const rx = Math.abs(x - cx);
    const ry = Math.abs(y - cy);
    // Outer subtle 1px border card
    if (rx < 440 && ry < 440) {
      bg = CARD_BG;
      if (rx > 434 || ry > 434) {
        bg = BORDER_COLOR;
      }
    }
  }

  // --- 1. Magnetic Levitation Rails (horizontal glowing track at bottom) ---
  // Rail 1: y in [680, 696], x in [260, 764]
  if (y >= 680 && y <= 696 && x >= 260 && x <= 764) {
    const t = (x - 260) / (764 - 260);
    // Gradient from Acid Lime to Cyber Cyan
    return [
      Math.round(ACID_LIME[0] * (1 - t) + CYBER_CYAN[0] * t),
      Math.round(ACID_LIME[1] * (1 - t) + CYBER_CYAN[1] * t),
      Math.round(ACID_LIME[2] * (1 - t) + CYBER_CYAN[2] * t),
      255
    ];
  }

  // Rail 2: y in [720, 730], x in [310, 714] (secondary track)
  if (y >= 716 && y <= 728 && x >= 310 && x <= 714) {
    return [CYBER_CYAN[0], CYBER_CYAN[1], CYBER_CYAN[2], 180];
  }

  // Segmented magnetic pulse dashes under rail 2
  if (y >= 744 && y <= 752 && x >= 340 && x <= 684) {
    if ((Math.floor(x / 24) % 2) === 0) {
      return [ACID_LIME[0], ACID_LIME[1], ACID_LIME[2], 220];
    }
  }

  // --- 2. The Futuristic Maglev "M" / Supersonic Core ---
  // Left pillar: angled quadrilateral
  // P1: (260, 640), P2: (324, 640), P3: (324, 300), P4: (260, 340)
  if (x >= 260 && x <= 324 && y >= 320 && y <= 640) {
    const t = (y - 320) / (640 - 320);
    return [
      Math.round(ACID_LIME[0] * (1 - t * 0.4)),
      Math.round(ACID_LIME[1]),
      Math.round(ACID_LIME[2]),
      255
    ];
  }

  // Right pillar: angled quadrilateral
  // P1: (700, 640), P2: (764, 640), P3: (764, 340), P4: (700, 300)
  if (x >= 700 && x <= 764 && y >= 320 && y <= 640) {
    const t = (y - 320) / (640 - 320);
    return [
      Math.round(CYBER_CYAN[0] * (1 - t * 0.2)),
      Math.round(CYBER_CYAN[1]),
      Math.round(CYBER_CYAN[2]),
      255
    ];
  }

  // Left diagonal stroke of M: from (324, 320) down to apex (512, 530)
  const dDiagLeft = distToSegment(x, y, 324, 320, 512, 530);
  if (dDiagLeft <= 32) {
    const t = (x - 324) / (512 - 324);
    return [
      Math.round(ACID_LIME[0] * (1 - t * 0.5) + CYBER_CYAN[0] * (t * 0.5)),
      Math.round(ACID_LIME[1] * (1 - t * 0.2) + CYBER_CYAN[1] * (t * 0.2)),
      Math.round(ACID_LIME[2] + CYBER_CYAN[2] * t),
      255
    ];
  }

  // Right diagonal stroke of M: from (700, 320) down to apex (512, 530)
  const dDiagRight = distToSegment(x, y, 700, 320, 512, 530);
  if (dDiagRight <= 32) {
    const t = (700 - x) / (700 - 512);
    return [
      Math.round(CYBER_CYAN[0] * (1 - t * 0.5) + ACID_LIME[0] * (t * 0.5)),
      Math.round(CYBER_CYAN[1]),
      Math.round(CYBER_CYAN[2] * (1 - t)),
      255
    ];
  }

  // --- 3. Downward High-Speed Torrent Arrow / Core Pulse ---
  // Inverted arrow pointing down beneath apex:
  // Arrow head: triangle (432, 560), (592, 560), (512, 650)
  if (pointInTriangle(x, y, 440, 560, 584, 560, 512, 650)) {
    return [ACID_LIME[0], ACID_LIME[1], ACID_LIME[2], 255];
  }

  // Arrow stem: vertical bar from (492, 420) to (532, 560)
  if (x >= 492 && x <= 532 && y >= 400 && y <= 560) {
    return [ACID_LIME[0], ACID_LIME[1], ACID_LIME[2], 255];
  }

  // Top magnetic levitation energy visor/dash above the M
  if (y >= 260 && y <= 276 && x >= 360 && x <= 664) {
    return [CYBER_CYAN[0], CYBER_CYAN[1], CYBER_CYAN[2], 240];
  }

  return bg;
}

// Generate image with 2x2 supersampling for anti-aliasing
function renderImage(width, height, isAdaptiveForeground = false) {
  const png = new PNG({ width, height });
  const scale = 1024 / width;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0, a = 0;

      // 2x2 supersampling
      const offsets = [0.25, 0.75];
      for (const ox of offsets) {
        for (const oy of offsets) {
          const sx = (px + ox) * scale;
          const sy = (py + oy) * scale;
          const sample = sampleIcon(sx, sy, isAdaptiveForeground);
          r += sample[0];
          g += sample[1];
          b += sample[2];
          a += sample[3];
        }
      }

      const idx = (width * py + px) << 2;
      png.data[idx] = Math.round(r / 4);
      png.data[idx + 1] = Math.round(g / 4);
      png.data[idx + 2] = Math.round(b / 4);
      png.data[idx + 3] = Math.round(a / 4);
    }
  }

  return png;
}

function savePng(png, filePath) {
  const buffer = PNG.sync.write(png);
  fs.writeFileSync(filePath, buffer);
  console.log(`Saved: ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

console.log('Generating Maglev Cyber-Retro App Icons...');

// 1. Full standard icon (1024x1024)
const icon1024 = renderImage(1024, 1024, false);
savePng(icon1024, path.join(assetsDir, 'icon.png'));

// 2. Adaptive icon foreground (1024x1024 transparent)
const adaptiveFg = renderImage(1024, 1024, true);
savePng(adaptiveFg, path.join(assetsDir, 'adaptive-icon.png'));

// 3. Splash screen (1024x1024 solid void)
savePng(icon1024, path.join(assetsDir, 'splash.png'));

// 4. Favicon (48x48)
const favicon = renderImage(48, 48, false);
savePng(favicon, path.join(assetsDir, 'favicon.png'));

console.log('All icons generated successfully!');
