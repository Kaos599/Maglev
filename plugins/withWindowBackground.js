// Expo config plugin: the window behind the first React frame is Void (#05070A), not the platform default grey.
// Why: the generated AppTheme inherits Theme.AppCompat.DayNight, whose window background is Material grey
// (#303030 in night mode, #FAFAFA in day mode). The splash hands over to AppTheme (it is the splash's
// postSplashScreenTheme), so that grey would show between the splash leaving and React drawing its first frame.
// This plugin sets AppTheme's windowBackground to a Void colour resource.
// It deliberately does not touch Theme.App.SplashScreen or splashscreen_background. expo-splash-screen owns them
// (background, icon and post-splash theme, light and night), and it replaces any style with that name, so editing
// the launch theme here would depend on which plugin runs first. Plugin order does not matter for what remains:
// the colour name and the AppTheme item are used by nobody else.
// The colour is always Void, even when the app later shows the dim or light theme. The saved theme lives in
// SQLite and cannot be read before the window exists, and the default mode is oled (DEFAULT_MODE in
// constants/theme.ts). The splash is dark in every mode, so a light flash would be the worse mistake. Light users
// see one dark frame, then the light UI.
// The value is read from constants/theme.ts (palettes.oled.bg) so there is one source of truth.
const COLOR_NAME = 'maglev_window_background';
const COLOR_REF = '@color/' + COLOR_NAME;
const APP_THEME = { name: 'AppTheme', parent: 'Theme.AppCompat.DayNight.NoActionBar' };

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
  return assignColorValue(colorsXml, { name: COLOR_NAME, value: hex });
}

/** Style items this plugin owns: [group, item name, value]. */
const STYLE_ITEMS = [[APP_THEME, 'android:windowBackground', COLOR_REF]];

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
module.exports.STYLE_ITEMS = STYLE_ITEMS;
