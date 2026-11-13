#!/usr/bin/env python3
"""Alternate launcher icons (Settings > Appearance > App icon): one geometry, many colourways.

Run from anywhere:  python3 scripts/build-app-icons.py
Reads the train geometry from scripts/build-logo.py (only the part above its file writes is executed),
draws the pixel M from the cell grids below, and writes text only into assets/app-icons/:

  drawable/ic_launcher_alt_<rid>_fg.xml     VectorDrawable 108dp, the artwork, transparent
  drawable/ic_launcher_alt_<rid>_bg.xml     VectorDrawable 108dp, the tile
  drawable/ic_launcher_alt_<rid>_mono.xml   VectorDrawable 108dp, white, for Android 13 themed icons
  mipmap-anydpi-v26/ic_launcher_alt_<rid>.xml   <adaptive-icon> (bg + fg + monochrome), API 26+
  mipmap-anydpi/ic_launcher_alt_<rid>.xml       API 24-25 fallback: ONE vector (tile + artwork), 48dp,
                                                cropped to the middle 72 of 108 so it fills the icon
  previews.ts                                   the same artwork as path data for react-native-svg

<rid> is the icon id with "-" turned into "_" (Android resource names cannot contain "-").
plugins/withAppIcons.js copies drawable/ and the two mipmap folders into android/app/src/main/res at prebuild.
Output is deterministic: running it twice changes nothing.

Why a single vector for API 24-25: those versions cannot read <adaptive-icon>. A launcher icon there is
any drawable, and a vector is a few KB with no density buckets (no PNGs in the repo). minSdk is 24, where
VectorDrawable and android:fillType (evenOdd) both exist.
"""
import json, math, os, re, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.path.join(ROOT, "assets", "app-icons")

# ---- train geometry, straight from the repo script -------------------------------------------
src = open(os.path.join(ROOT, "scripts/build-logo.py")).read()
src = src[: src.index("LIME, CYAN, VOID =")]
g = {"__name__": "logo_geom"}
_argv = sys.argv
sys.argv = ["build-logo.py", "/nonexistent"]
exec(compile(src, "build-logo.py(geometry)", "exec"), g)
sys.argv = _argv
BODY, LINES_D, RAILS, GHOST, FXC = g["body"], g["lines"], g["rails"], g["ghost"], g["FX_COMPACT"]

# ---- colour helpers --------------------------------------------------------------------------
def _rgb(h):
    h = h.lstrip("#"); return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
def blend(fg, bg, o):
    f, b = _rgb(fg), _rgb(bg)
    return "#" + "".join(f"{round(255 * (o * x + (1 - o) * y)):02X}" for x, y in zip(f, b))

# ---- path helpers ----------------------------------------------------------------------------
def verts(d):
    """Vertices of an absolute M/H/V/Z path."""
    pts, x, y = [], 0.0, 0.0
    for cmd, nums in re.findall(r"([MHVZ])([^MHVZ]*)", d):
        n = [float(v) for v in nums.replace(",", " ").split()]
        if cmd == "M": x, y = n[0], n[1]
        elif cmd == "H": x = n[-1]
        elif cmd == "V": y = n[-1]
        if cmd != "Z": pts.append((x, y))
    return pts
def rect(x, y, w, h):
    return f"M{x:g} {y:g} H{x + w:g} V{y + h:g} H{x:g} Z"
def fit(ds, radius, centre=(54, 54)):
    """Scale + translate so every vertex lies within `radius` of the centre (108 box)."""
    p = [v for d in ds for v in verts(d)]
    xs, ys = [a for a, _ in p], [b for _, b in p]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    r = max(math.hypot(a - cx, b - cy) for a, b in p)
    s = radius / r
    return s, centre[0] - cx * s, centre[1] - cy * s

def parse_tf(tf):
    """'translate(a b) scale(k) translate(c d)' -> (s, tx, ty) so that x' = s*x + tx, y' = s*y + ty."""
    s, tx, ty = 1.0, 0.0, 0.0
    for name, args in re.findall(r"(translate|scale)\(([^)]*)\)", tf or ""):
        v = [float(a) for a in args.replace(",", " ").split()]
        if name == "translate":
            tx += s * v[0]; ty += s * (v[1] if len(v) > 1 else 0.0)
        else:
            s *= v[0]
    return s, tx, ty

def num(v, places):
    t = f"{v:.{places}f}".rstrip("0").rstrip(".")
    return "0" if t in ("", "-0") else t

