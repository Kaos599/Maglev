/*
 * Fills the shared pieces of every mock screen:
 *   <i class="px" data-i="pause"></i>   a Pixelarticons glyph from components/icons.generated.ts
 *   <div class="statusbar"></div>        Android status bar: neutral time, Wi-Fi, full battery
 *   <nav class="tabbar" data-on="search"></nav>   the real five tabs (app/(tabs)/_layout.tsx)
 *   <div class="navbar"></div>           gesture handle
 *   <span class="mark"></span>           the brand mark (assets/brand/maglev-mark.svg paths)
 * icons.js (window.ICON_PATHS) is generated from components/icons.generated.ts by store/render.js.
 */
(function () {
  const P = window.ICON_PATHS || {};
  const svg = (d) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="currentColor"/></svg>`;

  const MARK =
    '<svg viewBox="10 42 107 44" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="#01E5EF" d="M16 46.5 H37 V48 H16 Z M10 55.5 H33 V57 H10 Z M18 67.5 H33 V69 H18 Z M12 73 H25 V74.5 H12 Z"/>' +
    '<path fill="#A5FB48" fill-rule="evenodd" d="M40 45 H80 V45.75 H81 V46.5 H82 V47.25 H83 V48 H84 V48.75 H85 V49.5 H86 V50.25 H87 V51 H88 V51.75 H89 V52.5 H90 V53.25 H91 V54 H92 V54.75 H93 V55.5 H94 V56.25 H95 V57 H96 V57.75 H97 V58.5 H98 V59.25 H99 V60 H100 V60.75 H101 V61.5 H102 V62.25 H103 V63 H104 V63.75 H105 V64.5 H106 V65.25 H107 V66 H108 V66.75 H109 V67.5 H110 V68.25 H111 V69 H112 V69.75 H113 V70.5 H114 V71.25 H115 V74.5 H114.25 V75.5 H113.5 V76 H28 V70.5 H36 V66 H63.4 V65.25 H62.8 V64.5 H62.2 V63.75 H61.6 V63 H61 V62.25 H60.4 V61.5 H59.8 V60.75 H59.2 V60 H58.6 V59.25 H58 V58.5 H36 V54 H55 V53.25 H54.4 V52.5 H53.8 V51.75 H53.2 V51 H52.6 V50.25 H52 V49.5 H40 Z M69.6 49.5 H82.2 V49.875 H83.4 V50.25 H84.35 V50.625 H85.05 V51 H85.6 V51.375 H86 V51.75 H86.4 V52.125 H86.8 V52.5 H87.2 V52.875 H87.6 V53.25 H88 V53.625 H88.4 V54 H88.8 V54.375 H89.2 V54.75 H89.6 V55.125 H90 V55.5 H90.4 V55.875 H90.8 V56.25 H91.2 V56.625 H91.6 V57 H92 V57.375 H92.4 V57.75 H92.8 V58.125 H93.2 V58.5 H93.6 V58.875 H94 V59.25 H94.4 V59.625 H94.8 V60 H95.2 V60.375 H95.6 V60.75 H96 V61.125 H96.4 V61.5 H96.8 V61.875 H97.2 V62.25 H97.6 V62.625 H98 V63 H98.4 V63.375 H98.8 V63.75 H99.2 V64.125 H99.5 V64.5 H99.6 V64.875 H99.55 V65.25 H99.3 V65.625 H98.8 V66 H81.7 V65.625 H80.6 V65.25 H79.75 V64.875 H79.15 V64.5 H78.7 V64.125 H78.4 V63.75 H78.1 V63.375 H77.8 V63 H77.5 V62.625 H77.2 V62.25 H76.9 V61.875 H76.6 V61.5 H76.3 V61.125 H76 V60.75 H75.7 V60.375 H75.4 V60 H75.1 V59.625 H74.8 V59.25 H74.5 V58.875 H74.2 V58.5 H73.9 V58.125 H73.6 V57.75 H73.3 V57.375 H73 V57 H72.7 V56.625 H72.4 V56.25 H72.1 V55.875 H71.8 V55.5 H71.5 V55.125 H71.2 V54.75 H70.9 V54.375 H70.6 V54 H70.3 V53.625 H70 V53.25 H69.7 V52.875 H69.4 V52.5 H69.1 V52.125 H68.8 V51.75 H68.5 V51.375 H68.45 V51 H68.5 V50.625 H68.65 V50.25 H69 V49.875 H69.6 V49.5 Z"/>' +
    '<path fill="#01E5EF" d="M20 79.5 H29 V80.75 H20 Z M34 79.5 H67 V80.75 H68.5 V82 H70 V83.25 H40.5 V82 H36 V80.75 H34 Z M71 79.5 H112.5 V80.75 H111 V82 H108.5 V83.25 H74.5 V82 H72.5 V80.75 H71 Z"/>' +
    '</svg>';

  // System status bar glyphs: these are Android's, not the app's, so they are plain shapes.
  const WIFI = '<svg width="16" height="14" viewBox="0 0 16 14"><path fill="#F3F4F6" d="M8 13.5 0 3.6C2.2 1.8 5 .7 8 .7s5.8 1.1 8 2.9z"/></svg>';
  const BATT = '<svg width="11" height="18" viewBox="0 0 11 18"><rect x="3.5" y="0" width="4" height="2" rx=".6" fill="#F3F4F6"/><rect x="0" y="1.6" width="11" height="16.4" rx="2" fill="#F3F4F6"/></svg>';

  const TABS = [
    ['transfers', 'Transfers', 'tab-transfers'],
    ['search', 'Search', 'tab-search'],
    ['feeds', 'Feeds', 'tab-feeds'],
    ['settings', 'Settings', 'tab-settings'],
    ['assistant', 'Assistant', 'tab-assistant'],
  ];

  function fill() {
    document.querySelectorAll('.statusbar').forEach((el) => {
      el.innerHTML = `<span>12:30</span><span class="sys">${WIFI}${BATT}</span>`;
    });
    document.querySelectorAll('nav.tabbar').forEach((el) => {
      const on = el.dataset.on;
      el.innerHTML = TABS.map(
        ([id, label, icon]) => `<div class="tab${id === on ? ' on' : ''}"><div class="pill"><i class="px" data-i="${icon}"></i></div><div class="lbl">${label}</div></div>`,
      ).join('');
    });
    document.querySelectorAll('.mark').forEach((el) => (el.innerHTML = MARK));
    document.querySelectorAll('i.px').forEach((el) => {
      const d = P[el.dataset.i];
      if (!d) {
        el.style.outline = '2px solid red';
        console.error('missing icon ' + el.dataset.i);
        return;
      }
      if (el.dataset.s) el.style.width = el.style.height = el.dataset.s + 'px';
      el.innerHTML = svg(d);
    });
  }
  fill();
})();
