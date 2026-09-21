"""Rebuild /pattern-generator/ as a print-capable seamless pattern studio.

WHAT THE COMPETITION ACTUALLY DOES (checked live, September 2026)

  Pattern Monster   460 patterns, MIT. Editor has zoom, horizontal and
                    vertical position, stroke, vertical spacing, angle, up
                    to 5 colours, Pantone, colour search. Every parameter
                    has a LOCK, so "Inspire Me" randomises only what you
                    left unlocked. Copy CSS/SVG, download SVG/PNG at a
                    custom width and height. Has a Pro tier.
  Hero Patterns     ~90 curated patterns, three controls only: foreground
                    colour, background colour, foreground opacity.
  MagicPattern      62 pure-CSS patterns in categories. Colours, fade
                    mask, opacity, size, rotation. Upsells to paid.
  imgready (before) 10 generative patterns, four controls.

WHERE WE CANNOT WIN
  Pattern count. 10 against 460 is not a fight worth having, and adding
  450 shallow presets would make this a worse tool, not a better one.

WHERE NOBODY IS SERVING ANYONE
  1. Physical output. Every one of these is a web-background tool.
     Nobody offers a tile measured in millimetres, a DPI setting, or the
     repeat types that fabric and surface design actually use. The person
     uploading to Spoonflower, printing wrapping paper or building a
     packaging tile has no good option. That is the same shape of gap
     HEIC was for the SDK: the hard, unglamorous case everyone skipped.
  2. Proof. All of them say "seamless". None of them shows you. A tiled
     preview with a seam toggle costs almost nothing and settles it.
  3. Export breadth. We already ship encoders for PNG, WebP, AVIF and
     JPG. Pattern Monster gives PNG. MagicPattern gives CSS.

SO THE DESIGN IS
  - depth per generator instead of breadth of presets: angle, spacing,
    opacity, three colours, and real repeat modes on all ten
  - half-drop, brick and mirror repeats, which is the vocabulary surface
    designers use and which none of the three offers
  - tile size in mm, cm or inches at 72 to 600 DPI, with the pixel size
    shown so there is no guessing
  - a 3x3 tiled proof with a seam toggle
  - the good ideas from the field, adopted openly: per-parameter lock
    plus randomise (Pattern Monster), opacity (Hero Patterns), rotation
    (MagicPattern)
  - a permalink that restores the exact state, which none of them has
"""
import io
import os
import re
from lxml import html as LH

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
SRC = "pattern-generator/index.html"

doc = LH.parse(SRC).getroot()
wrap = doc.xpath('//div[contains(@class,"wrap")]')[0]


def ser(el):
    return LH.tostring(el, encoding="unicode", with_tail=False).strip()


nav = ser(doc.xpath('//nav[contains(@class,"topnav")]')[0])
crumbs = ser(doc.xpath('//div[contains(@class,"crumbs")]')[0])
footer = ser(doc.xpath('//footer[contains(@class,"site-footer")]')[0])
jsonld = [ser(s) for s in doc.xpath('//script[@type="application/ld+json"]')]

# Everything after the old tool that is prose: keep it verbatim.
keep, seen_tool = [], False
for k in wrap:
    if not isinstance(k.tag, str):
        continue
    cl = k.get("class") or ""
    if "pattern-app" in cl:
        seen_tool = True
        continue
    if not seen_tool or "features" in cl or "site-footer" in cl:
        continue
    keep.append(ser(k))
prose = "\n      ".join(keep)

head_old = io.open(SRC, encoding="utf-8").read()
title = re.search(r"<title>([\s\S]*?)</title>", head_old).group(1)
desc = doc.xpath('//meta[@name="description"]/@content')[0]

