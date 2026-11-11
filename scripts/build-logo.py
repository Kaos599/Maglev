# Run: python3 scripts/build-logo.py "$PWD"  then  node scripts/generate-icons.js
# Maglev mark: the traced train redrawn on a pixel grid (1 unit = 16 px of the 2048 trace).
import sys
root = sys.argv[1]
# Nose: fine 1 x 0.75 steps read as a smooth slope; the last steps round off the tip into the base.
nose = "".join(f" H{80+k:g} V{45.75+0.75*k:g}" for k in range(36)) + " V74.5 H114.25 V75.5 H113.5 V76"
# Window: a slanted parallelogram like the original drawing. Both sides step down to the right
# (the left edge leans like a windshield, the right edge follows the nose), the top-left corner is
# rounded off, and the frame along the nose thickens towards the base. 22 rows of 0.75 units.
# Corner insets per row (negative keys count from the bottom row).
SOFT_L = {0: 2.2, 1: 1.0, 2: 0.35, -1: 1.4, -2: 0.5}
SOFT_R = {0: 1.4, 1: 0.5, -1: 2.0, -2: 0.9, -3: 0.3}
def _window():
    rows = 22
    top = 49.5
    pts = []
    for j in range(rows):
        y0 = top + 0.75 * j
        left = 67 + 0.6 * j + SOFT_L.get(j, SOFT_L.get(j - rows, 0))   # every corner rounded over 2-3 rows
        right = 84 + 0.8 * j - SOFT_R.get(j, SOFT_R.get(j - rows, 0))
        pts.append((y0, y0 + 0.75, left, right))
    d = f"M{pts[0][2]:g} {pts[0][0]:g}"
    for (y0, y1, l, r) in pts:                       # down the right edge
        d += f" H{r:g} V{y1:g}"
    for (y0, y1, l, r) in reversed(pts):              # back up the left edge
        d += f" H{l:g} V{y0:g}"
    return d + " Z"
window = _window()
def _stair_up(rows, y_top, x_right, slope):
    """Walk up a stepped edge (0.75-unit rows) whose right side leans like the window's left edge."""
    d = ""
    for j in reversed(range(rows)):
        d += f" V{y_top + 0.75 * j:g}" + (f" H{x_right + slope * (j - 1):g}" if j else "")
    return d
# Back of the train: three bands that stream into the speed lines. The two cut-ins between them end
# in stepped edges at the window's angle, so every cut reads as one deliberate slant.
CUT_A = (6, 49.5, 52.0)    # rows, top y, right x of the first row  (between band 1 and band 2)
CUT_B = (10, 58.5, 58.0)   # (between band 2 and band 3)
SLOPE = 0.6
def _cut_bottom_right(cut):
    rows, y, x = cut
    return x + SLOPE * (rows - 1), y + 0.75 * rows
a_x, a_y = _cut_bottom_right(CUT_A)
b_x, b_y = _cut_bottom_right(CUT_B)
# Back ends are raked like a wind trail: within each band the top row reaches furthest back.
# Rows are 1.5 units tall. Walking up the back: (y_bottom, y_top, left_x) per row, bottom band first.
BAND3 = [(76, 70.5, 29.5), (70.5, 69, 36), (69, 67.5, 33.5), (67.5, 66, 31)]
BAND2 = [(58.5, 57, 40), (57, 55.5, 37), (55.5, 54, 34)]
BAND1 = [(49.5, 48, 42.5), (48, 46.5, 40), (46.5, 45, 37)]
def _rake(rows):
    return "".join(f" H{x:g} V{yt:g}" for (_, yt, x) in rows)
body = ("M37 45 H79" + nose +
        f" H{BAND3[0][2]:g} V70.5" + "".join(f" H{x:g} V{yt:g}" for (_, yt, x) in BAND3[1:]) +
        f" H{b_x:g}" + _stair_up(*CUT_B, SLOPE) +
        f" H{BAND2[0][2]:g} V57" + "".join(f" H{x:g} V{yt:g}" for (_, yt, x) in BAND2[1:]) +
        f" H{a_x:g}" + _stair_up(*CUT_A, SLOPE) +
        f" H{BAND1[0][2]:g} V48" + "".join(f" H{x:g} V{yt:g}" for (_, yt, x) in BAND1[1:]) + " Z " + window)
