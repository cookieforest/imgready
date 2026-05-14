/* imgready-worker.js — image processing off the main thread.
 *
 * Classic worker (not a module worker) so we can use importScripts() for
 * libheif/UPNG/pako (which ship as classic globals, not ES modules) AND
 * dynamic import() for jsquash WebP/AVIF (which only ship as ES modules).
 * Dynamic import() in classic workers has been supported in Chrome 80+,
 * Firefox 89+, and Safari 15+ — universal coverage for any user we care about.
 *
 * Loaded from the main thread as:
 *   new Worker('/imgready-worker.js')
 *
 * Receives File/Blob inputs, decodes (HEIC/TIFF/native via createImageBitmap),
 * runs resize+crop on OffscreenCanvas, encodes via the right path for each
 * format, and posts the resulting Blob back. The main thread stays free to
 * render, scroll, accept new drops, and handle cancellation while heavy
 * encoding runs.
 */

// libheif / UPNG / pako self-hosted from /vendor/. Same bytes as the cdnjs
// originals (verified by SHA-384 hashes maintained in the main HTML's <script>
// integrity attributes) — moved on-origin so the worker doesn't depend on
// third-party CDN uptime for image decoding. Same-origin loads also dodge the
// CORS preflight that occasionally bit older browsers' worker importScripts().
const LIBHEIF_URL = '/vendor/libheif.js';
const UPNG_URL    = '/vendor/UPNG.min.js';
const PAKO_URL    = '/vendor/pako.min.js';
// jsquash WebP/AVIF/JPEG/OxiPNG loaded from esm.sh. The previous self-host
// attempt referenced /vendor/jsquash/*.mjs but those binaries were never
// committed to the repo, which broke encoding on every format. Reverted to
// esm.sh until we ship a real, verified vendor bundle.
//
// esm.sh bundles each package's WASM sidecar alongside the .mjs and loads it
// via `new URL('xyz.wasm', import.meta.url)`, so it works in classic workers
// using dynamic import().
const WEBP_ESM    = 'https://esm.sh/@jsquash/webp@1.5.0?bundle';
const AVIF_ESM    = 'https://esm.sh/@jsquash/avif@2.1.0?bundle';
const JPEG_ESM    = 'https://esm.sh/@jsquash/jpeg@1.5.0?bundle';   // MozJPEG — better than canvas.toBlob('image/jpeg')
const OXIPNG_ESM  = 'https://esm.sh/@jsquash/oxipng@2.3.0?bundle';

let libheifModule = null;
let upngLoaded = false;
let webpEncode = null;
let avifEncode = null;
let jpegEncode = null;
let oxipngOptimise = null;

const CROP_RATIOS = { 'none': null, '1:1': 1, '4:3': 4/3, '3:4': 3/4, '16:9': 16/9, '9:16': 9/16 };

/* ---------- file detection ---------- */
function getExt(name){ return (name||'').split('.').pop().toLowerCase(); }
function isHeic(file){ const e = getExt(file.name); return e==='heic' || e==='heif' || file.type==='image/heic' || file.type==='image/heif'; }
function isTiff(file){ const e = getExt(file.name); return e==='tif' || e==='tiff' || file.type==='image/tiff'; }
function isSvg(file){ const e = getExt(file.name); return e==='svg' || file.type==='image/svg+xml'; }

/* ---------- lazy loaders ---------- */
async function ensureLibheif(){
  if (libheifModule) return libheifModule;
  importScripts(LIBHEIF_URL);
  let lib = self.libheif;
  if (!lib) throw new Error('libheif not available after importScripts');
  if (typeof lib === 'function') {
    lib = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('libheif init timeout')), 30000);
      lib({ onRuntimeInitialized: function(){ clearTimeout(to); res(this); } });
    });
  } else if (lib.then) {
    lib = await lib;
  }
  if (!lib.HeifDecoder && self.HeifDecoder) lib.HeifDecoder = self.HeifDecoder;
  if (!lib.HeifDecoder) throw new Error('HeifDecoder missing after libheif init');
  libheifModule = lib;
  return lib;
}

