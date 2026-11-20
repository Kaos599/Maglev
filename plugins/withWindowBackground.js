// Expo config plugin: the very first window frame is Void (#05070A), not the platform default grey.
// Why: nothing in the prebuild output set a window colour, so a cold start showed flat grey before the first
// React frame. The generated styles.xml has two themes, and both were wrong:
//  - Theme.App.SplashScreen (the launch theme in the manifest) uses @drawable/splashscreen_logo over the
//    template colour splashscreen_background, which is white (#FFFFFF). Android 12+ derives the system splash
//    background from that drawable instead of reading a colour, so it picks its own.
//  - AppTheme (MainActivity.onCreate calls setTheme(AppTheme)) inherits Theme.AppCompat.DayNight, whose window
//    background is the Material grey (#303030 in night mode, #FAFAFA in day mode). That grey shows from the
//    moment the splash window leaves until React draws its first frame.
// expo-system-ui (which would set the root view colour) and expo-splash-screen are not installed, and the
// `splash` block in app.json is read by neither, so the fix lives here.
// The colour is always Void, even when the app later shows the dim or light theme. The saved theme lives in
// SQLite and cannot be read before the window exists, and the default mode is oled (DEFAULT_MODE in
// constants/theme.ts). The brand splash (teal icon tile on Void) is dark in every mode, so a light flash would
// be the worse mistake. Light users see one dark frame, then the light UI.
// The value is read from constants/theme.ts (palettes.oled.bg) so there is one source of truth.
// Docs: https://developer.android.com/develop/ui/views/launch/splash-screen#set-theme
const COLOR_NAME = 'maglev_window_background';
const COLOR_REF = '@color/' + COLOR_NAME;
const TEMPLATE_SPLASH_COLOR = 'splashscreen_background';
const APP_THEME = { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' };
const SPLASH_THEME = { name: 'Theme.App.SplashScreen', parent: 'AppTheme' };

/** Void, read from the oled palette in constants/theme.ts. Throws when the palette cannot be found. */
function readVoid(themeSource) {
  if (themeSource === undefined) {
    themeSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'constants', 'theme.ts'), 'utf8');
  }
  const m = /oled:\s*\{\s*bg:\s*'(#[0-9A-Fa-f]{6})'/.exec(themeSource);
  if (!m) throw new Error('withWindowBackground: palettes.oled.bg not found in constants/theme.ts');
  return m[1].toUpperCase();
}

/** Pure transform for colors.xml resources. Idempotent. */
function applyColors(colorsXml, hex, assignColorValue) {
  colorsXml = assignColorValue(colorsXml, { name: COLOR_NAME, value: hex });
  return assignColorValue(colorsXml, { name: TEMPLATE_SPLASH_COLOR, value: hex });
}

/** Style items this plugin owns: [group, item name, value]. */
const STYLE_ITEMS = [
  [APP_THEME, 'android:windowBackground', COLOR_REF],
  // API 31+: the system splash window. Older versions ignore the attribute and use the template drawable,
  // whose base colour is splashscreen_background (set above).
  [SPLASH_THEME, 'android:windowSplashScreenBackground', COLOR_REF],
];

function withWindowBackground(config) {
  const { withAndroidColors, withAndroidStyles, AndroidConfig } = require('expo/config-plugins');
  const hex = readVoid();
  config = withAndroidColors(config, (c) => {
    c.modResults = applyColors(c.modResults, hex, AndroidConfig.Colors.assignColorValue);
    return c;
  });
  config = withAndroidStyles(config, (c) => {
    for (const [parent, name, value] of STYLE_ITEMS) {
      c.modResults = AndroidConfig.Styles.assignStylesValue(c.modResults, { add: true, parent, name, value });
    }
    return c;
  });
  return config;
}

module.exports = withWindowBackground;
module.exports.readVoid = readVoid;
module.exports.applyColors = applyColors;
module.exports.COLOR_NAME = COLOR_NAME;
module.exports.TEMPLATE_SPLASH_COLOR = TEMPLATE_SPLASH_COLOR;
module.exports.STYLE_ITEMS = STYLE_ITEMS;