# Speed lines: varied length and weight, each leaving a band's longest row with a 2-unit gap, plus
# faded trailing dashes (motion blur). The long middle streak leads.
lines = ("M21 45 H35 V46.5 H21 Z "        # off band 1
         "M7 54 H32 V55.5 H7 Z "          # lead streak off band 2
         "M25 57.75 H37 V58.5 H25 Z "     # thin under-streak
         "M18 66 H29 V67.5 H18 Z "        # off band 3
         "M13 73 H27.5 V74.5 H13 Z")      # off the chassis
dashes = ("M14 45 H18 V46.5 H14 Z "
          "M10 66 H15 V67.5 H10 Z "
          "M6 73 H9.5 V74.5 H6 Z")
rails = ("M20 79.5 H29 V80.75 H20 Z "
         "M34 79.5 H67 V80.75 H68.5 V82 H70 V83.25 H40.5 V82 H36 V80.75 H34 Z "
         "M71 79.5 H112.5 V80.75 H111 V82 H108.5 V83.25 H74.5 V82 H72.5 V80.75 H71 Z")
LIME, CYAN, VOID = "#A5FB48", "#01E5EF", "#05070A"
VB = (4, 42, 113, 44)
def art(tf=""):
    return (f'<g{tf}><path fill="{LIME}" fill-rule="evenodd" d="{body}"/>'
            f'<path fill="{CYAN}" d="{lines}"/><path fill="{CYAN}" fill-opacity="0.5" d="{dashes}"/>'
            f'<path fill="{CYAN}" d="{rails}"/></g>')
open(f"{root}/assets/brand/maglev-mark.svg", "w").write(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{" ".join(map(str, VB))}" width="{VB[2]}" height="{VB[3]}">\n'
    f'  <title>Maglev mark</title>\n  {art()}\n</svg>\n')
W = 780; s = W / VB[2]; tx = (1024 - W) / 2 - VB[0] * s; ty = (1024 - VB[3] * s) / 2 - VB[1] * s
open(f"{root}/assets/brand/maglev-icon.svg", "w").write(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n'
    f'  <title>Maglev icon</title>\n  <rect width="1024" height="1024" fill="{VOID}"/>\n'
    f'  {art(f" transform=\"translate({tx:.2f} {ty:.2f}) scale({s:.4f})\"")}\n</svg>\n')
open(f"{root}/components/brand/markPaths.ts", "w").write(
    "// Generated by scripts/build-logo.py from the Maglev mark. Do not edit by hand.\n"
    f"export const MARK_VIEWBOX = '{' '.join(map(str, VB))}';\n"
    f"export const MARK_RATIO = {VB[2]} / {VB[3]};\n"
    f"export const MARK_BODY = '{body}';\n"
    f"export const MARK_LINES = '{lines}';\n"
    f"export const MARK_RAILS = '{rails}';\n"
    f"export const MARK_DASHES = '{dashes}';\n"
    f"export const MARK_LIME = '{LIME}';\nexport const MARK_CYAN = '{CYAN}';\n")
print("ok")

# Monochrome status-bar / Quick Settings drawable: body + rails only (the speed lines vanish at 24dp).
# Android tints it; the window stays a hole (evenOdd).
mx, my, mw, mh = 20, 44, 97, 40           # crop to body + rails (x 21..116)
pad = (mw - mh) / 2
android_path = lambda d: d.replace(" Z ", " Z").strip()
open(f"{root}/modules/maglev-engine/android/src/main/res/drawable/ic_tile_maglev.xml", "w").write(
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<!-- Generated by scripts/build-logo.py: the Maglev train silhouette (body with its window, and rails).\n'
    '     Monochrome: the system tints it. -->\n'
    '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
    '    android:width="24dp"\n    android:height="24dp"\n'
    f'    android:viewportWidth="{mw}"\n    android:viewportHeight="{mw}">\n'
    f'    <group android:translateX="{-mx}" android:translateY="{-my + pad:g}">\n'
    f'        <path android:fillColor="#FFFFFFFF" android:fillType="evenOdd" android:pathData="{android_path(body)}" />\n'
    f'        <path android:fillColor="#FFFFFFFF" android:pathData="{android_path(rails)}" />\n'
    '    </group>\n</vector>\n')