async function ensureUPNG(){
  if (upngLoaded) return;
  /* UPNG.min.js's UMD footer is `typeof module!=='undefined'?module.exports=e:window.UPNG=e`
     which throws ReferenceError in classic workers (no `window`, no `module`). Shim
     `window = self` before importScripts so the assignment lands on the worker scope.
     Same trick libheif and several other UMD bundles need. */
  if (typeof self.window === 'undefined') self.window = self;
  importScripts(PAKO_URL, UPNG_URL);
  upngLoaded = true;
}

async function ensureWebp(){
  if (webpEncode) return webpEncode;
  const m = await import(WEBP_ESM);
  webpEncode = m.encode;
  return webpEncode;
}

async function ensureAvif(){
  if (avifEncode) return avifEncode;
  const m = await import(AVIF_ESM);
  avifEncode = m.encode;
  return avifEncode;
}

async function ensureJpeg(){
  if (jpegEncode) return jpegEncode;
  const m = await import(JPEG_ESM);
  jpegEncode = m.encode;
  return jpegEncode;
}

/* gifenc loader — quantize + apply-palette + GIF encoder. ~13KB ESM.
   Used only when input is an animated GIF and output is GIF. */
const GIFENC_ESM = 'https://esm.sh/gifenc@1.0.3?bundle';
let gifencMod = null;
async function ensureGifenc(){
  if (!gifencMod) gifencMod = await import(GIFENC_ESM);
  return gifencMod;
}

async function ensureOxipng(){
  if (oxipngOptimise) return oxipngOptimise;
  const m = await import(OXIPNG_ESM);
  /* esm.sh has changed @jsquash/oxipng's export shape between releases.
     Surface a regression here at load-time instead of letting it fail at the
     call site as "undefined is not a function" — that's a much harder bug to
     trace once it's in the wild. */
  const fn = m.optimise || m.default;
  if (typeof fn !== 'function') {
    throw new Error('@jsquash/oxipng module did not export `optimise` or `default` (got: '+Object.keys(m).join(',')+')');
  }
  oxipngOptimise = fn;
  return oxipngOptimise;
}

/* ---------- HEIC decode → ImageBitmap ---------- */
async function decodeHeic(file){
  const lib = await ensureLibheif();
  const buf = await file.arrayBuffer();
  const dec = new lib.HeifDecoder();
  const data = dec.decode(new Uint8Array(buf));
  if (!data || !data.length) throw new Error('No images in HEIC file');
  const img = data[0];
  const w = img.get_width(), h = img.get_height();
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  await new Promise((res, rej) => {
    img.display(id, function(d){
      if (!d) return rej(new Error('HEIC decode failed'));
      ctx.putImageData(id, 0, 0);
      res();
    });
  });
  return await c.transferToImageBitmap();
}

/* ---------- TIFF decode ---------- */
async function decodeTiff(file){
  // Try native createImageBitmap first (Chrome handles many TIFFs)
  try {
    return await createImageBitmap(file);
  } catch (e) { /* fall through to manual parser */ }
  const buf = await file.arrayBuffer();
  const canvas = parseTiff(buf);
  return await canvas.transferToImageBitmap();
}