def bake(d, s, tx, ty, places=2):
    """Apply x' = s*x + tx to an absolute M/H/V/Z path (uniform scale keeps H and V axis-aligned)."""
    out = []
    for cmd, nums in re.findall(r"([MHVZ])([^MHVZ]*)", d):
        n = [float(v) for v in nums.replace(",", " ").split()]
        if cmd == "M": out.append(f"M{num(s * n[0] + tx, places)} {num(s * n[1] + ty, places)}")
        elif cmd == "H": out.append(f"H{num(s * n[-1] + tx, places)}")
        elif cmd == "V": out.append(f"V{num(s * n[-1] + ty, places)}")
        else: out.append("Z")
    return " ".join(out)

# ---- cell grids (pixel M, keycap) ------------------------------------------------------------
def cells_path(rows, u, ox=0.0, oy=0.0, ch="X"):
    """Union of grid cells as one path: one rect per horizontal run."""
    out = []
    for r, row in enumerate(rows):
        c = 0
        while c < len(row):
            if row[c] == ch:
                e = c
                while e < len(row) and row[e] == ch: e += 1
                out.append(rect(ox + c * u, oy + r * u, (e - c) * u, u)); c = e
            else: c += 1
    return " ".join(out)
def inset_rows(width, insets, ch="X"):
    return ["." * i + ch * (width - 2 * i) + "." * i for i in insets]

M_ROWS = ["XX....XX",
          "XXX..XXX",
          "XXXXXXXX",
          "XX.XX.XX",
          "XX....XX",
          "XX....XX",
          "XX....XX"]

# ---- icon builders: each returns (layers, mono) ----------------------------------------------
# layers: list of (fill, d, evenodd, transform) in 108 coords. mono: list of (d, evenodd, transform).
def train(tile, body, lines, rails=None, radius=32.0):
    rails = rails or lines
    s, tx, ty = fit([BODY, LINES_D, RAILS], radius)
    tf = f"translate({tx:.3f} {ty:.3f}) scale({s:.4f})"
    layers = [(body, BODY, True, tf), (lines, LINES_D, False, tf), (rails, RAILS, False, tf)]
    return layers, [(BODY, True, tf), (RAILS, False, tf)]

def train_nose(tile, body, lines):
    # The front of the train, big, running in from the left edge. Nose tip inside the safe circle.
    s = 1.25
    tx, ty = 86 - 115 * s, 54 - 64.1 * s
    tf = f"translate({tx:.3f} {ty:.3f}) scale({s:.4f})"
    layers = [(body, BODY, True, tf), (lines, RAILS, False, tf), (lines, LINES_D, False, tf)]
    return layers, [(BODY, True, tf), (RAILS, False, tf)]

def train_dash(tile, body, lines):
    # Peak frame of the compact dash loop: long trails and two stepped afterimages, flattened to solids.
    s, tx, ty = fit([BODY, RAILS], 31.0)
    tf = f"translate({tx:.3f} {ty:.3f}) scale({s:.4f})"
    layers = []
    after = FXC["after"]
    for j in reversed(range(len(after))):
        dx, o = after[j][0]
        if o > 0:
            layers.append((blend(body, tile, o), GHOST, False, f"{tf} translate({dx:g} 0)"))
    core = []
    for sp in FXC["sprites"]:
        x, w, o = sp["frames"][0]
        if o <= 0 or w <= 0: continue
        d = rect(x, sp["y"], w, sp["h"])
        layers.append((lines if o >= 1 else blend(lines, tile, o), d, False, tf))
        if o >= 1: core.append(d)
    layers += [(body, BODY, True, tf), (lines, RAILS, False, tf)]
    return layers, [(BODY, True, tf), (RAILS, False, tf), (" ".join(core), False, tf)]

def m_bare(tile, m, radius=29.0):
    d = cells_path(M_ROWS, 1)
    s, tx, ty = fit([d], radius)
    tf = f"translate({tx:.3f} {ty:.3f}) scale({s:.4f})"
    return [(m, d, False, tf)], [(d, False, tf)]

