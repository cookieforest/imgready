"""Build /ai-image-upscaler/."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from toolpage import build, register  # noqa: E402

TOOL = '''<div class="up">
    <div class="up-left">
      <div class="fv-drop up-drop" id="upDrop" role="button" tabindex="0"
           aria-label="Choose an image to upscale, or drop one here">
        <span class="fv-drop-title" id="upDropTitle">Drop a photo here</span>
        <span class="fv-drop-sub">or <b>choose a file</b>. JPG, PNG or WebP.</span>
        <span class="fv-drop-safe">Upscaled in this tab. Nothing is uploaded.</span>
        <input type="file" id="upInput" accept="image/*" hidden>
      </div>

      <div class="fv-controls">
        <fieldset class="up-set">
          <legend class="pg-lab">Size</legend>
          <div class="up-seg">
            <label><input type="radio" name="upScale" value="2" checked><span>2x</span></label>
            <label><input type="radio" name="upScale" value="4"><span>4x</span></label>
          </div>
        </fieldset>
        <fieldset class="up-set">
          <legend class="pg-lab">Quality</legend>
          <div class="up-seg up-seg-wide">
            <label><input type="radio" name="upQuality" value="fast" checked><span>Fast<small>1 MB model, seconds</small></span></label>
            <label><input type="radio" name="upQuality" value="best"><span>Best<small>49 MB model, minutes</small></span></label>
          </div>
        </fieldset>
        <label class="pg-field">
          <span class="pg-lab">Save as</span>
          <select id="upFormat" class="up-select">
            <option value="auto" selected>Same type as the original</option>
            <option value="image/png">PNG</option>
            <option value="image/jpeg">JPG</option>
            <option value="image/webp">WebP</option>
          </select>
        </label>
        <p class="up-note" id="upNoGpu" hidden>This browser has no WebGPU, so Best is off and Fast runs on the processor, which is slower.</p>
      </div>
      <div class="fv-actions">
        <button type="button" class="pg-btn pg-btn-go" id="upGo" disabled>Upscale</button>
        <button type="button" class="pg-btn" id="upSave" disabled>Download</button>
      </div>
    </div>

    <div class="up-right">
      <div class="up-view" id="upView" hidden>
        <img id="upViewImg" alt="">
        <button type="button" class="pg-btn pg-btn-sm up-hold" id="upHold" hidden aria-pressed="false">Hold to see the original</button>
      </div>
      <p class="fv-idle up-idle" id="upMeta">Pick an image and the size it will come out at shows here.</p>
      <div class="up-bar" id="upBar" hidden><div class="up-bar-fill" id="upBarFill"></div></div>
      <p class="fv-status" id="upStatus" role="status" aria-live="polite">&nbsp;</p>
    </div>
  </div>'''

PROSE = '''<h2>Bigger, without the <span class="hl">blur</span></h2>
<p>Stretching an image in an editor makes every pixel bigger and nothing sharper. This
uses a neural network, trained on pairs of sharp and degraded photos, to rebuild the
detail a larger version would have had: fabric weave, hair, foliage, the grain in
powder-coated metal.</p>
<p>It does not invent new objects. The models here were picked because they stay close
to the original rather than painting in texture that was never there.</p>

<h2>Fast or <span class="hl">best</span></h2>
<p><b>Fast</b> runs a small model (about 1 MB) that handles phone photos and compressed
JPGs well and finishes in seconds. <b>Best</b> runs a much larger transformer model
(about 49 MB) that recovers noticeably more fine detail. It is worth it for product
photos and anything going to print, as long as you have a minute and a recent graphics
card.</p>
<p>We compared eleven upscalers on 18 real photos by shrinking each one, enlarging it
again and measuring how close it came back to the original. Best came out on top for
clean images and for compressed ones. Fast was the best of the quick models.</p>

<h2>Nothing is <span class="hl">uploaded</span></h2>
<p>Most AI upscalers send your photo to a server and charge credits for the GPU time.
Here the model downloads to your browser once, then runs on your own graphics card
through WebGPU. Open the Network tab while it works: after the model, no request
carries your image.</p>

<h2>Model <span class="hl">credits</span></h2>
<p>Fast uses <a href="https://openmodeldb.info/models/2x-NomosUni-span-multijpg-ldl" rel="noopener">2xNomosUni_span_multijpg_ldl</a>
and Best uses <a href="https://openmodeldb.info/models/4x-RealWebPhoto-v4-dat2" rel="noopener">4xRealWebPhoto_v4_dat2</a>,
both by Philip Hofmann and licensed CC BY 4.0. They run on
<a href="https://onnxruntime.ai/" rel="noopener">ONNX Runtime Web</a>.</p>'''

FAQS = [
    ("How much bigger can it make an image?",
     "2x or 4x on each side, so 4 or 16 times the pixels. The output is capped at about "
     "48 megapixels on computers and 16 on iPhone and iPad, because past that the browser "
     "runs out of memory."),
    ("Why does Best take so long?",
     "It is a transformer model with about 11 million parameters, running in your browser "
     "rather than on a data-centre GPU. On a recent graphics card expect roughly a minute "
     "per megapixel of input. The model downloads once and stays cached."),
    ("Does it work on a phone?",
     "Fast does, on phones with WebGPU (recent Android Chrome and iOS 26 Safari). Best is "
     "heavy for a phone; a laptop or desktop is the better place for it."),
    ("Will it fix a blurry photo?",
     "It helps with softness from compression and small size. It cannot recover a photo "
     "that is badly out of focus or motion blurred, and it will not add detail that was "
     "never captured."),
    ("Is my image uploaded?",
     "No. The model file is downloaded from this site, then everything runs in this tab. "
     "Your image never leaves your device."),
]

RELATED = [
    ("/resize/", "Resize", "Make images smaller, exactly"),
    ("/", "Compress and convert", "The main tool"),
    ("/exif-viewer/", "EXIF viewer", "See and strip photo metadata"),
    ("/favicon-generator/", "Favicon generator", "Every icon from one image"),
]

n = build(
    slug="ai-image-upscaler",
    title="AI Image Upscaler: 2x and 4x, Free, No Upload | imgready",
    desc=("Upscale photos 2x or 4x with an AI model that runs in your browser. Sharper "
          "detail than resizing, no account, no credits, and the image never leaves "
          "your device."),
    h1="Upscale a photo, <em>in your browser</em>",
    lede=("2x or 4x with a neural network running on your own graphics card. No upload, "
          "no account, no credits."),
    tool=TOOL, prose=PROSE, faqs=FAQS, related=RELATED,
    script="upscale_engine.js",
    og_desc="AI upscaling, 2x or 4x, that runs on your own GPU. Nothing is uploaded.",
)
register("ai-image-upscaler", priority="0.8")
print("wrote ai-image-upscaler/index.html", n, "bytes")