function parseTiff(B){
  const dv = new DataView(B), le = dv.getUint16(0) === 0x4949;
  const r16 = o => dv.getUint16(o, le);
  const r32 = o => dv.getUint32(o, le);
  if (r16(2) !== 42) throw new Error('Invalid TIFF');
  const io = r32(4), n = r16(io), T = {};
  for (let i = 0; i < n; i++) {
    const e = io + 2 + i*12, tag = r16(e), ty = r16(e+2), cnt = r32(e+4);
    let v;
    if (cnt * ({1:1,2:1,3:2,4:4,5:8}[ty] || 4) <= 4) {
      v = ty===3 ? r16(e+8) : r32(e+8);
      if (cnt > 1 && ty === 3) v = [r16(e+8), r16(e+10)];
    } else {
      const o = r32(e+8);
      v = [];
      for (let j = 0; j < cnt; j++) v.push(ty===3 ? r16(o+j*2) : r32(o+j*4));
    }
    T[tag] = v;
  }
  const w = T[256] || 0, h = T[257] || 0, comp = T[259] || 1, ph = T[262] || 2, spp = T[277] || 1;
  const bv = T[258], bps = Array.isArray(bv) ? bv[0] : (bv || 8);
  const offs = Array.isArray(T[273]) ? T[273] : [T[273] || 0];
  const cnts = Array.isArray(T[279]) ? T[279] : [T[279] || 0];
  if (!w || !h) throw new Error('Invalid TIFF dimensions');
  if (comp !== 1 && comp !== 5 && comp !== 32773) throw new Error('Unsupported TIFF compression: ' + comp);

  let raw;
  if (comp === 1) {
    let t = 0;
    for (let ci = 0; ci < cnts.length; ci++) t += cnts[ci];
    raw = new Uint8Array(t);
    let p = 0;
    for (let si = 0; si < offs.length; si++) {
      raw.set(new Uint8Array(B, offs[si], cnts[si]), p);
      p += cnts[si];
    }
  } else if (comp === 32773) {
    const oo = [];
    for (let s = 0; s < offs.length; s++) {
      const src = new Int8Array(B, offs[s], cnts[s]);
      let ii = 0;
      while (ii < src.length) {
        const nn = src[ii++];
        if (nn >= 0) for (let jj = 0; jj <= nn && ii < src.length; jj++) oo.push(src[ii++] & 0xff);
        else if (nn !== -128) {
          const vv = src[ii++] & 0xff;
          for (let kk = 0; kk < 1 - nn; kk++) oo.push(vv);
        }
      }
    }
    raw = new Uint8Array(oo);
  } else {
    raw = decodeLZW(B, offs, cnts);
  }

  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const px = id.data, bS = Math.ceil(bps/8);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y*w + x) * 4;
      const sii = (y*w + x) * spp * bS;
      if (spp >= 3) {
        px[di] = raw[sii] || 0;
        px[di+1] = raw[sii+1] || 0;
        px[di+2] = raw[sii+2] || 0;
        px[di+3] = spp >= 4 ? (raw[sii+3] !== undefined ? raw[sii+3] : 255) : 255;
      } else {
        const val = raw[sii] || 0;
        const gg = ph === 0 ? 255-val : val;
        px[di] = px[di+1] = px[di+2] = gg;
        px[di+3] = 255;
      }
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function decodeLZW(B, offs, cnts){
  const out = [];
  for (let s = 0; s < offs.length; s++) {
    const src = new Uint8Array(B, offs[s], cnts[s]);
    let bp = 0, cs = 9;
    function rd(){
      let c = 0;
      for (let i = 0; i < cs; i++) {
        const bi = (bp+i) >> 3, bt = 7 - ((bp+i) & 7);
        if (bi < src.length) c = (c<<1) | ((src[bi] >> bt) & 1);
      }
      bp += cs;
      return c;
    }
    let tbl = [];
    function rst(){ tbl = []; for (let i = 0; i < 258; i++) tbl[i] = i < 256 ? [i] : []; cs = 9; }
    rst();
    let code = rd();
    if (code !== 256) continue;
    rst();
    let old = rd();
    if (old === 257) continue;
    if (tbl[old]) for (let b = 0; b < tbl[old].length; b++) out.push(tbl[old][b]);
    while (true) {
      code = rd();
      if (code === 257 || bp > src.length*8 + 16) break;
      if (code === 256) {
        rst();
        code = rd();
        if (code === 257) break;
        if (tbl[code]) for (let b2 = 0; b2 < tbl[code].length; b2++) out.push(tbl[code][b2]);
        old = code;
        continue;
      }
      let entry;
      if (code < tbl.length && tbl[code]) entry = tbl[code];
      else if (code === tbl.length) entry = tbl[old] ? tbl[old].concat([tbl[old][0]]) : [0];
      else break;
      for (let b3 = 0; b3 < entry.length; b3++) out.push(entry[b3]);
      if (tbl[old]) tbl.push(tbl[old].concat([entry[0]]));
      if (tbl.length >= (1 << cs) && cs < 12) cs++;
      old = code;
    }
  }
  return new Uint8Array(out);
}

