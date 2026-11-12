/*
 * Fills a frame from its query string (store/render.js builds it from screens.json):
 *   shot     file URL of the rendered 1080x2400 screen
 *   h, s     headline and supporting line
 *   color    'lime' or 'white' headline
 *   seed     any string; varies the speed-line band per frame, the same on every render
 *   focusX, focusY   detail template only: which point of the screen (0..1) sits at the anchor
 */
(function () {
  const q = new URLSearchParams(location.search);
  const $ = (sel) => document.querySelector(sel);
  if ($('.headline')) {
    // "*phrase*" marks the one accent phrase (v2 frames); built with text nodes, never HTML.
    const h = $('.headline');
    (q.get('h') || '').split(/(\*[^*]+\*)/).forEach((part) => {
      if (!part) return;
      if (part.startsWith('*') && part.endsWith('*')) {
        const span = document.createElement('span');
        span.className = 'lime';
        span.textContent = part.slice(1, -1);
        h.appendChild(span);
      } else h.appendChild(document.createTextNode(part));
    });
    if (q.get('color') === 'lime') $('.headline').classList.add('lime');
  }
  if ($('.subline')) $('.subline').textContent = q.get('s') || '';
  const img = $('img.screen');
  if (img && q.get('shot')) img.src = q.get('shot');

  // Deterministic speed lines, quantised to a pixel grid (4px by default) like the mark's rails.
  let seed = 0;
  for (const ch of q.get('seed') || 'maglev') seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  document.querySelectorAll('svg.rails').forEach((svg) => {
    const W = +svg.getAttribute('width');
    const rows = +(svg.dataset.rows || 3);
    const U = +(svg.dataset.unit || 4);
    let out = '';
    for (let r = 0; r < rows; r++) {
      const y = r * U * 3;
      let x = Math.floor(rnd() * 8) * U;
      const op = r === 0 ? 1 : r === 1 ? 0.5 : 0.25;
      while (x < W) {
        const len = (4 + Math.floor(rnd() * 22)) * U;
        out += `<rect x="${x}" y="${y}" width="${Math.min(len, W - x)}" height="${U}" fill="#00E5FF" opacity="${op}"/>`;
        x += len + (2 + Math.floor(rnd() * 6)) * U;
      }
    }
    svg.setAttribute('height', String((rows - 1) * U * 3 + U));
    svg.innerHTML = out;
  });

  const phone = $('.phone[data-anchor]');
  if (phone) {
    // Detail crop: put (focusX, focusY) of the screen at the anchor point on the canvas.
    const [ax, ay] = phone.dataset.anchor.split(',').map(Number);
    const fx = +(q.get('focusX') ?? 0);
    const fy = +(q.get('focusY') ?? 0);
    // Screen pixels: 1080 x 2400. The point lands at the anchor, clamped so no empty edge shows.
    const w = phone.offsetWidth;
    const h = w * (20 / 9);
    phone.style.position = 'absolute';
    phone.style.left = `${Math.min(0, ax - fx * w)}px`;
    phone.style.top = `${Math.min(0, ay - fy * h)}px`;
  }
})();
