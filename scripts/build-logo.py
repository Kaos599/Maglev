# Run: python3 scripts/build-logo.py "$PWD"  then  node scripts/generate-icons.js
# Maglev mark: the traced train redrawn on a pixel grid (1 unit = 16 px of the 2048 trace).
import sys, json, re
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
# Speed lines: one thickness (1.5), varied lengths, each sitting on a band. (x, y, w)
LINES = [(16, 46.5, 21), (10, 55.5, 23), (18, 67.5, 15), (12, 73.0, 13)]
lines = " ".join(f"M{x:g} {y:g} H{x+w:g} V{y+1.5:g} H{x:g} Z" for (x, y, w) in LINES)

# ---- Dash animation (app + README) -------------------------------------------------------
# One loop of N frames at FPS, so everything stays in step. Every sprite is a rect described per
# frame as [left x, width, opacity] in viewBox units; the group (body + trails) gets [dx, dy].
#  * Trails: each speed line stays pinned to the train and stretches back as three segments
#    (solid, half, faint): a pixel-art fade. Length flickers frame to frame.
#  * Surge: at the top of the loop the train lunges forward and the trails snap out long.
#  * Afterimages: two faint copies of the train's back trail behind it (motion blur).
#  * Wind and ground dashes whip past in a few frames each.
FPS, N = 20, 24
SURGE = [1, 0.85, 0.6, 0.35, 0.15] + [0] * (N - 5)
HUM = [0, -0.5, -0.5, 0, -0.5, 0, -0.5, -0.5] * (N // 8)
JITTER = [1.0, 0.92, 1.06, 0.96, 1.1, 0.9, 1.03, 0.97]
SEGS = [(0.0, 0.45, 1.0), (0.45, 0.75, 0.55), (0.75, 1.0, 0.22)]
q = lambda v: round(v * 2) / 2
def fx():
    sprites = []
    for i, (x, y, w) in enumerate(LINES):
        anchor = x + w
        lengths = [w * (1.6 + 1.1 * SURGE[k]) * JITTER[(k + 3 * i) % len(JITTER)] for k in range(N)]
        for (f0, f1, o) in SEGS:
            fr = [[q(anchor - Lk * f1), q(Lk * (f1 - f0)) or 0.5, o] for Lk in lengths]
            sprites.append({"y": y, "h": 1.5, "ghost": False, "frames": fr})
    # Wind dashes: thin, long, gone in four frames. (y, w, start x, phase)
    for (y, w, x0, ph) in [(51.5, 14, 30, 0), (62.5, 16, 24, 2), (44, 10, 30, 1), (77.25, 12, 20, 3)]:
        fr = []
        for k in range(N):
            t = ((k + ph) % 4) / 4
            fr.append([q(x0 - 70 * t), w, [0.9, 0.7, 0.4, 0.15][int(t * 4)]])
        sprites.append({"y": y, "h": 0.75, "ghost": True, "frames": fr})
    # Ground dashes: under the rails, sweeping the full width (scenery rushing past).
    for (w, ph) in [(10, 0), (6, 3)]:
        fr = []
        for k in range(N):
            t = ((k + ph) % 6) / 6
            fr.append([q(118 - 130 * t), w, 0.6])
        sprites.append({"y": 84.5, "h": 0.75, "ghost": True, "frames": fr})
    group = [[q(1.5 * SURGE[k]), HUM[k]] for k in range(N)]
    # Afterimages flash with the surge and settle to a faint smear.
    after = [[[q(-(3 + 3 * SURGE[k]) - 0.5 * (k % 2)), round(0.1 + 0.25 * SURGE[k], 2)] for k in range(N)],
             [[q(-(7 + 7 * SURGE[k]) - 0.5 * ((k + 1) % 2)), round(0.04 + 0.14 * SURGE[k], 2)] for k in range(N)]]
    return {"ms": round(N * 1000 / FPS), "sprites": sprites, "group": group, "after": after}
AFTER_CLIP_X = 62   # afterimages show only the train's back, never through the window
FX = fx()

def _clip_x(d, xmax):
    """Clip the body's outer outline to x <= xmax. It only has H/V edges, so clamping x is exact."""
    outer = d.split(" Z")[0]
    return re.sub(r"H([\d.]+)", lambda m: f"H{min(float(m.group(1)), xmax):g}", outer) + " Z"
ghost = _clip_x(body, AFTER_CLIP_X)
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
    "/** Dash loop: frames per element. Sprites are [left x, width, opacity]; group is [dx, dy]; afterimages [dx, opacity]. Ghost sprites show only while dashing. */\n"
    f"export const MARK_GHOST = '{ghost}';\n"
    f"export const MARK_FX: {{ ms: number; sprites: {{ y: number; h: number; ghost: boolean; frames: [number, number, number][] }}[]; group: [number, number][]; after: [number, number][][] }} = {json.dumps(FX, separators=(',', ':'))};\n")
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