/* ---------- decode dispatch ---------- */
async function decodeToBitmap(file){
  if (isHeic(file)) return await decodeHeic(file);
  if (isTiff(file)) return await decodeTiff(file);
  if (isSvg(file)) throw new Error('SVG decoding stays on main thread');
  return await createImageBitmap(file);
}

/* ---------- quality → color count for PNG-8 ---------- */
function qualityToColors(q){
  if (q >= 1.0) return 0;
  if (q >= 0.85) return 256;
  if (q >= 0.70) return 128;
  if (q >= 0.55) return 64;
  if (q >= 0.40) return 32;
  return 16;
}

/* ---------- animated GIF detection + encode ---------- */

/* Probe a GIF blob with ImageDecoder. Reads the file into an
   ArrayBuffer so frameCount is FINAL when tracks.ready resolves —
   with a streaming input, frameCount grows over time and reading
   it too early returns 1 even for animated GIFs.
   Returns { frameCount, buffer } so encodeAnimatedGif can reuse the
   same buffer instead of reading the file twice. */
async function getGifFrameCount(file){
  if (typeof ImageDecoder !== 'function') return { frameCount: 1, buffer: null };
  try {
    const buffer = await file.arrayBuffer();
    const decoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
    await decoder.tracks.ready;
    const t = decoder.tracks.selectedTrack;
    const n = t ? t.frameCount : 1;
    try { decoder.close(); } catch(_){}
    return { frameCount: n || 1, buffer };
  } catch (_) {
    return { frameCount: 1, buffer: null };
  }
}

/* Map quality (0..1) → { paletteSize, frameSkip, dither } for animated
   GIFs. Logarithmic-ish curve: palette drops faster than frame skip
   so users still get smooth animation at lower quality. */
function gifQualityParams(q){
  q = Math.max(0, Math.min(1, q ?? 0.85));
  let paletteSize, frameSkip, dither;
  if (q >= 0.85)      { paletteSize = 256; frameSkip = 1; dither = true;  }
  else if (q >= 0.65) { paletteSize = 192; frameSkip = 1; dither = true;  }
  else if (q >= 0.50) { paletteSize = 128; frameSkip = 1; dither = false; }
  else if (q >= 0.35) { paletteSize = 96;  frameSkip = 2; dither = false; }
  else if (q >= 0.20) { paletteSize = 64;  frameSkip = 3; dither = false; }
  else                { paletteSize = 32;  frameSkip = 4; dither = false; }
  return { paletteSize, frameSkip, dither };
}

/* Multi-frame GIF encoder. Applies same crop+resize to every frame.
   Returns a Blob (image/gif) on success, throws on unsupported. */
