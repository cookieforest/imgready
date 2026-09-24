"""Build /pattern-generator/ on the shared tool-page builder.

WHY THIS FILE WAS REWRITTEN
The previous version assembled the page itself and took its prose by
scraping "everything after .pattern-app" out of the existing page. The
first run replaced .pattern-app with the new .pg tool, so every run after
that found nothing to keep, and the page shipped from commit d8e1481 with
no prose, no FAQ and 197 words in total. It is the same self-reading trap
the landing-page extractor fell into: a builder that takes its input from
its own previous output silently degrades on the second run.

The prose now lives here, authored, like every other tool page. The tool
markup lives in build/parts/pattern_tool.html. Running this twice produces
the same page twice.

The competitive research behind the tool's design (Pattern Monster, Hero
Patterns, MagicPattern, checked live in September 2026) is in the commit
message for d8e1481 and in scripts/pattern_engine.js.
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from toolpage import build, register  # noqa: E402

ROOT = os.path.dirname(HERE)
TOOL = io.open(os.path.join(ROOT, "build", "parts", "pattern_tool.html"),
               encoding="utf-8").read()

PROSE = '''<h2>Why an SVG <span class="hl">pattern</span></h2>
<p>A large JPG or PNG wallpaper costs hundreds of kilobytes, sometimes megabytes. An
SVG tile describing the same pattern is usually under one kilobyte, and the browser
repeats it across any screen size with edges that stay sharp on high-density and 4K
displays. For a website background that is the whole argument.</p>
<p>For print it is a different argument, and that is where most pattern tools stop
being useful. Which is why this one also measures tiles in millimetres.</p>

<h2 id="repeat-types">The four <span class="hl">repeat</span> types</h2>
<p>How a tile repeats changes how a pattern reads far more than the motif does.
Surface designers use four standard layouts, and the web tools in this category
mostly offer only the first.</p>
<dl class="engine-list">
  <dt>Basic</dt>
  <dd>Straight grid, every tile directly beside the last. Honest and even, but the
  grid is easy to see, especially with a strong motif.</dd>
  <dt>Half-drop</dt>
  <dd>Every other column shifts down by half a tile. This is the standard repeat for
  fabric and wallpaper because it breaks up the vertical lines your eye would
  otherwise pick out.</dd>
  <dt>Brick</dt>
  <dd>Every other row shifts across by half a tile, like brickwork. Good for motifs
  that are wider than they are tall.</dd>
  <dt>Mirror</dt>
  <dd>The tile is flipped horizontally and vertically to make a four-way symmetric
  block. It turns almost any motif into something that looks deliberately
  ornamental.</dd>
</dl>

<h2>Sizes that mean something to a <span class="hl">printer</span></h2>
<p>A pixel is not a physical size. A printer, a fabric mill or a print-on-demand
service needs to know how big one tile is in the real world and at what resolution.
Set the tile in millimetres, centimetres or inches, pick a DPI, and the pixel size
is worked out for you: 100 mm at 300 DPI is 1181 pixels, 10 inches at 600 DPI is
6000. Below 300 DPI the tool tells you it may print soft.</p>

<h2>Why rotation only turns in <span class="hl">quarters</span></h2>
<p>Rotating a repeating pattern by an arbitrary angle moves it onto a different grid,
so the tile stops lining up with its neighbours. Measured on a rendered tile, the
mismatch between the left and right edges is zero at 0, 90 and 180 degrees and
clearly visible at anything in between.</p>
<p>Tools with a free angle slider get away with it because they export a flat
picture of the screen rather than a tile that repeats. This one exports a repeating
tile, so it only offers the rotations that keep it repeating.</p>

<h2>Check the seams <span class="hl">yourself</span></h2>
<p>Every pattern generator says "seamless". The preview here is tiled three by
three, so you are looking at the repeat rather than a single swatch, and the seam
toggle draws a line at every tile edge. If a join were wrong you would see it.</p>'''

FAQS = [
    ("Can I use these patterns commercially?",
     "Yes. Everything you generate is yours to use in personal and commercial work, "
     "with no attribution required."),
    ("How do I use the CSS on my website?",
     "Click Copy CSS. You get a background-color, a background-image containing the "
     "tile as an embedded SVG data URI, and a background-size. Paste all three into "
     "your stylesheet and the pattern repeats across the element."),
    ("Is the PNG export good enough to print?",
     "Set the tile size and DPI under Print and fabric size first. At 300 DPI and "
     "above the export is suitable for fabric, wallpaper, wrapping paper and "
     "stationery. The pixel size is shown before you export, so there is no guessing."),
    ("What is a half-drop repeat?",
     "Every other column is shifted down by half a tile. It is the standard layout "
     "for fabric and wallpaper because it hides the grid lines a straight repeat "
     "makes obvious."),
    ("Can I share a pattern I made?",
     "Yes. The address bar updates as you change settings, and Copy link gives you a "
     "URL that reopens the exact same pattern for anyone who opens it."),
    ("Is anything uploaded?",
     "No. Patterns are generated as SVG in your browser and rasterised on a canvas in "
     "the same tab. Nothing is sent anywhere."),
]

RELATED = [
    ("/favicon-generator/", "Favicon generator", "Every icon size from one image"),
    ("/svg-to-png/", "SVG to PNG", "Render any vector at a custom resolution"),
    ("/compress/", "Compress images", "Cut file size without visible loss"),
    ("/tools/", "All tools", "Everything imgready does"),
]

n = build(
    slug="pattern-generator",
    title="Seamless Pattern Generator: SVG & 300 DPI Textures | imgready",
    desc=("Generate seamless SVG patterns with half-drop, brick and mirror repeats, set "
          "the tile size in millimetres or inches up to 600 DPI, and export SVG, PNG, "
          "WebP or JPG. Runs in your browser."),
    h1="Seamless pattern generator, <em>with real print sizes</em>",
    lede=("Half-drop, brick and mirror repeats. Tile size in millimetres or inches at up "
          "to 600 DPI. A tiled proof so you can see for yourself that the seams line up. "
          "Nothing is uploaded."),
    tool=TOOL, prose=PROSE, faqs=FAQS, related=RELATED,
    script="pattern_engine.js",
    og_desc=("Half-drop, brick and mirror repeats, tile size in mm or inches at up to "
             "600 DPI, and a tiled proof so you can see the seams. Runs in your browser."),
)
register("pattern-generator")
print("wrote pattern-generator/index.html", n, "bytes")
