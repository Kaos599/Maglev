# Run: python3 scripts/build-logo.py "$PWD"  then  node scripts/generate-icons.js
# Maglev mark: the traced train redrawn on a pixel grid (1 unit = 16 px of the 2048 trace).
import sys
root = sys.argv[1]
# Nose: fine 1 x 0.75 steps read as a smooth slope; the last steps round off the tip into the base.
nose = "".join(f" H{80+k:g} V{45.75+0.75*k:g}" for k in range(36)) + " V74.5 H114.25 V75.5 H113.5 V76"
# Window: a slanted parallelogram like the original drawing. Both sides step down to the right
# (the left edge leans like a windshield, the right edge follows the nose), the top-left corner is
# rounded off, and the frame along the nose thickens towards the base. 22 rows of 0.75 units.
# Corner insets per row (negative keys count from the bottom row). Rows are 0.375 units, so the
# slanted sides read as smooth edges and each corner rounds over several rows.
SOFT_L = {0: 2.6, 1: 1.7, 2: 1.05, 3: 0.6, 4: 0.25, -1: 1.8, -2: 1.0, -3: 0.45, -4: 0.15}
SOFT_R = {0: 1.8, 1: 1.0, 2: 0.45, 3: 0.15, -1: 2.4, -2: 1.5, -3: 0.85, -4: 0.4, -5: 0.1}
def _window():
    rows, h = 44, 0.375
    top = 49.5
    pts = []
    for j in range(rows):
        y0 = top + h * j
        left = 67 + 0.3 * j + SOFT_L.get(j, SOFT_L.get(j - rows, 0))
        right = 84 + 0.4 * j - SOFT_R.get(j, SOFT_R.get(j - rows, 0))
        pts.append((y0, y0 + h, round(left, 3), round(right, 3)))
    d = f"M{pts[0][2]:g} {pts[0][0]:g}"
    for (y0, y1, l, r) in pts:
        d += f" H{r:g} V{y1:g}"
    for (y0, y1, l, r) in reversed(pts):
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
body = ("M40 45 H79" + nose + " H28 V70.5 H36 V" + f"{b_y:g}" + f" H{b_x:g}" + _stair_up(*CUT_B, SLOPE) +
        " H36 V54" + f" H{a_x:g}" + _stair_up(*CUT_A, SLOPE) + " H40 Z " + window)
# Speed lines: one thickness (1.5), varied lengths, each sitting on a band.
# Cruise animation (app + README): each line is a sprite that pops out of the train's back
# (`hide` units tucked under the body), slides `travel` units back and fades. Different periods
# and phases give the lines their own speeds. Frames are sampled at FPS so motion steps like a sprite.
FPS = 20
#          x    y    w   h    hide travel  ms  phase  ghost
STREAKS = [(16, 46.5, 21, 1.5, 8, 22, 300, 0.00, False),   # band 1
           (10, 55.5, 23, 1.5, 8, 26, 360, 0.45, False),   # band 2
           (18, 67.5, 15, 1.5, 7, 18, 260, 0.70, False),   # band 3, upper
           (12, 73.0, 13, 1.5, 7, 20, 320, 0.25, False),   # band 3, tail
           # Wind dashes: only while cruising. They flash in by the body and whip off to the left.
           (32, 51.5, 7, 0.75, 0, 34, 240, 0.10, True),
           (26, 62.5, 9, 0.75, 0, 36, 200, 0.60, True),
           (24, 77.25, 8, 0.75, 0, 32, 280, 0.35, True)]
lines = " ".join(f"M{x:g} {y:g} H{x+w:g} V{y+h:g} H{x:g} Z" for (x, y, w, h, *_ ) in STREAKS if not _[-1])
def streak_frames(hide, travel, ms, phase, ghost=False):
    n = max(2, round(ms * FPS / 1000))
    out = []
    for k in range(n):
        t = (k / n + phase) % 1
        dx = round((hide - (hide + travel) * t) * 2) / 2
        if ghost:
            o = min(1.0, t / 0.15) if t < 0.15 else max(0.0, 1 - (t - 0.15) / 0.85)
        else:
            fade_from = -travel * 0.35
            o = 1.0 if dx >= fade_from else max(0.0, 1 + (dx - fade_from) / (travel + fade_from))
        out.append((dx, round(o * 4) / 4))
    return out