async function encodeAnimatedGif(file, settings, prereadBuffer){
  if (typeof ImageDecoder !== 'function') {
    throw new Error('ImageDecoder unsupported');
  }
  /* gifenc bundle exports only `default` from esm.sh; the named
     re-export claim in the wrapper doesn't actually carry through.
     Read from mod.default with mod fallback so we don't crash. */
  const mod = await ensureGifenc();
  const G = (mod && mod.default) ? mod.default : mod;
  const GIFEncoder = G.GIFEncoder, quantize = G.quantize, applyPalette = G.applyPalette;
  if (!GIFEncoder || !quantize || !applyPalette) {
    throw new Error('gifenc exports not found');
  }
  /* ArrayBuffer input — guarantees ImageDecoder has parsed the whole
     file before tracks.ready resolves, so frameCount is final and
     decode({frameIndex:i}) works for every i up to frameCount-1.
     Reuse prereadBuffer if the caller already loaded it. */
  const buffer = prereadBuffer || await file.arrayBuffer();
  const decoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const frameCount = track.frameCount;
  if (!frameCount || frameCount < 2) {
    /* Single-frame GIF — fall back to canvas path */
    try { decoder.close(); } catch(_){}
    throw new Error('NotAnimated');
  }
  /* Decode frame 0 to discover source dimensions, then derive output
     dimensions via the same crop/resize logic processOne uses. */
  const r0 = await decoder.decode({ frameIndex: 0 });
  let srcW = r0.image.displayWidth, srcH = r0.image.displayHeight;
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  const ratio = CROP_RATIOS[settings.crop || 'none'];
  if (ratio) {
    if (srcW/srcH > ratio) { sw = Math.round(srcH*ratio); sx = Math.round((srcW-sw)/2); }
    else                   { sh = Math.round(srcW/ratio); sy = Math.round((srcH-sh)/2); }
  }
  let outW = sw, outH = sh;
  if (settings.maxDim) {
    const longest = Math.max(outW, outH);
    if (longest > settings.maxDim) {
      const scale = settings.maxDim / longest;
      outW = Math.round(outW*scale); outH = Math.round(outH*scale);
    }
  } else if (settings.resizePct && settings.resizePct > 0 && settings.resizePct < 100) {
    const scale = settings.resizePct / 100;
    outW = Math.max(1, Math.round(outW*scale));
    outH = Math.max(1, Math.round(outH*scale));
  }
  r0.image.close && r0.image.close();

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  /* Quality params from the slider */
  const q = (settings.quality !== undefined) ? settings.quality : 0.85;
  const { paletteSize, frameSkip, dither } = gifQualityParams(q);

  const enc = GIFEncoder();
  /* Composite buffer — handles "do not dispose" frames where a frame
     overlays the previous instead of fully replacing it. ImageDecoder
     applies disposal automatically when decoding by frameIndex from 0,
     so we just paint each decoded frame onto a fresh canvas. */
  for (let i = 0; i < frameCount; i += frameSkip) {
    const result = await decoder.decode({ frameIndex: i });
    const frame = result.image;
    ctx.clearRect(0, 0, outW, outH);
    /* drawImage with explicit srcRect handles crop; explicit dstRect
       handles resize. Both in one call. */
    ctx.drawImage(frame, sx, sy, sw, sh, 0, 0, outW, outH);
    const id = ctx.getImageData(0, 0, outW, outH);
    const palette = quantize(id.data, paletteSize);
    const indexed = applyPalette(id.data, palette);
    /* VideoFrame.duration is in microseconds (or null). Sum the
       durations of skipped frames so the playback timing stays
       roughly accurate when frames are dropped. */
    let durationUs = frame.duration || 100000;
    for (let k = 1; k < frameSkip && i+k < frameCount; k++) {
      try {
        const pk = await decoder.decode({ frameIndex: i+k });
        durationUs += pk.image.duration || 100000;
        pk.image.close && pk.image.close();
      } catch (_) {}
    }
    enc.writeFrame(indexed, outW, outH, {
      palette,
      delay: Math.max(20, Math.round(durationUs / 1000)),
      dispose: 2,
      transparent: false
    });
    frame.close && frame.close();
  }
  enc.finish();
  try { decoder.close(); } catch(_){}
  return new Blob([enc.bytes()], { type: 'image/gif' });
}