# README header: the same mark and the same dash loop, as SVG keyframes.
import re
def kf(name, frames, prop):
    ks = "".join(f"{100*k/len(frames):.3f}%{{{prop(f)}}}" for k, f in enumerate(frames)) + f"100%{{{prop(frames[0])}}}"
    return f"@keyframes {name}{{{ks}}}"
ms = FX["ms"]
css = [f".ml-ride{{animation:ml-g {ms}ms steps(1,end) infinite}}",
       kf("ml-g", FX["group"], lambda f: f"transform:translate({f[0]:g}px,{f[1]:g}px)"),
       ".ml-sp{transform-box:fill-box;transform-origin:center}"]
sprite_svg = ""
for i, sp in enumerate(FX["sprites"]):
    x0, w0, _ = sp["frames"][0]
    css.append(f".ml-s{i}{{animation:ml-k{i} {ms}ms steps(1,end) infinite}}")
    css.append(kf(f"ml-k{i}", sp["frames"],
                  lambda f, x0=x0, w0=w0: f"transform:translateX({(f[0] + f[1]/2) - (x0 + w0/2):g}px) scaleX({f[1]/w0:.4g});opacity:{f[2]:g}"))
    sprite_svg += f'<rect class="ml-sp ml-s{i}" x="{x0:g}" y="{sp["y"]:g}" width="{w0:g}" height="{sp["h"]:g}" opacity="0"/>'
after_svg = ""
for j, fr in enumerate(FX["after"]):
    css.append(f".ml-a{j}{{animation:ml-ak{j} {ms}ms steps(1,end) infinite}}")
    css.append(kf(f"ml-ak{j}", fr, lambda f: f"transform:translateX({f[0]:g}px);opacity:{f[1]:g}"))
    after_svg += f'<use class="ml-a{j}" href="#ml-ghost" fill="{LIME}" opacity="0"/>'
css.append("@media (prefers-reduced-motion:reduce){.ml-ride,.ml-ride *{animation:none}.ml-run{display:none}.ml-rest{display:inline}}")
css.append(".ml-rest{display:none}")
H = 76; sc = H / VB[3]; MX, MY = 372, 79
readme_mark = (f'<!-- mark:start (generated by scripts/build-logo.py) -->\n<style>{"".join(css)}</style>\n'
    f'<defs><path id="ml-body" fill-rule="evenodd" d="{body}"/><path id="ml-ghost" d="{ghost}"/></defs>\n'
    f'<g transform="translate({MX - VB[0]*sc:.2f} {MY - VB[1]*sc:.2f}) scale({sc:.4f})">'
    f'<g class="ml-ride ml-run">{after_svg}<g fill="{CYAN}">{sprite_svg}</g><use href="#ml-body" fill="{LIME}"/></g>'
    f'<g class="ml-rest"><path fill="{CYAN}" d="{lines}"/><use href="#ml-body" fill="{LIME}"/></g>'
    f'<path fill="{CYAN}" d="{rails}"/></g>\n<!-- mark:end -->')
hp = f"{root}/assets/brand/readme-header.svg"
hs = open(hp).read()
hs = re.sub(r"<!-- mark:start.*?<!-- mark:end -->", lambda m: readme_mark, hs, flags=re.S)
open(hp, "w").write(hs)