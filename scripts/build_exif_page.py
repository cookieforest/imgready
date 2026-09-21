"""Build /exif-viewer/."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from toolpage import build, register  # noqa: E402

TOOL = '''<div class="ex">
    <div class="ex-drop" id="exDrop" role="button" tabindex="0"
         aria-label="Choose a photo to inspect, or drop one here">
      <span class="ex-drop-title">Drop a photo here</span>
      <span class="ex-drop-sub">or <b>choose a file</b>. JPG, PNG and WebP are read in full.</span>
      <span class="ex-drop-safe">It is read in this tab. Nothing is uploaded.</span>
      <input type="file" id="exInput" accept="image/*" hidden>
    </div>

    <div class="ex-out">
      <div id="exResult" class="ex-result">
        <p class="ex-idle">Pick a photo and every piece of metadata inside it appears
          here: the camera, the settings, the timestamps, and the GPS position if the
          photo carries one.</p>
      </div>
      <div class="ex-actions" id="exActions" hidden>
        <p class="ex-count" id="exCount"></p>
        <button type="button" class="pg-btn pg-btn-go" id="exStrip">Download a clean copy</button>
        <p class="ex-strip-note" id="exStripNote">Removes the metadata without
          re-encoding, so the image quality is untouched.</p>
      </div>
    </div>
  </div>'''

PROSE = '''<h2>What your photos are actually <span class="hl">carrying</span></h2>
<p>A photo from a phone is not just pixels. Alongside the image, the camera writes a
block of metadata called EXIF: which camera took it, the lens, the exposure, the
software that last touched it, the date and time down to the second, and, if location
services were on, the latitude and longitude to about five metres.</p>
<p>That last one is the problem. A photo of something innocuous, taken at home and
posted publicly, can carry the coordinates of your front door. Most social networks
strip EXIF on upload, which has quietly trained people to assume it does not matter.
Email attachments, cloud links, file transfers, marketplace listings and forum posts
usually do not strip anything.</p>

<h2>Why this tool <span class="hl">shows</span> you first</h2>
<p>Most metadata tools only remove. You click a button, you get a file back, and you
learn nothing. You certainly do not learn that the twelve photos you posted last month
had your address in them.</p>
<p>So this one reads the tags out and puts them on the page, with anything that
identifies a person, a place or a device grouped separately and marked. If the photo
has coordinates, you get the coordinates and a link to look at them on a map. Seeing
the actual position of your own house is more persuasive than any warning text.</p>

<h2>Removal without <span class="hl">re-encoding</span></h2>
<p>The usual way to strip metadata in a browser is to draw the image onto a canvas and
save it again. That works, in the sense that the metadata disappears, but it also
throws away the original compressed data and re-compresses from scratch. You lose
quality to accomplish a task that has nothing to do with quality.</p>
<p>This does not do that. In a JPEG the metadata lives in discrete APP segments, and in
a PNG it lives in named chunks that each carry their own checksum. Both can be cut out
while the compressed image data is copied through byte for byte. The file you download
has pixels identical to the one you put in, just smaller and without the metadata.</p>
<p>For formats where that is not possible, convert the file with the
<a href="/">main tool</a> instead: re-encoding drops metadata as a side effect.</p>'''

FAQS = [
    ("Is my photo uploaded to check it?",
     "No. The file is read inside this browser tab with the FileReader API and parsed "
     "in JavaScript. Open your browser developer tools, watch the Network tab, and drop "
     "a photo: you will not see a request carrying it. The only outbound link on the "
     "page is the optional map link, and that only sends coordinates, only if you click it."),
    ("Does removing metadata reduce image quality?",
     "Not for JPEG or PNG. The metadata is cut out of the container and the compressed "
     "image data is copied through unchanged, so the pixels are bit-for-bit identical. "
     "Tools that re-encode through a canvas do lose quality; this one does not."),
    ("What about HEIC photos from an iPhone?",
     "HEIC stores metadata inside an ISO base media container rather than in simple "
     "segments, so lossless stripping is not offered for it here. Converting a HEIC to "
     "JPG with the main tool removes the metadata as part of the conversion."),
    ("Which tags count as identifying?",
     "GPS latitude, longitude and altitude, GPS date and time, artist, copyright, camera "
     "owner, camera and lens serial numbers, the software that edited the file, and the "
     "capture timestamps. Serial numbers matter more than people expect: they link every "
     "photo from one camera together, even across accounts."),
    ("Do social networks not already remove this?",
     "Most large ones do strip EXIF when you upload. Email attachments, direct file "
     "transfers, cloud storage links, classified listings and most forums do not. The "
     "habit of assuming it is handled is exactly what makes it worth checking."),
]

RELATED = [
    ("/", "Compress and convert", "The main tool, for everything else"),
    ("/why/", "Why nothing is uploaded", "How the whole site works"),
    ("/privacy/", "Privacy policy", "What we do and do not collect"),
    ("/heic-to-jpg/", "HEIC to JPG", "Convert iPhone photos, metadata dropped"),
]

n = build(
    slug="exif-viewer",
    title="EXIF Viewer and Metadata Remover, No Upload | imgready",
    desc=("See every piece of metadata in a photo, including the GPS position, then "
          "remove it without re-encoding. Runs entirely in your browser: the photo is "
          "never uploaded."),
    h1="See what your photo is <em>telling people</em>",
    lede=("Every tag your camera wrote, including where the shot was taken. Then remove "
          "it all without touching the image quality. The file never leaves this tab."),
    tool=TOOL, prose=PROSE, faqs=FAQS, related=RELATED,
    script="exif_engine.js",
    og_desc=("Read the EXIF in any photo, see the GPS position on a map, and strip the "
             "metadata losslessly. Nothing is uploaded."),
)
register("exif-viewer", priority="0.8")
print("wrote exif-viewer/index.html", n, "bytes; registered in sitemap and llms.txt")