/* ---------- the main encode pipeline ---------- */
async function processOne(file, fmt, settings){
  /* Animated GIF → GIF: preserve frames + apply quality-driven palette
     / frame-skip reduction. Bails on any error to the single-frame path
     so we never block on browser quirks. */
  if (fmt === 'gif' && file && file.type === 'image/gif') {
    try {
      const probe = await getGifFrameCount(file);
      if (probe.frameCount > 1) {
        return await encodeAnimatedGif(file, settings, probe.buffer);
      }
    } catch (e) {
      /* fall through to single-frame canvas path below */
    }
  }
  const bmp = await decodeToBitmap(file);
  let w = bmp.width, h = bmp.height, sx = 0, sy = 0, sw = w, sh = h;

  // Crop from center
  const ratio = CROP_RATIOS[settings.crop || 'none'];
  if (ratio) {
    if (w/h > ratio) { sw = Math.round(h*ratio); sx = Math.round((w-sw)/2); }
    else             { sh = Math.round(w/ratio); sy = Math.round((h-sh)/2); }
    w = sw; h = sh;
  }

  // Resize longest side OR percent — only one of maxDim/resizePct will
  // be non-zero (getSettings on the main thread enforces that).
  if (settings.maxDim) {
    const longest = Math.max(w, h);
    if (longest > settings.maxDim) {
      const scale = settings.maxDim / longest;
      w = Math.round(w*scale); h = Math.round(h*scale);
    }
  } else if (settings.resizePct && settings.resizePct > 0 && settings.resizePct < 100) {
    const scale = settings.resizePct / 100;
    w = Math.max(1, Math.round(w*scale));
    h = Math.max(1, Math.round(h*scale));
  }

  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');

  // White background for JPG output (since JPG has no alpha)
  if (fmt === 'jpg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close();

  const q = settings.quality;

  if (fmt === 'avif') {
    const enc = await ensureAvif();
    const id = ctx.getImageData(0, 0, w, h);
    const buf = await enc(id, { quality: Math.round((q ?? 0.5) * 100) });
    return new Blob([buf], { type: 'image/avif' });
  }

  if (fmt === 'webp') {
    const enc = await ensureWebp();
    const id = ctx.getImageData(0, 0, w, h);
    const buf = await enc(id, { quality: Math.round((q ?? 0.82) * 100) });
    return new Blob([buf], { type: 'image/webp' });
  }

  if (fmt === 'png') {
    /* PNG path:
       - Q < 1.0: lossy quantization via UPNG (PNG-8). Already small, fast.
       - Q = 1.0: lossless via canvas.convertToBlob.
       OxiPNG is opt-in via settings.extraOptimize. It's a strong size win
       (~30%) but adds ~600ms per image — measured user-noticeable on
       larger batches. Default is OFF; user can flip it on when they care
       about size more than speed. */
    if (q !== undefined && q < 1.0) {
      await ensureUPNG();
      const id = ctx.getImageData(0, 0, w, h);
      const cnum = qualityToColors(q);
      let pngBuf = self.UPNG.encode([id.data.buffer], w, h, cnum);
      if (settings.extraOptimize) {
        try {
          const optimise = await ensureOxipng();
          const opt = await optimise(pngBuf, { level: 2, interlace: false });
          if (opt && opt.byteLength < pngBuf.byteLength) pngBuf = opt;
        } catch (e) { /* keep un-optimized */ }
      }
      return new Blob([pngBuf], { type: 'image/png' });
    }
    /* Lossless PNG */
    if (settings.extraOptimize) {
      const blob = await c.convertToBlob({ type: 'image/png' });
      const buf = await blob.arrayBuffer();
      try {
        const optimise = await ensureOxipng();
        const opt = await optimise(buf, { level: 2, interlace: false });
        if (opt && opt.byteLength < buf.byteLength) return new Blob([opt], { type: 'image/png' });
      } catch (e) { /* keep un-optimized */ }
      return new Blob([buf], { type: 'image/png' });
    }
    return await c.convertToBlob({ type: 'image/png' });
  }

  if (fmt === 'jpg') {
    /* MozJPEG (jsquash) typically produces 10-25% smaller files than
       canvas.toBlob('image/jpeg') at the same visual quality. We try it
       first and fall back to canvas if the WASM fails to load — never
       break the user's batch on an encoder upgrade. */
    try {
      const enc = await ensureJpeg();
      const id = ctx.getImageData(0, 0, w, h);
      /* MozJPEG quality is 0-100, our slider is 0-1. */
      const buf = await enc(id, {
        quality: Math.round((q ?? 0.82) * 100),
        progressive: true,    /* progressive JPGs render top-down on slow connections */
        optimize_coding: true /* Huffman optimization — small extra savings */
      });
      return new Blob([buf], { type: 'image/jpeg' });
    } catch (e) {
      /* Fallback path — canvas.toBlob is universally supported */
      return await c.convertToBlob({ type: 'image/jpeg', quality: q });
    }
  }

  if (fmt === 'gif') {
    return await c.convertToBlob({ type: 'image/gif' });
  }

  if (fmt === 'ico') {
    /* ICO encoder: PNG-in-ICO container. Modern Windows, browsers, and
       favicon parsers all accept PNG payloads inside ICO files (the
       legacy BMP-in-ICO format is much larger and less browser-friendly).
       Layout:
         6-byte ICONDIR header
         16-byte ICONDIRENTRY (one image)
         <png data>
       For larger-than-256 dimensions, the byte fields wrap to 0 (= "256+"
       per the ICO spec). Most users want small favicons; if they really
       want a 1024×1024 ICO, our Resize section already lets them set it. */
    const pngBlob = await c.convertToBlob({ type: 'image/png' });
    const pngBuf = new Uint8Array(await pngBlob.arrayBuffer());
    const totalLen = 6 + 16 + pngBuf.length;
    const out = new Uint8Array(totalLen);
    const dv = new DataView(out.buffer);
    /* ICONDIR */
    dv.setUint16(0, 0, true);   // reserved
    dv.setUint16(2, 1, true);   // type 1 = icon
    dv.setUint16(4, 1, true);   // 1 image
    /* ICONDIRENTRY */
    out[6] = w >= 256 ? 0 : w;  // width (0 byte = 256)
    out[7] = h >= 256 ? 0 : h;  // height
    out[8] = 0;                 // colors in palette (0 for true-color)
    out[9] = 0;                 // reserved
    dv.setUint16(10, 1, true);  // color planes
    dv.setUint16(12, 32, true); // bits per pixel
    dv.setUint32(14, pngBuf.length, true);  // image size
    dv.setUint32(18, 22, true); // offset to image (6+16)
    out.set(pngBuf, 22);
    return new Blob([out], { type: 'image/x-icon' });
  }

  throw new Error('Unsupported output format: ' + fmt);
}

/* ---------- worker message handler ---------- */
self.onmessage = async (e) => {
  const { id, action, file, fmt, settings, formats } = e.data;
  /* prewarm: load encoder modules (and instantiate their WASM) without
     doing any actual encoding. The main thread fires this once on idle so
     the user's first drop doesn't pay the WASM cold-start. Best-effort —
     any error is swallowed because the real encode path will retry. */
  if (action === 'prewarm') {
    const list = (formats && formats.length) ? formats : ['webp'];
    for (const f of list) {
      try {
        if (f === 'webp') await ensureWebp();
        else if (f === 'avif') await ensureAvif();
        else if (f === 'jpg' || f === 'jpeg') await ensureJpeg();
        else if (f === 'oxipng') await ensureOxipng();
      } catch (_) { /* swallow — best-effort */ }
    }
    return;
  }
  if (action !== 'process') return;
  try {
    self.postMessage({ id, type: 'progress', stage: 'decoding' });
    const blob = await processOne(file, fmt, settings || {});
    self.postMessage({ id, type: 'result', blob });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err && err.message || err) });
  }
};
/* WORKER_EOF */
