"""Generate the favicon set from the brand mark geometry.

All art lives in the mark's own 0 0 560 450 space and is transformed into
a 64x64 tile, so the icons and the wordmark are literally the same paths.
Change the mark, re-run this, and everything stays in sync. That drift is
not hypothetical: the icons kept the old full-colour mascot for a while
after the wordmark changed, because this used to be a scratchpad one-off.

NO BOX. The face floats; there is no tile behind it. Two consequences,
both handled here:

  1. Features are HOLES cut with a mask, not cream paint. A hole shows
     whatever is behind the icon, so the eyes stay visible on a white tab
     strip AND on a dark one. Painted cream would vanish on white.

  2. No single fill serves both schemes. Measured contrast:

         backdrop                rust-500   rust-200
         white / light tab          5.10       2.63
         Chrome dark tab strip      2.37       4.59
         Chrome dark window         3.16       6.12

     So the SVGs carry a prefers-color-scheme rule and swap to the
     lighter rust on dark. This is only possible because the box is gone
     -- a tiled icon has a fixed backdrop and cannot adapt.

Two places a background survives, because the platform forces one:
  apple-touch-icon  iOS composites transparency onto BLACK, which turns
                    a warm brand icon into a dark one.
  maskable          spec requires full bleed; Android draws its own mask,
                    so a transparent maskable renders as a bare shape.
Both are composited at raster time (see tools/_raster.html), not baked
into the SVGs.

Optical sizes follow the same split as the wordmark, for the same
measured reason -- at 16-20px the large cut's mouth is 0.6px and the
winking eye dissolves before the open one, leaving a one-eyed panda.
"""
import io
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

CREAM = "#f9f0e4"      # manifest background_color and the page --bg
RUST = "#b84d1d"       # --rust-500, matches theme_color and the wordmark
RUST_DARK = "#e8865a"  # --rust-200, the fill on dark backdrops

EAR_L = "M56,16c-22.7,62.7-23.3,127.3-2,194,50.7-29.3,95.3-72.7,134-130C146.7,36,102.7,14.7,56,16Z"
EAR_R = "M504,16c22.7,62.7,23.3,127.3,2,194-50.7-29.3-95.3-72.7-134-130,41.3-44,85.3-65.3,132-64Z"
HEAD = ("M280,40c122,0,222,76,236,174l34,52c-20,62-58,110-120,138-46,20-96,28-150,28s-104-8-150-28"
        "c-62-28-100-76-120-138l34-52c14-98,114-174,236-174Z")
EARIN_L = ("M77.6,156.9c-3.9-13.5-8-33.7-6.7-58.3,1-19,5-34.9,8.9-46.4,7.4.3,19.7,1.6,33.4,7.8,"
           "13.3,6,22.4,14,27.5,19.3-9.9,8.5-20.7,19.1-31.6,31.9-13.8,16.3-24,32.1-31.6,45.7Z")
EARIN_R = ("M482.4,156.9c3.9-13.5,8-33.7,6.7-58.3-1-19-5-34.9-8.9-46.4-7.4.3-19.7,1.6-33.4,7.8-"
           "13.3,6-22.4,14-27.5,19.3,9.9,8.5,20.7,19.1,31.6,31.9,13.8,16.3,24,32.1,31.6,45.7Z")
WINK = ("M155.2,234.5c.8-1,6.1,2.2,17.8,9.1,11.4,6.7,28.1,17,50.3,30.9-48.4,21.5-73.2,31.1-74.3,"
        "28.7-1-1.9,13.9-11.9,44.6-29.8-20-18-40-36.9-38.4-38.9Z")
NOSE_LG = ("M307.1,305.8c1,2,1.1,3.9,1.1,4.4.3,10-14.7,17-18,18.6-5.6,2.7-9,2.8-10.6,2.7-1.9,0-4.5-.4-9-2.4-"
           "3.3-1.5-19.2-8.8-18.8-18.9,0-2.5,1.1-4.3,1.5-5,8.1-13.9,47-12.9,53.8.6Z")
MOUTH = ("M247.7,345.4c.5-1.4,14.8,6.6,36.1,4.9,18.5-1.5,30-9.3,30.6-8,.7,1.4-12.5,13.4-30.2,15.1-"
         "20.1,1.9-37.1-10.5-36.5-12Z")
TONGUE = ("M282.6,352.9c-4.9,22.1,7.1,39.9,20,41.8,9.8,1.4,20.5-6.2,24.8-15.9,5.4-12.3.7-28-12.3-36.8-"
          "4.7,1.6-9.4,3.2-14.1,4.7,3.1,2.9,7.2,7.6,9.6,14.6,4,11.6,1,23.5-.4,23.5-1.1,0-.7-8.5-5.2-20.8-"
          "2.6-7-5.7-12.4-8-15.9-4.8,1.6-9.7,3.3-14.5,4.9Z")

SILHOUETTE = [EAR_L, EAR_R, HEAD]

LARGE_FEATURES = [
    EARIN_L, EARIN_R, WINK, NOSE_LG, MOUTH, TONGUE,
]
LARGE_ELLIPSES = ['<ellipse cx="373.6" cy="270.4" rx="29.5" ry="37"/>']

SMALL_FEATURES = [EARIN_L, EARIN_R]
SMALL_ELLIPSES = [
    '<ellipse cx="186.4" cy="270.4" rx="34" ry="40"/>',
    '<ellipse cx="373.6" cy="270.4" rx="34" ry="40"/>',
    '<ellipse cx="280" cy="316" rx="31" ry="24"/>',
]