# Hover: at speed the train hums a hair above the rails (body + lines), in whole frames.
BOB_MS, BOB = 400, [0, -0.5, -0.5, 0, -0.5, 0, -0.5, -0.5]
dashes = ""
rails = ("M20 79.5 H29 V80.75 H20 Z "
         "M34 79.5 H67 V80.75 H68.5 V82 H70 V83.25 H40.5 V82 H36 V80.75 H34 Z "
         "M71 79.5 H112.5 V80.75 H111 V82 H108.5 V83.25 H74.5 V82 H72.5 V80.75 H71 Z")
LIME, CYAN, VOID = "#A5FB48", "#01E5EF", "#05070A"
VB = (10, 42, 107, 44)
def art(tf=""):
    return (f'<g{tf}><path fill="{LIME}" fill-rule="evenodd" d="{body}"/>'
            f'<path fill="{CYAN}" d="{lines}"/><path fill="{CYAN}" d="{rails}"/></g>')
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
    f"export const MARK_LIME = '{LIME}';\nexport const MARK_CYAN = '{CYAN}';\n"
    "/** Speed-line sprites: rect in viewBox units, loop length, frames of [dx units, opacity]. Ghosts show only while cruising. */\n"
    "export const MARK_STREAKS: { x: number; y: number; w: number; h: number; ms: number; ghost: boolean; frames: [number, number][] }[] = [\n"
    + "".join(f"  {{ x: {x:g}, y: {y:g}, w: {w:g}, h: {h:g}, ms: {ms}, ghost: {str(gh).lower()}, frames: {[[a, b] for a, b in streak_frames(hd, tr, ms, ph, gh)]} }},\n"
              for (x, y, w, h, hd, tr, ms, ph, gh) in STREAKS).replace(".0,", ",").replace(".0]", "]")
    + "];\n"
    f"/** Hover bob: loop length and frames of dy units (negative is up). */\nexport const MARK_BOB = {{ ms: {BOB_MS}, frames: {BOB} }};\n")
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

# README header: the same mark, cruising with the same frames via SVG keyframes.
import re
def css_keyframes(name, frames, prop):
    n = len(frames)
    ks = "".join(f"{100*k/n:.3f}%{{{prop(f)}}}" for k, f in enumerate(frames)) + f"100%{{{prop(frames[0])}}}"
    return f"@keyframes {name}{{{ks}}}"
css = [".ml-ride{animation:ml-bob %dms steps(1,end) infinite}" % BOB_MS,
       css_keyframes("ml-bob", BOB, lambda f: f"transform:translateY({f:g}px)")]
streak_svg = ""
for i, (x, y, w, h, hd, tr, ms, ph, gh) in enumerate(STREAKS):
    fr = streak_frames(hd, tr, ms, ph, gh)
    css.append(f".ml-s{i}{{animation:ml-k{i} {ms}ms steps(1,end) infinite}}")
    css.append(css_keyframes(f"ml-k{i}", fr, lambda f: f"transform:translateX({f[0]:g}px);opacity:{f[1]:g}"))
    streak_svg += f'<rect class="ml-s{i}" x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}"' + (' opacity="0"' if gh else '') + '/>'
css.append("@media (prefers-reduced-motion:reduce){.ml-ride,.ml-ride rect{animation:none}}")
H = 76; sc = H / VB[3]; MX, MY = 372, 79           # mark box in the 1280x420 header
readme_mark = (f'<!-- mark:start (generated by scripts/build-logo.py) -->\n<style>{"".join(css)}</style>\n'
    f'<g transform="translate({MX - VB[0]*sc:.2f} {MY - VB[1]*sc:.2f}) scale({sc:.4f})">'
    f'<g class="ml-ride"><g fill="{CYAN}">{streak_svg}</g><path fill="{LIME}" fill-rule="evenodd" d="{body}"/></g>'
    f'<path fill="{CYAN}" d="{rails}"/></g>\n<!-- mark:end -->')
hp = f"{root}/assets/brand/readme-header.svg"
hs = open(hp).read()
hs = re.sub(r"<!-- mark:start.*?<!-- mark:end -->", lambda m: readme_mark, hs, flags=re.S)
open(hp, "w").write(hs)