TOOL = '''<div class="pg">

    <!-- ============ stage ============ -->
    <div class="pg-stage">
      <div class="pg-canvas" id="pgCanvas" role="img"
           aria-label="Seamless pattern preview, tiled three by three"></div>
      <div class="pg-stagebar">
        <label class="pg-toggle"><input type="checkbox" id="pgSeams"> Show tile seams</label>
        <span class="pg-hint">Every tile above is one repeat. Turn the seams on to check the joins.</span>
        <span class="pg-dims" id="pgDims">&nbsp;</span>
      </div>
    </div>

    <!-- ============ controls ============ -->
    <div class="pg-panel">

      <div class="pg-row pg-row-top">
        <button type="button" class="pg-btn pg-btn-go" id="pgRandom"
          title="Randomise every unlocked control">Surprise me</button>
        <button type="button" class="pg-btn" id="pgReset">Reset</button>
      </div>

      <label class="pg-field">
        <span class="pg-lab">Pattern</span>
        <select id="pgStyle">
          <option value="seigaiha">Seigaiha waves</option>
          <option value="topographic">Topographic contours</option>
          <option value="isometricCubes">Isometric cubes</option>
          <option value="moroccanTrellis">Moroccan trellis</option>
          <option value="bauhaus">Bauhaus modern</option>
          <option value="hexagons">Hex honeycomb</option>
          <option value="halftone">Halftone dots</option>
          <option value="sineWaves">Fluid sine waves</option>
          <option value="crosshatch">Crosshatch grid</option>
          <option value="memphis">Memphis confetti</option>
        </select>
      </label>

      <label class="pg-field">
        <span class="pg-lab">Repeat
          <a class="pg-help" href="#repeat-types" title="What these mean">?</a></span>
        <select id="pgRepeat">
          <option value="basic">Basic (straight)</option>
          <option value="halfdrop">Half-drop</option>
          <option value="brick">Brick (half-brick)</option>
          <option value="mirror">Mirror</option>
        </select>
      </label>

      <div class="pg-slider" data-k="scale">
        <span class="pg-lab">Scale <b id="pgScaleV">80</b></span>
        <input type="range" id="pgScale" min="20" max="200" value="80">
        <button type="button" class="pg-lock" data-lock="scale" aria-pressed="false"
                title="Lock: keep this when randomising">Lock</button>
      </div>

      <div class="pg-slider" data-k="stroke">
        <span class="pg-lab">Stroke <b id="pgStrokeV">10</b></span>
        <input type="range" id="pgStroke" min="1" max="40" value="10">
        <button type="button" class="pg-lock" data-lock="stroke" aria-pressed="false" title="Lock">Lock</button>
      </div>

      <label class="pg-field">
        <span class="pg-lab">Rotation
          <button type="button" class="pg-lock" data-lock="angle" aria-pressed="false" title="Lock">Lock</button>
        </span>
        <select id="pgAngle">
          <option value="0">0&deg;</option>
          <option value="90">90&deg;</option>
          <option value="180">180&deg;</option>
          <option value="270">270&deg;</option>
        </select>
        <span class="pg-note">Quarter turns only. Rotating a repeating field by
          anything else lands it on a different lattice, so the tile stops
          repeating. Sliders elsewhere get away with it because they export a
          flat picture rather than a tile.</span>
      </label>

      <div class="pg-slider" data-k="opacity">
        <span class="pg-lab">Opacity <b id="pgOpacityV">100</b>%</span>
        <input type="range" id="pgOpacity" min="5" max="100" value="100">
        <button type="button" class="pg-lock" data-lock="opacity" aria-pressed="false" title="Lock">Lock</button>
      </div>

      <div class="pg-field">
        <span class="pg-lab">Colours
          <button type="button" class="pg-lock" data-lock="colors" aria-pressed="false" title="Lock">Lock</button>
        </span>
        <div class="pg-colors">
          <label title="Background"><input type="color" id="pgBg" value="#f9f0e4"><span>Back</span></label>
          <label title="Main"><input type="color" id="pgFg" value="#b84d1d"><span>Main</span></label>
          <label title="Accent"><input type="color" id="pgAc" value="#3f541b"><span>Accent</span></label>
          <button type="button" class="pg-btn pg-btn-sm" id="pgSwap" title="Swap background and main">Swap</button>
        </div>
      </div>

      <!-- ============ print block: the part nobody else has ============ -->
      <details class="pg-print" id="pgPrintBox">
        <summary>Print and fabric size</summary>
        <p class="pg-note">Set the real-world size of one tile. Screen work can
          ignore this; a printer cannot.</p>
        <div class="pg-print-grid">
          <label class="pg-field">
            <span class="pg-lab">Tile size</span>
            <input type="number" id="pgPhys" value="100" min="1" max="2000" step="1">
          </label>
          <label class="pg-field">
            <span class="pg-lab">Unit</span>
            <select id="pgUnit">
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="in">inches</option>
            </select>
          </label>
          <label class="pg-field">
            <span class="pg-lab">DPI</span>
            <select id="pgDpi">
              <option value="72">72 (screen)</option>
              <option value="150">150 (draft)</option>
              <option value="300" selected>300 (print)</option>
              <option value="600">600 (fine)</option>
            </select>
          </label>
        </div>
        <p class="pg-calc" id="pgCalc">&nbsp;</p>
      </details>

      <!-- ============ export ============ -->
      <div class="pg-export">
        <div class="pg-row">
          <button type="button" class="pg-btn pg-btn-go" id="pgDlSvg">Download SVG</button>
          <select id="pgRaster" aria-label="Raster format">
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
            <option value="jpeg">JPG</option>
          </select>
          <button type="button" class="pg-btn pg-btn-go" id="pgDlRaster">Download</button>
        </div>
        <div class="pg-row">
          <button type="button" class="pg-btn" id="pgCopyCss">Copy CSS</button>
          <button type="button" class="pg-btn" id="pgCopySvg">Copy SVG</button>
          <button type="button" class="pg-btn" id="pgCopyLink">Copy link</button>
        </div>
        <p class="pg-status" id="pgStatus" role="status" aria-live="polite">&nbsp;</p>
      </div>
    </div>
  </div>'''

PAGE = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title}</title>
<link rel="preload" href="/fonts/nunito-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/poetsenone-latin.woff2" as="font" type="font/woff2" crossorigin>
<meta name="description" content="{desc}">
<meta property="og:title" content="Seamless pattern generator with real print sizes">
<meta property="og:description" content="Half-drop, brick and mirror repeats, tile size in mm or inches at up to 600 DPI, and a tiled proof so you can see the seams. Runs entirely in your browser.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://imgready.app/pattern-generator/">
<meta property="og:site_name" content="imgready">
<link rel="canonical" href="https://imgready.app/pattern-generator/">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#b84d1d">
<link rel="stylesheet" href="/app.css">
{chr(10).join(jsonld)}
</head>
<body>
<!-- imgready:standalone-tool -->
<div class="wrap">
  {nav}
  {crumbs}
  <main>
    <header class="page-head">
      <h1>Seamless pattern generator,<em> with real print sizes</em></h1>
      <p class="lede">Half-drop, brick and mirror repeats. Tile size in millimetres or
        inches at up to 600 DPI. A tiled proof so you can see for yourself that the
        seams line up. Nothing is uploaded.</p>
    </header>

    {TOOL}

    <section class="prose">
      {prose}
    </section>
  </main>
  {footer}
</div>
<script src="/app.js" defer></script>
<script>
{io.open(os.path.join(ROOT, "scripts", "pattern_engine.js"), encoding="utf-8").read()}
</script>
</body>
</html>
'''

io.open(SRC, "w", encoding="utf-8", newline="").write(PAGE)
print("wrote", SRC, len(PAGE), "bytes")