def placement(width):
    """Centre a 560x450 mark of the given width inside a 64x64 tile."""
    scale = width / 560.0
    return (64 - width) / 2.0, (64 - 450 * scale) / 2.0, scale


def art(width, paths, ellipses, scheme_aware=True):
    tx, ty, sc = placement(width)
    fur = "\n".join('        <path d="%s"/>' % p for p in SILHOUETTE)
    cut = "\n".join('        <path d="%s"/>' % p for p in paths)
    cut += ("\n" if cut and ellipses else "")
    cut += "\n".join("        " + e for e in ellipses)

    style = ""
    if scheme_aware:
        style = (
            "  <style>\n"
            "    .fur{fill:%s;}\n"
            "    @media (prefers-color-scheme:dark){.fur{fill:%s;}}\n"
            "  </style>\n" % (RUST, RUST_DARK)
        )
    paint = 'class="fur"' if scheme_aware else 'fill="%s"' % RUST

    return (
        style
        + '  <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">\n'
        + '    <g transform="translate(%.3f %.3f) scale(%.6f)">\n' % (tx, ty, sc)
        + '      <g fill="#fff">\n%s\n      </g>\n' % fur
        + '      <g fill="#000">\n%s\n      </g>\n' % cut
        + "    </g>\n"
        + "  </mask>\n"
        + '  <rect width="64" height="64" %s mask="url(#m)"/>' % paint
    )


HDR = """<!-- GENERATED from the brand mark by tools/genicons.py.
     Do not hand-edit. The art is the same 0 0 560 450 path data as
     panda-mark.svg / panda-mark-sm.svg, transformed into this tile, so
     the icons and the wordmark can never drift apart.
{extra}  -->"""

OPEN = '\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="imgready">\n'

FILES = {}

FILES["favicon.svg"] = (
    HDR.format(extra="""
     SMALL CUT, no box. Chrome prefers an SVG favicon over the .ico when
     both are offered, so this file is what the tab strip actually
     renders at 16-20px. At that size the large cut's mouth is 0.6px and
     its winking eye dissolves before the open one, leaving a one-eyed
     panda, so this carries symmetric eyes and a nose and nothing else.

     The features are holes, and the fill flips on prefers-color-scheme:
     rust-500 is 5.10 on a white tab strip but only 2.37 on Chrome's dark
     one, where rust-200 gets 4.59.
""")
    + OPEN + art(56, SMALL_FEATURES, SMALL_ELLIPSES) + "\n</svg>\n")

FILES["favicon-large.svg"] = (
    HDR.format(extra="""
     LARGE CUT, no box. Referenced by the manifest, and the source for
     the apple-touch and PWA PNGs. All of those are well above the
     ~64px the expression needs, so this is where the wink and the
     tongue actually pay off.

     Deliberately NOT scheme-aware, unlike favicon.svg. This file gets
     rasterised, and a prefers-color-scheme rule bakes whichever scheme
     the rendering browser happened to be in. That shipped once: every
     PNG came out in the dark-mode salmon instead of the brand rust.
     tools/_raster.html now asserts the rendered fur colour.
""")
    + OPEN + art(56, LARGE_FEATURES, LARGE_ELLIPSES, scheme_aware=False) + "\n</svg>\n")

FILES["favicon-maskable.svg"] = (
    HDR.format(extra="""
     MASKABLE. The one variant that keeps a full-bleed background: the
     spec requires it and Android draws its own mask, so a transparent
     maskable would render as a bare shape with nothing behind it.
     Corners are square on purpose: baking our own rounding in would
     show a rounded rect inside Android's.

     Art is narrowed to 42 units so the silhouette clears the 80%
     safe-zone circle. Verified by pixel scan, not by eye: it reaches
     0.720 of the half-width against a 0.800 limit.
""")
    + OPEN
    + '  <rect width="64" height="64" fill="%s"/>\n' % CREAM
    + art(42, LARGE_FEATURES, LARGE_ELLIPSES, scheme_aware=False)
    + "\n</svg>\n")

_tx, _ty, _sc = placement(56)
FILES["safari-pinned-tab.svg"] = (
    "<!-- GENERATED by tools/genicons.py. Safari pinned-tab mask: Safari\n"
    "     wants a single-layer 100% black silhouette on transparent and\n"
    '     tints it itself with the colour on <link rel="mask-icon">, so all\n'
    "     fur colour is dropped and only the outline survives. Solid shapes\n"
    "     only, no even-odd knockout. -->\n"
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
    + '  <g transform="translate(%.3f %.3f) scale(%.6f)" fill="#000000">\n' % (_tx, _ty, _sc)
    + "\n".join('    <path d="%s"/>' % p for p in SILHOUETTE)
    + "\n  </g>\n</svg>\n")

def _check_comments(name, body):
    """An XML comment may not contain a double hyphen. A standalone SVG is
    parsed strictly, so one "--" in a comment makes the whole file fail to
    load, silently, in every browser. This has bitten this project three
    times now, so it is asserted rather than remembered."""
    i = 0
    while True:
        a = body.find("<!--", i)
        if a == -1:
            return
        b = body.find("-->", a)
        inner = body[a + 4:b]
        if "--" in inner:
            bad = inner[max(0, inner.find("--") - 40):inner.find("--") + 40]
            raise SystemExit(
                "%s: '--' inside an XML comment, file would not parse.\n"
                "  near: ...%s..." % (name, bad.replace("\n", " ")))
        i = b + 3


if __name__ == "__main__":
    for name, body in FILES.items():
        _check_comments(name, body)
        with io.open(os.path.join(ROOT, name), "w", encoding="utf-8", newline="") as fh:
            fh.write(body)
        print("wrote", name, len(body), "bytes")
