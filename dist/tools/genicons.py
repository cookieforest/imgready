"""Generate the favicon SVG set from the brand mark geometry.

All art lives in the mark's own 0 0 560 450 space and is transformed into
a 64x64 tile, so the icons and the wordmark are literally the same paths.
Change the mark, re-run this, and everything stays in sync.

Optical sizes follow the same split as the wordmark:
  favicon.svg        small cut  (tab strip, 16-20px)
  favicon-large.svg  large cut  (source for 180/192/512 PNGs)
  favicon-maskable   large cut, scaled to clear the 80% safe-zone circle
  safari-pinned-tab  silhouette only, solid black, no features
"""
import io
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

CREAM = "#f9f0e4"   # matches manifest background_color and the page --bg
RUST = "#b84d1d"    # --rust-500, matches theme_color and the wordmark

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


def placement(width):
    """Centre a 560x450 mark of the given width inside a 64x64 tile."""
    scale = width / 560.0
    h = 450 * scale
    return (64 - width) / 2.0, (64 - h) / 2.0, scale


def art(width, features, fur=RUST):
    tx, ty, sc = placement(width)
    fur_paths = "\n".join(f'      <path d="{p}"/>' for p in SILHOUETTE)
    return (f'  <g transform="translate({tx:.3f} {ty:.3f}) scale({sc:.6f})">\n'
            f'    <g fill="{fur}">\n{fur_paths}\n    </g>\n'
            f'    <g fill="{CREAM}">\n{features}\n    </g>\n'
            f'  </g>')


LARGE_FEATURES = "\n".join([
    f'      <path d="{EARIN_L}"/>',
    f'      <path d="{EARIN_R}"/>',
    f'      <path d="{WINK}"/>',
    '      <ellipse cx="373.6" cy="270.4" rx="29.5" ry="37"/>',
    f'      <path d="{NOSE_LG}"/>',
    f'      <path d="{MOUTH}"/>',
    f'      <path d="{TONGUE}"/>',
])

SMALL_FEATURES = "\n".join([
    f'      <path d="{EARIN_L}"/>',
    f'      <path d="{EARIN_R}"/>',
    '      <ellipse cx="186.4" cy="270.4" rx="34" ry="40"/>',
    '      <ellipse cx="373.6" cy="270.4" rx="34" ry="40"/>',
    '      <ellipse cx="280" cy="316" rx="31" ry="24"/>',
])

HDR = ("<!-- GENERATED from the brand mark by scratchpad/genicons.py.\n"
       "     Do not hand-edit. The art is the same 0 0 560 450 path data as\n"
       "     panda-mark.svg / panda-mark-sm.svg, transformed into this tile,\n"
       "     so the icons and the wordmark can never drift apart.\n{extra}  -->")

FILES = {}

FILES["favicon.svg"] = (
    HDR.format(extra=
        "\n     SMALL CUT. Chrome prefers an SVG favicon over the .ico when both\n"
        "     are offered, so this file is what the tab strip actually renders\n"
        "     at 16-20px. At that size the large cut's mouth is 0.6px and its\n"
        "     winking eye dissolves before the open one, leaving a one-eyed\n"
        "     panda, so this carries symmetric eyes and a nose and nothing else.\n")
    + f'\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="imgready">\n'
      f'  <rect width="64" height="64" rx="13" fill="{CREAM}"/>\n'
    + art(52, SMALL_FEATURES) + "\n</svg>\n")

FILES["favicon-large.svg"] = (
    HDR.format(extra=
        "\n     LARGE CUT. Source for apple-touch-icon (180) and the 192/512 PWA\n"
        "     icons. All of those are well above the ~64px the expression needs,\n"
        "     so this is where the wink and the tongue actually pay off.\n")
    + f'\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="imgready">\n'
      f'  <rect width="64" height="64" rx="13" fill="{CREAM}"/>\n'
    + art(52, LARGE_FEATURES) + "\n</svg>\n")

FILES["favicon-maskable.svg"] = (
    HDR.format(extra=
        "\n     MASKABLE. Full-bleed square on purpose: Android applies its own\n"
        "     mask, so baking our own corners in would show a rounded rect\n"
        "     inside another one. Art is narrowed to 42 units so the silhouette\n"
        "     clears the 80% safe-zone circle (radius 25.6 from centre).\n")
    + f'\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="imgready">\n'
      f'  <rect width="64" height="64" fill="{CREAM}"/>\n'
    + art(42, LARGE_FEATURES) + "\n</svg>\n")

_tx, _ty, _sc = placement(52)
FILES["safari-pinned-tab.svg"] = (
    "<!-- GENERATED by scratchpad/genicons.py. Safari pinned-tab mask: it\n"
    "     wants a single-layer 100% black silhouette on transparent and\n"
    "     tints it itself with the colour on <link rel=\"mask-icon\">, so all\n"
    "     fur colour is dropped and only the outline survives. Solid shapes\n"
    "     only, no even-odd knockout. -->\n"
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n'
    f'  <g transform="translate({_tx:.3f} {_ty:.3f}) scale({_sc:.6f})" fill="#000000">\n'
    + "\n".join(f'    <path d="{p}"/>' for p in SILHOUETTE)
    + "\n  </g>\n</svg>\n")

for name, body in FILES.items():
    with io.open(os.path.join(ROOT, name), "w", encoding="utf-8", newline="") as fh:
        fh.write(body)
    print("wrote", name, len(body), "bytes")