KEY_U = 3.25
KEY_OUTER = inset_rows(16, [2, 1] + [0] * 12 + [1, 2])
KEY_SIDE = ["." + r + "." for r in inset_rows(14, [2, 1] + [0] * 10 + [1, 2])]
KEY_FACE = [".." + r + ".." for r in inset_rows(12, [1] + [0] * 9 + [1])]   # rows 2..12
def m_keycap(tile, outline, side, face, m):
    u, o = KEY_U, 54 - 8 * KEY_U
    outer = cells_path(KEY_OUTER, u, o, o)
    sidep = cells_path(KEY_SIDE, u, o, o + u)
    facep = cells_path(KEY_FACE, u, o, o + 2 * u)
    mp = cells_path(M_ROWS, u, o + 4 * u, o + 4 * u)        # M centred on the face (cols 4..11, rows 4..10)
    layers = []
    if outline: layers.append((outline, outer, False, ""))
    layers += [(side, outer if not outline else sidep, False, ""), (face, facep, False, ""), (m, mp, False, "")]
    # Themed icon: the cap as a frame with the M inside.
    ring = outer + " " + cells_path(KEY_SIDE, u, o, o + u)
    return layers, [(ring, True, ""), (mp, False, "")]

# ---- the catalogue: the 20 icons the owner chose, in picker order -----------------------------
TEAL, VOID, CARD, BORDER, MUTED = "#0B2A30", "#05070A", "#0D1117", "#1F2937", "#8B949E"
LIME, CYAN = "#A5FB48", "#01E5EF"
ICONS = [
    # id, tile, builder
    ("teal", TEAL, lambda t: train(t, LIME, CYAN)),
    ("all-dark", VOID, lambda t: train(t, LIME, CYAN)),
    ("lime", LIME, lambda t: train(t, TEAL, "#00626B")),
    ("cyan", CYAN, lambda t: train(t, TEAL, "#05070A")),
    ("mono", CARD, lambda t: train(t, MUTED, MUTED)),
    ("mono-black", VOID, lambda t: train(t, "#E9EEF2", "#E9EEF2")),
    ("mono-white", "#F3F4F1", lambda t: train(t, VOID, VOID)),
    ("mono-gray", MUTED, lambda t: train(t, VOID, VOID)),
    ("m-keycap-teal", TEAL, lambda t: m_keycap(t, None, "#5E9A1F", LIME, TEAL)),
    ("m-keycap-lime", LIME, lambda t: m_keycap(t, VOID, "#123B42", TEAL, LIME)),
    ("m-keycap-light", "#E7ECE3", lambda t: m_keycap(t, TEAL, "#B9C6B6", "#FFFFFF", TEAL)),
    ("m-keycap-mono", BORDER, lambda t: m_keycap(t, None, "#9AA3AD", "#E6EAEE", VOID)),
    ("m-keycap-cyan", VOID, lambda t: m_keycap(t, None, "#008C94", CYAN, VOID)),
    ("m-bare-lime", LIME, lambda t: m_bare(t, VOID)),
    ("m-bare-teal", TEAL, lambda t: m_bare(t, LIME)),
    ("m-bare-mono", VOID, lambda t: m_bare(t, "#E9EEF2")),
    ("nose", TEAL, lambda t: train_nose(t, LIME, CYAN)),
    ("dash", VOID, lambda t: train_dash(t, LIME, CYAN)),
    ("crt", "#06140B", lambda t: train(t, "#4DFF7C", "#22B455")),
    ("amber", "#1A1206", lambda t: train(t, "#FFB000", "#FF7A1A")),
]
IDS = [i[0] for i in ICONS]
SCANLINES = {"crt": "#0B2214"}

def rid(icon_id):
    return icon_id.replace("-", "_")
def name(icon_id):
    return f"ic_launcher_alt_{rid(icon_id)}"

def tile_layers(icon_id, tile):
    """Background layers: the 108 tile (and for CRT its scanlines) as (fill, d, evenodd, transform)."""
    out = [(tile, "M0 0H108V108H0Z", False, "")]
    if icon_id in SCANLINES:
        out.append((SCANLINES[icon_id], " ".join(rect(0, y, 108, 1.5) for y in range(0, 108, 4)), False, ""))
    return out

# ---- VectorDrawable writers ------------------------------------------------------------------
NS = 'xmlns:android="http://schemas.android.com/apk/res/android"'
def n3(v):
    return num(v, 3)

def vd_path(fill, d, eo, indent):
    ft = ' android:fillType="evenOdd"' if eo else ""
    return f'{indent}<path android:fillColor="{fill}"{ft} android:pathData="{d}"/>\n'

