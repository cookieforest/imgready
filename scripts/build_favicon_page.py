"""Build /favicon-generator/."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from toolpage import build, register  # noqa: E402

TOOL = '''<div class="fv">
    <div class="fv-left">
      <div class="fv-drop" id="fvDrop" role="button" tabindex="0"
           aria-label="Choose a source image, or drop one here">
        <span class="fv-drop-title">Drop your logo here</span>
        <span class="fv-drop-sub">or <b>choose a file</b>. Square works best. SVG or 512px and up.</span>
        <span class="fv-drop-safe">Rendered in this tab. Nothing is uploaded.</span>
        <input type="file" id="fvInput" accept="image/*" hidden>
      </div>

      <div class="fv-controls">
        <label class="pg-field">
          <span class="pg-lab">Site name <small>(goes in the manifest)</small></span>
          <input type="text" id="fvName" value="icon" maxlength="40">
        </label>
        <div class="fv-row">
          <label class="pg-field fv-col">
            <span class="pg-lab">Background</span>
            <input type="color" id="fvBg" value="#ffffff">
          </label>
          <label class="fv-check">
            <input type="checkbox" id="fvTransparent" checked>
            Keep transparency where allowed
          </label>
        </div>
        <div class="pg-slider">
          <span class="pg-lab">Padding <b id="fvPadV">0</b>%</span>
          <input type="range" id="fvPad" min="0" max="30" value="0">
        </div>
        <div class="pg-slider">
          <span class="pg-lab">Corner radius <b id="fvRadiusV">0</b>%</span>
          <input type="range" id="fvRadius" min="0" max="50" value="0">
        </div>
      </div>
    </div>

    <div class="fv-right">
      <h3 class="fv-h">How it will actually look</h3>
      <div class="fv-preview" id="fvPreview"></div>
      <p class="fv-status" id="fvStatus" role="status" aria-live="polite">&nbsp;</p>
      <div class="fv-actions">
        <button type="button" class="pg-btn pg-btn-go" id="fvGo" disabled>Download the pack</button>
        <button type="button" class="pg-btn" id="fvCopy">Copy the HTML</button>
      </div>
      <div class="fv-snippet" id="fvSnippetBox" hidden>
        <p class="pg-lab">Paste this into your &lt;head&gt;</p>
        <pre id="fvSnippet"></pre>
      </div>
    </div>
  </div>'''

PROSE = '''<h2>One image in, the <span class="hl">whole</span> set out</h2>
<p>A favicon stopped being one file years ago. A site that wants to look right
everywhere needs an ICO for browser tabs and Windows, a 96px PNG that Google shows
next to search results, a 180px apple-touch-icon for the iOS home screen, 192 and
512px PNGs for Android and the PWA manifest, and a maskable variant so Android's
adaptive icon shaping does not crop the logo. Then it needs a manifest file and four
lines of HTML wired up correctly.</p>
<p>This produces all of it from one source image, as a ZIP, with a README explaining
what each file is for and a snippet you can paste straight into your head.</p>

<h2>The 16 pixel <span class="hl">problem</span></h2>
<p>Almost every favicon tool previews your icon at a comfortable size. The place it
actually has to work is a 16 pixel browser tab, which is roughly the size of this
full stop and is where detailed logos turn into mud.</p>
<p>So the preview shows 16px at its real size, in a mock tab, next to your site name.
If it does not read there, it does not work, and you want to find that out now rather
than after deploying. Padding and a corner radius are there because the usual fix is
to simplify the mark and give it room.</p>

<h2>Maskable icons, <span class="hl">briefly</span></h2>
<p>Android does not show your icon as you supplied it. It crops it to whatever shape
the launcher uses: a circle, a squircle, a rounded square. Anything outside a circle
covering about 80% of the canvas can be cut off, which is why logos that reach the
edges lose their corners.</p>
<p>The maskable file in the pack is rendered at 80% scale on a filled background, so
whatever shape the launcher applies, the whole mark survives.</p>

<h2>Nothing is <span class="hl">uploaded</span></h2>
<p>The well-known favicon generators send your source image to a server to do work a
browser can already do. Every image here is rendered on a canvas in your own tab, the
ICO container is assembled in JavaScript, and the ZIP is built locally. Watch the
Network tab while you generate a pack: no request carries your logo.</p>'''

FAQS = [
    ("What size should my source image be?",
     "512px square or larger, or an SVG. Everything is downscaled from the source, so "
     "a small input means blurry large icons. If you upload something under 512px the "
     "tool says so rather than quietly upscaling it."),
    ("Why is favicon.ico still needed in 2026?",
     "Browsers still request /favicon.ico by default, and Windows uses it for pinned "
     "sites and shortcuts. It is the one file that gets fetched whether you reference "
     "it or not, so leaving it out means a guaranteed 404 in your logs."),
    ("What is a maskable icon?",
     "Android crops home-screen icons to the launcher's shape, which might be a circle "
     "or a squircle. Artwork outside a circle covering about 80% of the canvas gets cut "
     "off. The maskable file in the pack is scaled to fit that safe zone on a filled "
     "background, so nothing is lost whichever shape is applied."),
    ("Does the ICO contain real multiple sizes?",
     "Yes. The .ico holds 16, 32 and 48 pixel images in one container, each stored as "
     "PNG data, which every browser in current use understands. Some generators write "
     "a single size and rename it, which looks wrong when Windows asks for a size that "
     "is not in the file."),
    ("Is my logo uploaded?",
     "No. Canvas rendering, ICO assembly and ZIP packing all happen in this tab. Open "
     "your developer tools, watch the Network tab, and generate a pack: nothing carries "
     "your image."),
]

RELATED = [
    ("/png-to-ico/", "PNG to ICO", "Just the .ico file, nothing else"),
    ("/", "Compress and convert", "The main tool"),
    ("/pattern-generator/", "Pattern generator", "Seamless backgrounds and print textures"),
    ("/exif-viewer/", "EXIF viewer", "See and strip photo metadata"),
]

n = build(
    slug="favicon-generator",
    title="Favicon Generator: ICO, PNG, Manifest, No Upload | imgready",
    desc=("Turn one image into a complete favicon pack: multi-size ICO, Apple touch "
          "icon, Android and maskable PNGs, web manifest and the HTML. Built in your "
          "browser, never uploaded."),
    h1="Every favicon you need, <em>from one image</em>",
    lede=("Multi-size ICO, Apple touch icon, Android and maskable PNGs, the manifest "
          "and the HTML, as one ZIP. With a real 16 pixel preview, because that is "
          "where icons fail."),
    tool=TOOL, prose=PROSE, faqs=FAQS, related=RELATED,
    script="favicon_engine.js", vendor=("/vendor/jszip.min.js",),
    og_desc=("One image in, the whole favicon set out: ICO, Apple touch, Android, "
             "maskable, manifest and HTML. Nothing leaves your browser."),
)
register("favicon-generator", priority="0.8")
print("wrote favicon-generator/index.html", n, "bytes")