def vd_layers(layers, indent="    "):
    """Layers as <path> (no transform) or <group> + <path> (translate + uniform scale)."""
    out = ""
    for fill, d, eo, tf in layers:
        if not tf:
            out += vd_path(fill, d, eo, indent)
            continue
        s, tx, ty = parse_tf(tf)
        out += (f'{indent}<group android:translateX="{n3(tx)}" android:translateY="{n3(ty)}" '
                f'android:scaleX="{num(s, 5)}" android:scaleY="{num(s, 5)}">\n'
                f'{vd_path(fill, d, eo, indent + "    ")}{indent}</group>\n')
    return out

def vd(layers, size_dp=108, viewport=108, inner_translate=0):
    head = (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by scripts/build-app-icons.py. Do not edit. -->\n'
            f'<vector {NS}\n    android:width="{size_dp}dp"\n    android:height="{size_dp}dp"\n'
            f'    android:viewportWidth="{viewport}"\n    android:viewportHeight="{viewport}">\n')
    if inner_translate:
        body = (f'    <group android:translateX="{inner_translate}" android:translateY="{inner_translate}">\n'
                f'{vd_layers(layers, "        ")}    </group>\n')
    else:
        body = vd_layers(layers)
    return head + body + "</vector>\n"

def adaptive(r):
    return (f'<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by scripts/build-app-icons.py. Do not edit. -->\n'
            f'<adaptive-icon {NS}>\n'
            f'    <background android:drawable="@drawable/ic_launcher_alt_{r}_bg" />\n'
            f'    <foreground android:drawable="@drawable/ic_launcher_alt_{r}_fg" />\n'
            f'    <monochrome android:drawable="@drawable/ic_launcher_alt_{r}_mono" />\n'
            f'</adaptive-icon>\n')

# ---- previews.ts -----------------------------------------------------------------------------
def preview_layers(layers):
    out = []
    for fill, d, eo, tf in layers:
        s, tx, ty = parse_tf(tf)
        out.append((fill, bake(d, s, tx, ty) if tf else bake(d, 1, 0, 0), eo))
    return out

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)

def main():
    for sub in ("drawable", "mipmap-anydpi", "mipmap-anydpi-v26"):
        d = os.path.join(OUT, sub)
        if os.path.isdir(d):
            for fn in os.listdir(d):
                if fn.startswith("ic_launcher_alt_"):
                    os.remove(os.path.join(d, fn))
    previews = {}
    total = 0
    for icon_id, tile, build in ICONS:
        layers, mono = build(tile)
        r, base = rid(icon_id), name(icon_id)
        bg = tile_layers(icon_id, tile)
        mono_layers = [("#FFFFFF", d, eo, tf) for d, eo, tf in mono]
        files = {
            f"drawable/{base}_fg.xml": vd(layers),
            f"drawable/{base}_bg.xml": vd(bg),
            f"drawable/{base}_mono.xml": vd(mono_layers),
            f"mipmap-anydpi-v26/{base}.xml": adaptive(r),
            # API 24-25: tile + artwork in one 48dp vector whose viewport is the middle 72 of 108.
            f"mipmap-anydpi/{base}.xml": vd(bg + layers, size_dp=48, viewport=72, inner_translate=-18),
        }
        for rel, text in files.items():
            write(os.path.join(OUT, rel), text)
            total += len(text.encode())
        previews[icon_id] = preview_layers(bg + layers)

    ts = ["// Generated by scripts/build-app-icons.py. Do not edit.\n",
          "// Preview artwork for Settings > Appearance > App icon, in the same 108 x 108 space as the launcher\n",
          "// icons. Transforms are baked in, so a preview is plain <Path> elements. These colours belong to the\n",
          "// icons themselves, not to the app theme.\n\n",
          "/** One filled path: [fill, path data, evenodd]. */\n",
          "export type PreviewLayer = readonly [fill: string, d: string, evenOdd: boolean];\n\n",
          "/** The part of the 108 square a launcher shows (the middle 72). Draw each preview with this viewBox. */\n",
          "export const APP_ICON_PREVIEW_VIEWBOX = '18 18 72 72';\n\n",
          "export const APP_ICON_PREVIEWS: Readonly<Record<string, readonly PreviewLayer[]>> = {\n"]
    for icon_id, layers in previews.items():
        ts.append(f"  '{icon_id}': [\n")
        for fill, d, eo in layers:
            ts.append(f"    ['{fill}', '{d}', {'true' if eo else 'false'}],\n")
        ts.append("  ],\n")
    ts.append("};\n")
    text = "".join(ts)
    write(os.path.join(OUT, "previews.ts"), text)
    print(f"{len(ICONS)} icons, {total} bytes of XML, previews.ts {len(text.encode())} bytes")

if __name__ == "__main__":
    main()
