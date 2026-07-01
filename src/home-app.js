
function setState(s){
  document.body.dataset.state = s;
  document.body.dataset.adjust = 'closed';
  document.body.dataset.piActions = 'closed';
  if(s==='multi') requestAnimationFrame(layoutCoverFlow);
}
function toggleAdjust(){
  document.body.dataset.adjust = document.body.dataset.adjust==='open' ? 'closed' : 'open';
}

/* ===== beta: file-based thumb data ===== */
const FILES = [];  // array of { file, url, name, w, h }

/* ===== cover flow state ===== */
const CFLOW = {
  thumbs: [],          // DOM elements
  selected: 0,         // current centered index
  drift: 0,            // fractional drift (during drag/momentum)
  vel: 0,              // velocity (idx/frame)
  draggingFrom: null,
  rafId: null,
  prevSelected: -1,    // last 'committed' selected index (for syncMainImage gating)
  STRIDE: 120,         // px between thumb centers (matches CSS --stride; updated on resize)
};

function init(){
  layoutCoverFlow();
  updateMenuHeight();

  const flow = document.getElementById('coverFlow');
  flow.addEventListener('pointerdown', onPointerDown);
  flow.addEventListener('wheel', onWheel, {passive:false});
  attachHoverDelegation();
  attachScrubberDrag();

  /* Wire the dropzone's file input (#fileInput from production HTML) */
  const fi = document.getElementById('fileInput') || document.getElementById('dzFileInput');
  if (fi) fi.addEventListener('change', onFiles);
  document.getElementById('moreInput').addEventListener('change', onFiles);
  /* Note: paste/drop/dragover listeners + MutationObserver for menu-h are
     wired by the PROD blocks further down (they handle big-batch confirm,
     the full-window drop overlay, and animation-frame menu-h updates).
     The duplicates that used to live here were causing every paste + drop
     to fire twice, double-adding files. Listeners now register exactly
     once and do the right thing for all states. */
  window.addEventListener('resize', updateMenuHeight);
  /* Wire up the empty-batch dropzone (shown when body[data-empty-batch]). */
  const ebDz = document.getElementById('emptyBatchDropzone');
  const ebInput = document.getElementById('emptyBatchInput');
  if (ebInput) {
    ebInput.addEventListener('change', e => {
      if (e.target.files && e.target.files.length) {
        addFilesFromList(e.target.files);
        e.target.value = '';
      }
    });
  }
  if (ebDz) {
    ['dragenter', 'dragover'].forEach(ev => {
      ebDz.addEventListener(ev, e => {
        e.preventDefault();
        ebDz.classList.add('drag');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      ebDz.addEventListener(ev, e => {
        if (ev === 'dragleave' && ebDz.contains(e.relatedTarget)) return;
        ebDz.classList.remove('drag');
      });
    });
    ebDz.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFilesFromList(e.dataTransfer.files);
      }
    });
  }

  /* WASM cold-start pre-warm — defer until idle so it doesn't compete
     with FCP. Worker swallows errors so this is safe.
     R106: derive the prewarm format list from the current URL (?out= or
     ?fmt=) so users coming from a landing page get THEIR encoder
     pre-compiled, not the default WebP. If neither param is set, we
     pre-warm WebP + JPG since those are the two most common output
     formats in practice (covers ~80% of conversions per GSC data). */
  const warm = () => {
    try {
      const qsW = new URLSearchParams(location.search);
      const qsOut = (qsW.get('out') || qsW.get('fmt') || '').toLowerCase();
      let formats = qsOut
        ? qsOut.split(',').map(f => {
            if (f === 'jpeg') return 'jpg';
            if (f === 'png')  return 'oxipng';  // R110: png output uses oxipng encoder
            return f;
          }).filter(Boolean)
        : ['webp', 'jpg'];
      /* The worker prewarm handler accepts: webp, avif, jpg, oxipng.
         Filter to just those — auto/gif/ico don't have an esm.sh
         encoder so passing them would be wasted in the worker's loop.
         png is mapped to oxipng above (the encoder we actually use for
         PNG output). */
      formats = formats.filter(f => f === 'webp' || f === 'avif' || f === 'jpg' || f === 'oxipng');
      if (!formats.length) formats = ['webp'];
      getWorker().postMessage({ action: 'prewarm', formats: formats });
    } catch(_){}
  };
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2500);

  /* Throttled screen-reader announcer. Avoid spamming the SR with
     every per-thumb encode in a 50-file batch — throttle to one
     announcement per 1s, summarising the latest state. */
  let _lastSrText = '', _srThrottle = null;
  window.srAnnounce = function(text){
    if (!text || text === _lastSrText) return;
    _lastSrText = text;
    if (_srThrottle) return;
    _srThrottle = setTimeout(() => {
      const el = document.getElementById('srAnnounce');
      if (el) el.textContent = _lastSrText;
      _srThrottle = null;
    }, 1000);
  };

  /* ====== Keyboard shortcuts overlay ====== */
  const kbModal = document.getElementById('kbShortcuts');
  function isTypingTarget(t){
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }
  function openKbShortcuts(){ if (kbModal) kbModal.hidden = false; }
  function closeKbShortcuts(){ if (kbModal) kbModal.hidden = true; }
  document.addEventListener('keydown', e => {
    if (isTypingTarget(e.target)) return;
    if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
      e.preventDefault();
      if (kbModal && kbModal.hidden) openKbShortcuts(); else closeKbShortcuts();
    } else if (e.key === 'Escape') {
      if (kbModal && !kbModal.hidden) { e.preventDefault(); closeKbShortcuts(); }
    }
  });
  if (kbModal) {
    kbModal.addEventListener('click', e => {
      /* Close on: backdrop click (target === modal itself) OR any
         click anywhere on the close button (closest handles text
         nodes too). */
      if (e.target === kbModal || (e.target.closest && e.target.closest('.kb-shortcuts-close'))) {
        closeKbShortcuts();
      }
    });
  }

  /* ====== Bulk batch progress indicator ====== */
  const batchEl = document.getElementById('batchProgress');
  if (batchEl) {
    const txt = batchEl.querySelector('.batch-progress-text');
    const fill = batchEl.querySelector('.batch-progress-fill');
    window._updateBatchProgress = function(){
      const total = (typeof FILES !== 'undefined') ? FILES.length : 0;
      const done = (typeof ENCODE !== 'undefined' && ENCODE.encoded) ? ENCODE.encoded.size : 0;
      if (total < 2) { batchEl.hidden = true; return; }
      const pct = total ? Math.round(done / total * 100) : 0;
      if (txt) txt.textContent = `Encoding ${done} of ${total}`;
      if (fill) fill.style.width = pct + '%';
      batchEl.hidden = (done >= total);
    };
    /* Tick the progress when anything happens. Re-poll every 600ms
       while there are inflight encodes; idle when none. */
    let _bpTimer = null;
    function tickBatch(){
      window._updateBatchProgress && window._updateBatchProgress();
      const total = (typeof FILES !== 'undefined') ? FILES.length : 0;
      const done = (typeof ENCODE !== 'undefined' && ENCODE.encoded) ? ENCODE.encoded.size : 0;
      if (total >= 2 && done < total) {
        clearTimeout(_bpTimer);
        _bpTimer = setTimeout(tickBatch, 600);
      }
    }
    /* Hook into the existing addFilesFromList + syncMainImage paths
       by polling on any file-list change. Cheap; runs only while
       batching is active. */
    setInterval(() => {
      const total = (typeof FILES !== 'undefined') ? FILES.length : 0;
      if (total >= 2) tickBatch();
    }, 1500);
  }
}

function onFiles(e){
  if (e.target.files && e.target.files.length) {
    addFilesFromList(e.target.files);
    e.target.value = '';
  }
}
/* Inline HEIC decoder — minimal mirror of src/02-decoders.js' decodeHeic,
   needed because the bundled app.js isn't loaded on the live page. Lazily
   loads /vendor/libheif.js (CSP-safe via <script>) on first HEIC encounter,
   then decodes the first frame to a canvas and emits a JPEG File so the
   downstream cover-flow + encoder paths see a renderable blob. */
let _libheifInlineModule = null;
let _libheifInlineLoading = null;
/* libheif is an Emscripten WASM module. window.libheif is the FACTORY
   function — calling new lib.HeifDecoder() on the factory throws.
   Mirror src/02-decoders.js' ensureLibheif: load the script, then if
   window.libheif is a function, invoke it with onRuntimeInitialized to
   get the real module. Stash the resolved module so subsequent calls
   are sync. */
async function _ensureLibheifInline(){
  if (_libheifInlineModule) return _libheifInlineModule;
  if (_libheifInlineLoading) return _libheifInlineLoading;
  _libheifInlineLoading = (async () => {
    /* Step 1 — load the script tag if it isn't on the page yet. */
    if (!window.libheif) {
      await new Promise((res, rej) => {
        const existing = document.querySelector('script[data-libheif-inline]');
        if (existing) {
          existing.addEventListener('load', res);
          existing.addEventListener('error', () => rej(new Error('libheif script load failed')));
          return;
        }
        const s = document.createElement('script');
        s.src = '/vendor/libheif.js';
        s.async = true;
        s.setAttribute('data-libheif-inline','1');
        s.onload = res;
        s.onerror = () => rej(new Error('libheif script load failed'));
        document.head.appendChild(s);
      });
    }
    let lib = window.libheif;
    if (!lib) throw new Error('libheif global missing after load');
    /* Step 2 — if lib is the Emscripten factory, invoke it. The
       module's onRuntimeInitialized callback fires once WASM is ready;
       inside the callback `this` is the module itself. */
    if (typeof lib === 'function') {
      lib = await new Promise((res, rej) => {
        const to = setTimeout(() => rej(new Error('libheif init timeout')), 30000);
        lib({ onRuntimeInitialized: function(){ clearTimeout(to); res(this); } });
      });
    } else if (lib && typeof lib.then === 'function') {
      lib = await lib;
    }
    /* Step 3 — some builds put HeifDecoder on window instead of on the
       module. Patch it across. */
    if (!lib.HeifDecoder && window.HeifDecoder) lib.HeifDecoder = window.HeifDecoder;
    if (!lib.HeifDecoder) {
      /* small grace window in case HeifDecoder is being attached
         asynchronously after onRuntimeInitialized. */
      await new Promise(r => setTimeout(r, 500));
      if (!lib.HeifDecoder && window.HeifDecoder) lib.HeifDecoder = window.HeifDecoder;
    }
    if (!lib.HeifDecoder) throw new Error('HeifDecoder not exposed by libheif build');
    _libheifInlineModule = lib;
    return lib;
  })();
  try { return await _libheifInlineLoading; }
  finally { _libheifInlineLoading = null; }
}
async function _decodeHeicInline(file){
  const lib = await _ensureLibheifInline();
  if (!lib) throw new Error('libheif not available');
  const buf = await file.arrayBuffer();
  const dec = new lib.HeifDecoder();
  const data = dec.decode(new Uint8Array(buf));
  if (!data || !data.length) throw new Error('No images in HEIC');
  const img = data[0];
  const w = img.get_width(), h = img.get_height();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  await new Promise((res, rej) => {
    img.display(id, d => d ? res(d) : rej(new Error('HEIC display failed')));
  });
  ctx.putImageData(id, 0, 0);
  const blob = await new Promise((res, rej) => {
    c.toBlob(b => b ? res(b) : rej(new Error('canvas toBlob failed')), 'image/jpeg', 0.92);
  });
  /* Return the decoded blob (renderable JPEG) + dims so callers can
     keep the ORIGINAL HEIC File for metadata/encoder input while still
     painting the Before pane with the decoded image. */
  return { blob, w, h };
}

async function addFilesFromList(fileList){
  const fresh = [];
  let totalSeen = 0;
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    totalSeen++;
    if (!file.type.startsWith('image/') && !/\.(heic|heif|tiff?|bmp|svg)$/i.test(file.name)) continue;
    /* Exotic formats — browsers can't render the raw blob, so
       URL.createObjectURL(file) gives us a URL that paints nothing.
       For HEIC/HEIF we run an inline libheif decode and use the
       decoded JPEG blob URL. The bundled decoders in src/02-decoders.js
       aren't reachable here because app.js isn't loaded on this page —
       only inline scripts run. TIFF/SVG/BMP fall through to a raw URL
       (broken paint, but the queue entry still registers). */
    const isHeicEntry = /\.(heic|heif)$/i.test(file.name) ||
                        file.type === 'image/heic' || file.type === 'image/heif';
    /* For HEIC keep f.file as the ORIGINAL so the Before meta still reads
       "X MB · HEIC" (user-visible truth) and the encoder still sees the
       HEIC input it knows how to handle. Use the decoded JPEG blob ONLY
       for the URL — that's what the Before pane background-image renders.
       Stash dims from the libheif decode so the metadata corner shows
       correct dimensions without needing createImageBitmap on the HEIC
       (which most browsers can't do). */
    let entryUrl, entryDims = null;
    let decodedBlob = null;
    if (isHeicEntry) {
      try {
        const { blob, w, h } = await _decodeHeicInline(file);
        entryUrl = URL.createObjectURL(blob);
        entryDims = { w, h };
        decodedBlob = blob;   /* Round 11: stash for Edit-mode createImageBitmap */
      } catch (err) {
        console.warn('[heic-decode] failed for', file.name, err);
        entryUrl = URL.createObjectURL(file);
      }
    } else {
      entryUrl = URL.createObjectURL(file);
    }
    const entry = { file, url: entryUrl, name: file.name };
    if (entryDims) entry.dims = entryDims;
    if (decodedBlob) entry.decodedBlob = decodedBlob;
    fresh.push(entry);
  }
  /* Feedback when ALL files were rejected (user dropped non-images).
     Without this the drop appeared to silently no-op. */
  if (totalSeen > 0 && fresh.length === 0) {
    showRejectedToast(totalSeen);
    return;
  }
  if (!fresh.length) return;
  FILES.push(...fresh);
  /* Auto-select the format that matches the dropped file's input MIME.
     Single mode: replaces selection. Multi mode: adds to existing. */
  if (typeof window._presetFormatFromInput === 'function') {
    window._presetFormatFromInput(fresh[0].file);
  }
  buildThumbs();
  /* Always use multi state — the cover flow handles 1 image cleanly
     (one thumb + Add-more) and uses the same image-canvas elements for
     rendering. Solo state had its own separate IDs that never got
     wired to syncMainImage. */
  document.body.dataset.state = 'multi';
  /* Clear empty-batch flag if it was set by a previous doClear. */
  delete document.body.dataset.emptyBatch;
  /* wireZoom is idempotent (data-zoomWired guard) so calling on every drop is safe */
  if (typeof wireZoom === 'function') wireZoom();
  /* Kick off the background encode queue. The selected file is encoded
     first (via syncMainImage's call path) and the rest queue behind it. */
  if (typeof enqueueAll === 'function') setTimeout(enqueueAll, 60);
  if (FILES.length === fresh.length) CFLOW.selected = 0;
  CFLOW.drift = 0;
  layoutCoverFlow();
  CFLOW.prevSelected = -1;
  syncMainImage(true);
}
/* Recompute --menu-h whenever drawer toggles or transitions, so the
   cover-flow + canvas shift up while settings open. Without this the
   cover-flow stayed pinned at the closed-state position and the drawer
   covered it. */
if (typeof window._menuHObserverInstalled === 'undefined') {
  window._menuHObserverInstalled = true;
  let _animTicker = null;
  function _tickMenuH(){
    if (typeof updateMenuHeight === 'function') updateMenuHeight();
  }
  /* On every body data-* change (drawer state, etc), recompute */
  new MutationObserver(_tickMenuH).observe(document.body, {
    attributes:true, attributeFilter:['data-adjust','data-state']
  });
  /* During drawer transition, tick every animation frame so the
     cover-flow eases up smoothly with the drawer expansion. */
  document.addEventListener('transitionrun', e => {
    if (!e.target.classList || !e.target.classList.contains('bb-drawer')) return;
    if (_animTicker) cancelAnimationFrame(_animTicker);
    const loop = () => { _tickMenuH(); _animTicker = requestAnimationFrame(loop); };
    loop();
  });
  document.addEventListener('transitionend', e => {
    if (!e.target.classList || !e.target.classList.contains('bb-drawer')) return;
    if (_animTicker) cancelAnimationFrame(_animTicker);
    _animTicker = null; _tickMenuH();
  });
}

/* ===== Scrubber drag — tap or drag the bottom track to jump thumbs ===== */
function attachScrubberDrag(){
  const scrubber = document.getElementById('cflowScrubber');
  if (!scrubber) return;
  let dragging = false;
  let activePointerId = null;

  function progressFromEvent(e){
    const rect = scrubber.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(1, x / rect.width));
  }
  function applyProgress(p){
    const total = (typeof FILES !== 'undefined') ? FILES.length : 0;
    if (total < 2) return;
    /* Map progress (0..1) to thumb index (0..total-1) */
    const targetIdx = Math.round(p * (total - 1));
    if (targetIdx !== CFLOW.selected) {
      selectIndex(targetIdx);
    } else {
      /* Still update the indicator visually during fine-drag within
         the same thumb cell — layoutCoverFlow re-runs on selectIndex
         but not on no-op clicks. Force a layout to keep thumb live. */
      layoutCoverFlow();
    }
  }
  scrubber.addEventListener('pointerdown', (e) => {
    /* Only respond when there's something to scrub. */
    if (!scrubber.classList.contains('has-many')) return;
    e.preventDefault();
    e.stopPropagation();   // don't let cover-flow's pointerdown fire
    dragging = true;
    activePointerId = e.pointerId;
    scrubber.setPointerCapture(e.pointerId);
    scrubber.classList.add('scrubbing');
    applyProgress(progressFromEvent(e));
  });
  scrubber.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    e.preventDefault();
    applyProgress(progressFromEvent(e));
  });
  function endDrag(e){
    if (!dragging) return;
    if (e && e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
    scrubber.classList.remove('scrubbing');
    try { if (e) scrubber.releasePointerCapture(e.pointerId); } catch(_) {}
  }
  scrubber.addEventListener('pointerup', endDrag);
  scrubber.addEventListener('pointercancel', endDrag);
}

function updateMenuHeight(){
  /* Read the active state's menu-card height and expose as --menu-h.
     Also publish --menu-h-delta: the difference between current menu-h
     and the "closed" baseline. Used to shift the image-canvas up by
     the same amount as the drawer expansion (so the image moves with
     the thumbs, not half as much). */
  const card = document.querySelector('body[data-state="multi"] .stage.multi .menu-card')
            || document.querySelector('body[data-state="solo"] .stage.solo .menu-card');
  if (!card) return;
  const h = card.offsetHeight || 100;
  document.documentElement.style.setProperty('--menu-h', h + 'px');
  /* Baseline = menu-h when settings is closed. Whenever the drawer is
     closed, we treat the current measured height as the new baseline
     (handles resize / state changes that affect the closed-state h). */
  const adjustOpen = document.body.dataset.adjust === 'open';
  if (!adjustOpen) {
    window._baselineMenuH = h;
  }
  const base = window._baselineMenuH || h;
  const delta = Math.max(0, h - base);
  document.documentElement.style.setProperty('--menu-h-delta', delta + 'px');
}
window.addEventListener('DOMContentLoaded', init);
window.addEventListener('resize', layoutCoverFlow);

/* Build thumbs from real files. Each thumb shows the file as a contained
   <img> inside the slot; aspect ratios are preserved with letterboxing. */
function buildThumbs(){
  const track = document.getElementById('cflowTrack');
  Array.from(track.querySelectorAll('.cflow-thumb:not(.clear-all)')).forEach(t=>t.remove()); /* keep static clear-all tile */
  CFLOW.thumbs = [];
  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i];
    const t = document.createElement('div');
    t.className = 'cflow-thumb';
    t.dataset.i = String(i);
    t.dataset.name = f.name;
    t.innerHTML = `
      <div class="thumb-slot">
        <img class="thumb-content-img" src="${f.url}" alt="" loading="lazy">
        <div class="thumb-progress" aria-hidden="true"></div>
      </div>`;
    t.addEventListener('click', e => onThumbClick(i, e));
    /* Drag-out: let users drag the cover-flow thumb to their desktop /
       Finder / Slack / email composer and drop the ENCODED file. Uses
       the HTML5 DownloadURL transfer type (Chrome/Edge/Opera; Firefox
       partial). The dragged blob is the encoded result when available,
       falling back to the original blob. */
    t.draggable = true;
    t.addEventListener('dragstart', ev => {
      try {
        if (!ev.dataTransfer) return;
        const idx = parseInt(t.dataset.i, 10);
        const file = FILES[idx];
        if (!file) return;
        const enc = (typeof ENCODE !== 'undefined' && ENCODE.encoded) ? ENCODE.encoded.get(idx) : null;
        let url, mime, name;
        if (enc && enc.url && enc.blob) {
          url = enc.url;
          mime = enc.blob.type || 'application/octet-stream';
          const base = file.file.name.replace(/\.[^.]+$/, '');
          name = `${base}_imgready.${enc.format}`;
        } else {
          /* Encode hasn't landed yet — drag-out the original so the
             gesture isn't silently broken. */
          url = file.url;
          mime = (file.file && file.file.type) || 'application/octet-stream';
          name = file.file.name || 'image';
        }
        /* Chromium DownloadURL format: "mime:filename:absolute-url".
           Blob URLs are valid here. Firefox/Safari may fall through. */
        ev.dataTransfer.effectAllowed = 'copy';
        ev.dataTransfer.setData('DownloadURL', `${mime}:${name}:${location.origin}${url.startsWith('blob:') ? '' : ''}${url}`);
        /* Fallback for generic drop targets (URL list). */
        ev.dataTransfer.setData('text/uri-list', url);
        ev.dataTransfer.setData('text/plain', name);
      } catch(_) { /* non-fatal */ }
    });
    track.insertBefore(t, document.getElementById('piActions'));
    CFLOW.thumbs.push(t);
  }
  /* Add-more tile at the end */
  const addMore = document.createElement('div');
  addMore.className = 'cflow-thumb add-more';
  addMore.dataset.i = String(FILES.length);
  addMore.innerHTML = `
    <div class="thumb-slot add-more-slot">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      <!-- Add more label removed: thumbnails are 50% smaller now;
               the + icon alone reads clearly without the text. -->
    </div>`;
  addMore.addEventListener('click', () => document.getElementById('moreInput').click());
  track.insertBefore(addMore, document.getElementById('piActions'));
  CFLOW.thumbs.push(addMore);
}

function layoutCoverFlow(){
  const focal = CFLOW.selected + CFLOW.drift;
  const cs = getComputedStyle(document.documentElement);
  const W_BIG = parseInt(cs.getPropertyValue('--thumb-big')) || 150;
  const W_SMALL = parseInt(cs.getPropertyValue('--thumb-small')) || 70;
  const GAP = Math.round(W_SMALL / 5);  // 1/5 of small width as spacing
  /* Variable stride:
     STEP_TO_BIG = stride between selected (centered) and adjacent thumb
     STEP_SMALL  = stride between two non-selected adjacent thumbs */
  const STEP_TO_BIG = (W_BIG + W_SMALL)/2 + GAP;
  const STEP_SMALL = W_SMALL + GAP;
  /* Cache STRIDE for drag math: use STEP_TO_BIG since drag movement near focal
     is dominated by the wider stride. */
  CFLOW.STRIDE = STEP_TO_BIG;

  CFLOW.thumbs.forEach((thumb, i) => {
    const delta = i - focal;
    const sign = Math.sign(delta);
    const adel = Math.abs(delta);
    /* Offset: linear from 0..STEP_TO_BIG over delta 0..1, then STEP_SMALL per step */
    let offset;
    if (adel < 0.0001) offset = 0;
    else if (adel <= 1) offset = sign * adel * STEP_TO_BIG;
    else offset = sign * (STEP_TO_BIG + (adel - 1) * STEP_SMALL);
    /* Width: interpolate BIG↔SMALL when |delta|<0.5, else SMALL */
    let w;
    if (adel >= 0.5) w = W_SMALL;
    else w = W_BIG + (W_SMALL - W_BIG) * (adel / 0.5);
    thumb.style.setProperty('--ox', offset.toFixed(1) + 'px');
    thumb.style.width = w.toFixed(1) + 'px';
    const isActive = adel < 0.5;
    thumb.classList.toggle('active', isActive);
    /* Opacity differential: full at center, .55 outside */
    thumb.style.opacity = isActive ? (1 - adel * 0.9) : 0.55;
  });
  /* Position the clear-all tile at virtual index -1 (one stride to the
     left of the leftmost real thumb). Uses the same offset formula so
     the spacing matches add-more's spacing on the opposite end. */
  const clearAllTile = document.getElementById('clearAllStrip');
  if (clearAllTile) {
    /* Virtual index = -1; delta = -1 - focal */
    const caDelta = -1 - focal;
    const caSign = Math.sign(caDelta);
    const caAdel = Math.abs(caDelta);
    let caOffset;
    if (caAdel < 0.0001) caOffset = 0;
    else if (caAdel <= 1) caOffset = caSign * caAdel * STEP_TO_BIG;
    else caOffset = caSign * (STEP_TO_BIG + (caAdel - 1) * STEP_SMALL);
    clearAllTile.style.setProperty('--ox', caOffset.toFixed(1) + 'px');
    clearAllTile.style.width = W_SMALL.toFixed(1) + 'px';
  }
  /* Scrubber update: total real images = FILES.length, current
     position = focal (= selected + drift). Show only when 2+ files. */
  const scrubber = document.getElementById('cflowScrubber');
  if (scrubber) {
    const total = (typeof FILES !== 'undefined') ? FILES.length : 0;
    if (total < 2) {
      scrubber.classList.remove('has-many');
    } else {
      scrubber.classList.add('has-many');
      /* Map focal (range [-1, total]) to a 0..1 progress.
         When focal = 0 (leftmost real), progress = 0.
         When focal = total-1 (rightmost real), progress = 1. */
      const clamped = Math.max(0, Math.min(total - 1, focal));
      const progress = clamped / (total - 1);
      /* Thumb width: 1/total of the track, but clamped to a sensible
         minimum so the indicator stays visible on big batches. */
      const widthPct = Math.max(100 / total, 12);
      const leftPct = progress * (100 - widthPct);
      const thumb = scrubber.querySelector('.cflow-scrubber-thumb');
      if (thumb) {
        thumb.style.width = widthPct.toFixed(2) + '%';
        thumb.style.left  = leftPct.toFixed(2) + '%';
      }
    }
  }
}

/* ===== ENCODING via /imgready-worker.js (the same one production uses) ===== */
const ENCODE = {
  /* Cold-start pre-warm: once the page is idle after first load,
     send a 'preload' action to the worker so the WebP encoder WASM
     compiles in the background. First real encode then skips the
     2-3s cold-start. Worker already handles 'preload' action. */
  worker: null,
  pendingId: 0,
  pending: {},                  // id -> {resolve, reject, idx, filename}
  encoded: new Map(),           // file index -> { blob, url, size, format }  (PRIMARY)
  inflight: new Map(),          // `${idx}:${fmt}` -> Promise<Blob>
  queue: [],                    // background queue of indices to encode
  queueRunning: false,          // single-flight guard for processQueue()
  gen: 0,                       // bumps every invalidateEncoded — stale results dropped
  /* Sidecar for multi-output mode. Each idx holds a Map of format → encoded.
     Single-output mode populates it with one entry; multi-output mode
     populates it with all selected formats. The PRIMARY (in .encoded) is
     always the FIRST active format and drives the compare canvas. */
  allEncoded: new Map(),        // idx -> Map<format, {blob, url, size, format}>
  outDims:    new Map(),        // idx -> {outW, outH} — post-resize dims from worker (R46)
};
const MULTI_OUT = { enabled: false };
function getWorker(){
  if (!ENCODE.worker) {
    ENCODE.worker = new Worker('/imgready-worker.js');
    ENCODE.worker.onmessage = (e) => {
      /* Diagnostic from the animated-GIF pipeline. Tagged so it bypasses
         the normal id-routed reply flow. Useful for verifying that the
         encoder actually wrote multiple frames. */
      if (e.data && e.data.type === 'gif-diag') {
        console.log('[gif] sourceFrames=%d framesWritten=%d palette=%d skip=%d size=%dx%d bytes=%d',
          e.data.sourceFrames, e.data.framesWritten,
          e.data.paletteSize, e.data.frameSkip,
          e.data.outW, e.data.outH, e.data.bytes);
        /* Stash by the currently-encoding idx so syncMainImage can
           pick it up when the worker's result message lands shortly
           after. Cleared by ENCODE.encoded.set once consumed. */
        ENCODE._lastDiag = { idx: CFLOW.selected, data: e.data };
        return;
      }
      const m = e.data;
      const entry = ENCODE.pending[m.id];
      if (!entry) return;
      if (m.type === 'result') {
        delete ENCODE.pending[m.id];
        if (entry.timer) clearTimeout(entry.timer);
        /* R46 — stash output dims by file-idx so syncMainImage can attach to enc */
        if (m.outW && m.outH) ENCODE.outDims.set(entry.idx, { outW: m.outW, outH: m.outH });
        entry.resolve(m.blob);
        /* Refresh the After-meta batch totals as each background-queue
           encode completes. Without this, the "↓ X MB · N files total"
           line stays stuck at the count when the user first dropped (or
           the HTML placeholder) until they manually select another thumb. */
        try {
          const sel = (typeof CFLOW !== 'undefined') ? CFLOW.selected : -1;
          if (sel >= 0 && typeof FILES !== 'undefined' && FILES[sel] && typeof setMetaCorners === 'function') {
            const selEnc = ENCODE.encoded.get(sel);
            if (selEnc) setMetaCorners(FILES[sel].file, selEnc);
          }
        } catch(_){}
      } else if (m.type === 'error') {
        delete ENCODE.pending[m.id];
        if (entry.timer) clearTimeout(entry.timer);
        console.warn('[beta encode error]', m.message);
        entry.reject(new Error(m.message));
      } else if (m.type === 'progress') {
        /* Center overlay is reserved for the SELECTED thumb's encode. If a
           background-queue encode for a different thumb is sending progress
           events, we ignore them in the center overlay (the per-thumb
           spinner on that thumb already conveys "this one is cooking").
           Otherwise the overlay would flash for every queue item even
           after the selected image's compare is fully rendered.
           In Multi mode each format triggers its own decode->encode cycle,
           which produced rapid 'Decoding…'/'Encoding…' text swapping that
           read as an infinite loop. Keep the label stable in multi mode. */
        if (entry.filename && entry.idx === CFLOW.selected) {
          const label = (typeof MULTI_OUT !== 'undefined' && MULTI_OUT.enabled)
            ? 'Encoding…'
            : (m.stage === 'decoding' ? 'Decoding…' : 'Encoding…');
          showCenterStatus(label, entry.filename);
        }
      }
    };
    ENCODE.worker.onerror = (err) => {
      console.warn('[beta worker error]', err && err.message || err);
      /* Reject every pending so the UI doesn't hang forever */
      Object.keys(ENCODE.pending).forEach(id => {
        const entry = ENCODE.pending[id];
        if (entry) {
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(new Error('Worker crashed'));
          delete ENCODE.pending[id];
        }
      });
    };
  }
  return ENCODE.worker;
}
/* Center-canvas loading overlay (replaces corner status). The user asked for
   a prominent middle-of-canvas state because the top-right corner was easy
   to miss and competed with the After meta. */
const CS = { barTimer: null, barEl: null, pct: 0,
              /* Global defer state — when CS.deferred is true, ANY caller
                 of showCenterStatus is silently suppressed. The timer
                 auto-fires at the end of the defer window and shows the
                 overlay iff the selected idx is still encoding.
                 This is the ONE place every loader-flash source goes
                 through: worker progress events, syncMainImage, and any
                 other code paths that try to surface "Encoding…". */
              deferred: false, deferTimer: null };
function deferCenterStatus(ms){
  CS.deferred = true;
  if (CS.deferTimer) clearTimeout(CS.deferTimer);
  CS.deferTimer = setTimeout(() => {
    CS.deferTimer = null;
    CS.deferred = false;
    /* End of defer window. If the selected idx is STILL not encoded,
       the encode is genuinely slow — show the loader now. */
    const idx = (typeof CFLOW !== 'undefined') ? CFLOW.selected : -1;
    if (idx >= 0 && idx < (FILES ? FILES.length : 0) &&
        ENCODE && ENCODE.encoded && !ENCODE.encoded.has(idx)) {
      const f = FILES[idx];
      showCenterStatus('Encoding…', (f && f.name) || '', { bigFile: false });
    }
  }, ms);
}
function clearDeferCenterStatus(){
  CS.deferred = false;
  if (CS.deferTimer) { clearTimeout(CS.deferTimer); CS.deferTimer = null; }
}
function showCenterStatus(stage, filename, opts){
  /* Global suppression for fast re-encodes — see deferCenterStatus(). */
  if (CS.deferred) return;
  const el = document.getElementById('centerStatus');
  if (!el) return;
  el.hidden = false;
  const stageEl = document.getElementById('csStage');
  /* No batch counter — only the currently-viewed image surfaces here.
     Everything else encodes in the background (per-thumb spinner badges
     convey that progress instead). */
  if (stageEl) stageEl.textContent = stage || 'Encoding…';
  document.body.dataset.encoding = 'on';
}
function hideCenterStatus(){
  /* Tear down the defer window — if encode finished inside the 2000ms
     suppression, the timer never gets to fire (and never paints). */
  clearDeferCenterStatus();
  const el = document.getElementById('centerStatus');
  if (el) el.hidden = true;
  document.body.dataset.encoding = '';
  document.body.dataset.qualityEncoding = '';
  /* R22 — discoverability: when a first encode lands in solo mode and
     the user hasn't yet seen the pi-action icons this session, reveal
     them once. The existing 3s auto-close timer dismisses naturally
     so the icons don't linger past the discovery moment. */
  if (!window._r22PiSeen
      && document.body.dataset.state === 'solo'
      && document.body.dataset.editOpen !== 'true'
      && document.body.dataset.piActions !== 'open'){
    window._r22PiSeen = true;
    setTimeout(() => {
      if (typeof openPiActions === 'function') openPiActions();
    }, 400);
  }
  /* DON'T clear data-reencoding here. It's tied to "the selected image
     is still encoding"; the hideCenterStatus call only signals that the
     overlay should disappear (encode landed OR cancelled). The
     data-reencoding cleanup happens in syncMainImage's success/cached
     paths and on selection swaps, scoped to CFLOW.selected. */
}
function startCsBar(estMs){
  stopCsBar();
  const fill = document.getElementById('csBarFill');
  if (!fill) return;
  CS.pct = 0; fill.style.width = '0%';
  /* Linear creep, capped at 95%. Real result lands → setMetaCorners triggers
     hideCenterStatus → bar resets to 0. */
  const startedAt = performance.now();
  CS.barTimer = setInterval(() => {
    const elapsed = performance.now() - startedAt;
    const target = Math.min(95, (elapsed / estMs) * 100);
    CS.pct = target;
    fill.style.width = target + '%';
  }, 200);
}
function stopCsBar(){
  if (CS.barTimer) { clearInterval(CS.barTimer); CS.barTimer = null; }
}
/* Per-thumb encoding badge: small spinner overlay so users see progress for
   non-selected files in a batch. Toggled by encodeFile / syncMainImage. */
function markThumbEncoding(idx, on){
  const t = CFLOW.thumbs[idx];
  if (!t) return;
  t.classList.toggle('encoding', !!on);
}
/* Compare UI visibility: show divider + handle + After meta only when the
   currently selected file has a real encoded result. Driven by the
   .has-after class on the .image-canvas. */
function setHasAfter(on){
  const canvas = document.querySelector('body[data-state="multi"] .stage.multi .image-canvas');
  if (!canvas) return;
  const wasOn = canvas.classList.contains('has-after');
  canvas.classList.toggle('has-after', !!on);
  /* R68 — when after appears for the first time, snap the compare
     divider to center. Previously the divider's transform was left
     unset so it visually sat at translateX(0) = far left edge. */
  if (on && !wasOn) {
    window.SLIDER = window.SLIDER || { screenPct: 50 };
    window.SLIDER.screenPct = 50;
    try {
      if (typeof window.setSplit === 'function') window.setSplit(canvas, 50, 50);
      if (typeof refreshSliderFromZoom === 'function') refreshSliderFromZoom();
    } catch(_){}
  }
}

/* Backwards-compat shim — keeps any older callers from breaking. The corner
   status path is gone; we now route to the center overlay. */
function showAfterStatus(text){ showCenterStatus(text, ''); }
/* Normalize a MIME type string to a short format token used throughout
   the code (filenames, displays, comparisons). Without this, image/x-icon
   was rendering as 'x-icon' and showing 'X-ICON' in the After meta. */
function mimeToFmt(mime){
  if (!mime) return 'img';
  const m = mime.toLowerCase();
  if (m === 'image/x-icon' || m === 'image/vnd.microsoft.icon') return 'ico';
  if (m === 'image/jpeg') return 'jpg';
  const part = m.split('/')[1] || 'img';
  return part;
}
function getActiveFormats(){
  /* Returns every active format pill's fmt. The format menu gets
     PORTALLED to document.body on first dropdown open (to escape the
     drawer's overflow:hidden), so a stage-scoped selector matches
     zero pills after first interaction. Use a global ID selector. */
  const pills = document.querySelectorAll('#formatPills button.active[data-fmt]');
  if (!pills.length) return ['auto'];
  return Array.from(pills).map(b => b.dataset.fmt);
}

function pickAutoFormat(file){
  const t = (file.type || '').toLowerCase();
  const e = (file.name.split('.').pop() || '').toLowerCase();
  if (t.includes('jpeg') || e === 'jpg' || e === 'jpeg') return 'jpg';
  if (t.includes('png')  || e === 'png')  return 'png';
  if (t.includes('webp') || e === 'webp') return 'webp';
  if (t.includes('avif') || e === 'avif') return 'avif';
  if (t.includes('gif')  || e === 'gif')  return 'gif';
  if (e === 'svg' || t.includes('svg'))   return 'png';
  return 'jpg';
}
/* When Smart quality mode is active we need a per-file quality.
   getActiveSettings reads from this contextual variable; encodeFile
   sets it before calling getActiveSettings. */
let _gasContextFile = null;
function getActiveSettings(){
  /* Format: the dropdown's data-format-current is the source of truth.
     Fall back to the active button's data-fmt if the attribute is missing
     (defensive — shouldn't happen). The OLD .adjust-pills selector was
     dead code after the multi-stage format pills became a dropdown menu;
     when it returned null, fmt collapsed to 'auto' and pickAutoFormat
     locked output to the input file's MIME (the JPG-output bug). */
  const fmtDropdown = document.querySelector('body[data-state="multi"] .stage.multi .format-dropdown');
  let fmt = (fmtDropdown && fmtDropdown.dataset.formatCurrent) || 'auto';
  const activeFmtBtn = document.querySelector('body[data-state="multi"] #formatPills button.active[data-fmt]');
  if (!fmtDropdown && activeFmtBtn) fmt = activeFmtBtn.dataset.fmt;
  /* Quality: the menu containing the slider is portalled to
     document.body on first open, so the stage-scoped selector breaks.
     The dropdown's data-quality-current attribute is the source of
     truth — setQuality() keeps it in sync with both preset clicks and
     slider drags. Fallback to any .quality-row slider in the doc
     (portalled or not) for defensive read; final fallback to 82. */
  /* Quality: if Smart mode and we have a file context, compute
     per-file via the bpp + format-efficiency heuristic. Otherwise
     read from the dropdown's stored value (set by preset clicks
     or slider drags). */
  let qualityRaw = NaN;
  let _targetKbForWorker = 0; /* R48 — passed to worker for binary-search target-size encode */
  const qDropdown = document.querySelector('.quality-dropdown');
  const qMode = qDropdown && qDropdown.dataset.qualityMode;
  const isSmart = qMode === 'smart';
  const isTarget = qMode === 'target';
  if (isSmart && _gasContextFile && typeof window._suggestQuality === 'function') {
    qualityRaw = window._suggestQuality(_gasContextFile, fmt);
  } else if (isTarget && _gasContextFile && typeof window._qualityFromTarget === 'function') {
    /* Target-size mode: pass targetKb to the worker so it binary-searches
       quality in the encode loop (R48). Also compute an estimated quality
       as a reasonable fallback if the worker path is ever skipped. */
    const targetKb = parseInt(qDropdown.dataset.qualityTarget, 10) || 100;
    _targetKbForWorker = targetKb; /* R48 */
    let tw = 0, th = 0;
    if (typeof FILES !== 'undefined') {
      const entry = FILES.find(f => f && f.file === _gasContextFile);
      if (entry && entry.dims) { tw = entry.dims.w; th = entry.dims.h; }
    }
    qualityRaw = window._qualityFromTarget(_gasContextFile, fmt, targetKb, tw, th);
  } else if (qDropdown && qDropdown.dataset.qualityCurrent) {
    qualityRaw = parseInt(qDropdown.dataset.qualityCurrent, 10);
  }
  if (!isFinite(qualityRaw)) {
    const qSlider = document.querySelector('.quality-row input[type=range]');
    qualityRaw = qSlider ? parseInt(qSlider.value, 10) : 82;
  }
  const quality = Math.max(1, Math.min(100, qualityRaw)) / 100;
  /* R49-fix: read resize from the split dropdown's data-resize-current attribute.
     The old .resize-input selector was orphaned when the resize UI became a split
     dropdown — commitResize() writes to data-resize-current, not the input value. */
  const resizeDd = document.querySelector('body[data-state="multi"] .stage.multi .resize-dropdown');
  const activeMode = resizeDd ? null : document.querySelector('body[data-state="multi"] .stage.multi .resize-mode-toggle .rmt-btn.active');
  const sizeVal = resizeDd ? (parseInt(resizeDd.dataset.resizeCurrent, 10) || 0)
                           : (() => { const si = document.querySelector('body[data-state="multi"] .stage.multi .resize-input'); return si && si.value ? parseInt(si.value) : 0; })();
  const isPercent = activeMode && activeMode.dataset.mode === 'pct';
  const stripExif = true; /* R124: canvas re-encode always drops metadata; toggle removed */
  const MIME = { webp:'image/webp', avif:'image/avif', png:'image/png', jpg:'image/jpeg', gif:'image/gif', ico:'image/x-icon' };
  /* Crop: read the dropdown's currently-selected ratio. Worker maps
     'none' → null (no crop), other strings to ratio numbers via its
     CROP_RATIOS constant. */
  const cropDropdown = document.querySelector('body[data-state="multi"] .stage.multi .crop-dropdown');
  const crop = (cropDropdown && cropDropdown.dataset.cropCurrent) || 'none';
  return {
    fmt,
    settings: {
      mime: MIME[fmt] || 'image/webp',
      quality,
      maxDim:    !isPercent ? sizeVal : 0,
      resizePct:  isPercent ? sizeVal : 0,
      stripExif,
      crop,
      targetKb: _targetKbForWorker, /* R48 — worker binary-searches quality when > 0 */
    },
  };
}
async function encodeFile(idx, overrideFmt){
  const f = FILES[idx];
  if (!f) return Promise.reject(new Error('no file'));
  /* Ensure dimensions are populated BEFORE running Smart quality math.
     Previously syncMainImage populated f.dims asynchronously via
     createImageBitmap, so the first encode fired with dims=undefined and
     fell back to a file-size-tier baseline (q=78) instead of the
     bpp-aware baseline (q=70). Same file → two different quality values
     → "first encode saves 27%, second encode saves 57%" bug.
     Eliminate the race by awaiting dims inline here. ~50-200ms latency
     on first encode in exchange for consistent output sizes. */
  if (!f.dims) {
    try {
      const bmp = await createImageBitmap(f.file);
      f.dims = { w: bmp.width, h: bmp.height };
      try { bmp.close && bmp.close(); } catch(_){}
    } catch(_){ /* fall through with no dims — Smart uses file-size fallback */ }
  }
  /* Hand the file to getActiveSettings via the module-level context
     var, so Smart quality mode can compute per-file. */
  _gasContextFile = f.file;
  const { fmt: settingsFmt, settings } = getActiveSettings();
  _gasContextFile = null;
  const fmt = overrideFmt || settingsFmt;
  const realFmt = fmt === 'auto' ? pickAutoFormat(f.file) : fmt;
  /* In-flight key now includes the format so two concurrent encodes of
     the same idx but different formats (multi-output mode) can run
     without one cancelling the other. */
  const inflightKey = `${idx}:${realFmt}`;
  if (ENCODE.inflight.has(inflightKey)) return ENCODE.inflight.get(inflightKey);
  settings.mime = { webp:'image/webp', avif:'image/avif', png:'image/png', jpg:'image/jpeg', gif:'image/gif', ico:'image/x-icon' }[realFmt] || settings.mime;
  const id = ++ENCODE.pendingId;
  /* Mark this thumb as encoding so it shows a per-thumb spinner overlay.
     Cleared in syncMainImage's success/failure branches. */
  markThumbEncoding(idx, true);
  const p = new Promise((resolve, reject) => {
    const entry = { resolve, reject, format: realFmt, filename: f.name, idx };
    /* 60s safety timeout: if the worker stalls (rare, but observed in
       practice) the UI isn't stuck on "Encoding…" forever. */
    entry.timer = setTimeout(() => {
      if (ENCODE.pending[id] === entry) {
        delete ENCODE.pending[id];
        reject(new Error('Encoding timed out (>60s) — try a different format or smaller image'));
      }
    }, 60000);
    ENCODE.pending[id] = entry;
    try { getWorker().postMessage({ id, action: 'process', file: f.file, fmt: realFmt, settings }); }
    catch(e){
      clearTimeout(entry.timer);
      delete ENCODE.pending[id];
      reject(e);
    }
  });
  ENCODE.inflight.set(inflightKey, p);
  p.finally(() => { ENCODE.inflight.delete(inflightKey); });
  return p;
}
/* Lightweight toast for non-image rejection feedback. Auto-fades after 3s. */
let _rejectedToastEl = null;
function showRejectedToast(count){
  if (!_rejectedToastEl) {
    _rejectedToastEl = document.createElement('div');
    _rejectedToastEl.className = 'reject-toast';
    /* R114 — A11y: role="alert" makes screen readers announce the toast
       immediately (WCAG 4.1.3 Status Messages AA). Without it, blind users
       drop an unsupported file and get silence — same UX bug as our
       earlier "drop appeared to silently no-op" issue, just for SR users.
       aria-atomic=true so the whole text is read each time, not diffed. */
    _rejectedToastEl.setAttribute('role', 'alert');
    _rejectedToastEl.setAttribute('aria-atomic', 'true');
    document.body.appendChild(_rejectedToastEl);
  }
  _rejectedToastEl.textContent = count === 1
    ? "That file isn't a supported image. Try JPG, PNG, HEIC, WebP, AVIF, TIFF, or GIF."
    : `None of those ${count} files looked like images. Supported: JPG, PNG, HEIC, WebP, AVIF, TIFF, GIF.`;
  _rejectedToastEl.classList.add('show');
  if (_rejectedToastEl._t) clearTimeout(_rejectedToastEl._t);
  _rejectedToastEl._t = setTimeout(() => {
    _rejectedToastEl && _rejectedToastEl.classList.remove('show');
  }, 3000);
}

function fmtSize(n){ return n < 1024 ? n + ' B' : n < 1024*1024 ? (n/1024).toFixed(1)+' KB' : (n/1024/1024).toFixed(2)+' MB'; }
function setMetaCorners(beforeFile, encoded){
  /* Pull cached dimensions from the FILES entry if available — populated
     in syncMainImage via createImageBitmap. May be undefined for very
     fresh selects; we just omit the dimensions in that case rather than
     blocking the meta paint. */
  const idx = CFLOW.selected;
  const dims = (FILES[idx] && FILES[idx].dims) ? FILES[idx].dims : null;
  const dimsStr = dims ? `${dims.w} × ${dims.h} · ` : '';
  /* R46 — after-meta uses output (post-resize) dims when available */
  const encDimsStr = (encoded && encoded.outW && encoded.outH)
    ? `${encoded.outW} × ${encoded.outH} · `
    : dimsStr;
  const beforeMeta = document.querySelector('body[data-state="multi"] .stage.multi .compare-meta.l');
  if (beforeMeta) {
    const span = beforeMeta.querySelector('span:not(.lbl-title)');
    if (span) span.textContent = `${dimsStr}${fmtSize(beforeFile.size)} · ${(beforeFile.type.split('/')[1]||'IMG').toUpperCase()}`;
  }
  /* Live size readout in the toolbar — mirrors what After meta says, but
     keeps the user's eye on the slider while they're tuning quality. */
  const qrSize = document.getElementById('qrSize');
  if (qrSize) qrSize.textContent = encoded ? fmtSize(encoded.size) : '';
  /* Mirror size into the Download button label. Single file: show the
     individual size; batch: show file count (total bytes is less
     useful when each file has its own savings). */
  const btnDlSize = document.getElementById('btnDlSize');
  if (btnDlSize) {
    const fileCount = (typeof FILES !== 'undefined') ? FILES.length : 0;
    if (fileCount > 1) {
      btnDlSize.textContent = '\u00b7 ' + fileCount + ' files';
    } else if (encoded) {
      btnDlSize.textContent = '\u00b7 ' + fmtSize(encoded.size);
    } else {
      btnDlSize.textContent = '';
    }
  }
  const afterMeta = document.querySelector('body[data-state="multi"] .stage.multi .compare-meta.r');
  if (afterMeta) {
    const sizeSpan = afterMeta.querySelector('span:not(.lbl-title):not(.pct):not(.batch-row):not(.gif-meta)');
    const pctSpan  = afterMeta.querySelector('.pct');
    const batchRow = afterMeta.querySelector('.batch-row');
    /* GIF frame-delta callout — only present when the worker's gif
       pipeline emitted a diag (i.e. animated GIF input got delta-encoded).
       Shows e.g. "Frame-delta · 64 colors". Lets the user see WHY their
       GIF compressed so well. */
    let gifMetaEl = afterMeta.querySelector('.gif-meta');
    if (encoded && encoded.meta && encoded.meta.framesWritten > 1) {
      if (!gifMetaEl) {
        gifMetaEl = document.createElement('span');
        gifMetaEl.className = 'gif-meta';
        afterMeta.appendChild(gifMetaEl);
      }
      gifMetaEl.textContent = `Frame-delta · ${encoded.meta.paletteSize} colors`;
    } else if (gifMetaEl) {
      gifMetaEl.remove();
    }
    if (encoded) {
      /* If multi-output, list each format's size. Otherwise just the primary. */
      const bundle = ENCODE.allEncoded.get(idx);
      if (MULTI_OUT.enabled && bundle && bundle.size > 1) {
        const parts = Array.from(bundle.values()).map(e =>
          `${e.format.toUpperCase()} ${fmtSize(e.size)}`).join(' · ');
        if (sizeSpan) sizeSpan.textContent = `${encDimsStr}${parts}`; /* R46 */
      } else {
        const fmtUpper = (encoded.format||'').toUpperCase();
        if (sizeSpan) {
          sizeSpan.textContent = `${encDimsStr}${fmtSize(encoded.size)} · ${fmtUpper}`; /* R46 */
        }
      }
      const pct = Math.round((1 - encoded.size/beforeFile.size) * 100);
      if (pctSpan) {
        if (Math.abs(pct) < 1) {
          /* Within ±1% of original — too noisy to call out savings. Hide
             the savings line entirely (common for ICO which wraps PNG). */
          pctSpan.style.display = 'none';
          pctSpan.classList.remove('bad');
        } else {
          pctSpan.textContent = `${pct >= 0 ? pct : Math.abs(pct)}% ${pct >= 0 ? 'smaller' : 'larger'}`;
          pctSpan.classList.toggle('bad', pct < 0);
          pctSpan.style.display = '';
        }
      }
      let totalBefore = 0, totalAfter = 0, count = 0;
      FILES.forEach((f, i) => {
        const e = ENCODE.encoded.get(i);
        if (e) { totalBefore += f.file.size; totalAfter += e.size; count++; }
      });
      if (batchRow && count > 1) { batchRow.textContent = `↓ ${fmtSize(totalBefore - totalAfter)} · ${count} files total`; batchRow.style.display = ''; }
      else if (batchRow) batchRow.style.display = 'none';
    } else {
      if (sizeSpan) sizeSpan.textContent = 'Encoding…';
      if (pctSpan) { pctSpan.style.display = 'none'; pctSpan.classList.remove('bad'); }
      if (batchRow) batchRow.style.display = 'none';
    }
  }
  /* Sync floating top-chrome */
  const tcB = document.getElementById('tcBefore');
  const tcA = document.getElementById('tcAfter');
  const tcP = document.getElementById('tcPct');
  const tcS = document.getElementById('tcStats');
  /* On narrow viewports the top-chrome's tcBefore/tcAfter just don't
     have room for dimensions; keep size + format only. */
  const _isNarrow = (typeof window.matchMedia === 'function') &&
                    window.matchMedia('(max-width: 767px)').matches;
  const _dims = _isNarrow ? '' : dimsStr;
  if (tcB) tcB.textContent = _dims + fmtSize(beforeFile.size) + ' \u00b7 ' + (beforeFile.type.split('/')[1]||'IMG').toUpperCase();
  if (tcA) {
    if (encoded) { tcA.textContent = _dims + fmtSize(encoded.size) + ' \u00b7 ' + (encoded.format||'').toUpperCase(); }
    else { tcA.textContent = 'Encoding\u2026'; }
  }
  if (tcP) {
    if (encoded) {
      const pctNow = Math.round((1 - encoded.size/beforeFile.size) * 100);
      if (Math.abs(pctNow) < 1) { tcP.textContent = ''; tcP.classList.remove('bad'); }
      else { tcP.textContent = Math.abs(pctNow) + '% ' + (pctNow >= 0 ? 'smaller' : 'larger'); tcP.classList.toggle('bad', pctNow < 0); }
    } else { tcP.textContent = ''; }
  }
  if (tcS) {
    let tB2 = 0, tA2 = 0;
    FILES.forEach((ff, ii) => { const ee = ENCODE.encoded.get(ii); if (ee) { tB2 += ff.file.size; tA2 += ee.size; } });
    const total = FILES.length;
    const fileWord = total === 1 ? '1 file' : (total + ' files');
    if (tB2 > tA2 && tB2 > 0) { tcS.textContent = fmtSize(tB2 - tA2) + ' saved \u00b7 ' + fileWord; }
    else { tcS.textContent = fileWord; }
  }
}

/* Sync big image — shows original + (encoded or encoding-in-progress).
   Pre-encode rules:
     - Compare slider (divider, handle, After-meta) is hidden via .has-after
     - cbAfter has no clip-path so no half-image artifact
     - Center-canvas spinner shows "Decoding…/Encoding…" + filename
     - Per-thumb spinner pulses on the active thumb
   Post-encode:
     - .has-after flips on, slider + After-meta render
     - Center spinner fades, thumb spinner clears
     - Setting Before-meta is fine pre-encode (file size is known immediately) */
async function syncMainImage(force, opts){
  opts = opts || {};
  const preserveView = !!opts.preserveView;
  const idx = CFLOW.selected;
  if (!force && idx === CFLOW.prevSelected) return;
  CFLOW.prevSelected = idx;
  /* Selection swap (not preserveView): user is looking at a different
     file now, so the qr-spinner from any in-flight previous-image
     encode is no longer relevant. Clear it. preserveView keeps it. */
  if (!preserveView) document.body.dataset.reencoding = '';
  const thumb = CFLOW.thumbs[idx];
  if (!thumb || thumb.classList.contains('add-more')) return;
  const f = FILES[idx];
  if (!f) return;

  const before = document.getElementById('cbBefore');
  const after = document.getElementById('cbAfter');
  const setBg = (el, url) => {
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = 'contain';
    el.style.backgroundPosition = 'center';
    el.style.backgroundRepeat = 'no-repeat';
    el.style.backgroundColor = '#000';
    el.textContent = '';
  };
  /* Preload + decode pattern — eliminates the brief "show fallback bg
     color" flash that happens when background-image changes before the
     new image is decoded. Promise resolves once the bitmap is ready;
     on resolve the caller swaps the bg, paint-instant. Decode failures
     are non-fatal: we proceed and accept the legacy tiny flash. */
  const setBgPreloaded = async (el, url) => {
    if (!url) { setBg(el, url); return; }
    try {
      const img = new Image();
      img.src = url;
      if (typeof img.decode === 'function') await img.decode();
      else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    } catch (_) { /* non-fatal */ }
    setBg(el, url);
  };
  setBg(before, f.url);
  /* Filename ribbon — top-center reference of which file is currently in
     the viewer. Updated on every selection swap. */
  const ribbon = document.getElementById('filenameRibbon');
  if (ribbon) ribbon.textContent = f.name || '';
  /* Lazy-decode original dimensions once per file (cached on FILES entry).
     Used by the encode pipeline / Before meta card; no UI hint anymore
     since dimensions are already shown in the meta corners. */
  (async () => {
    try {
      if (!f.dims) {
        const bmp = await createImageBitmap(f.file);
        f.dims = { w: bmp.width, h: bmp.height };
        try { bmp.close && bmp.close(); } catch(_){}
      }
    } catch(_){ /* non-fatal */ }
  })();
  /* Reset zoom on every selection swap so the new image starts at 1x.
     But re-encodes (preserveView) keep the user's current zoom + pan so
     A/B detail comparison doesn't require re-zooming each tweak. */
  if (!preserveView) resetZoom();
  /* Update the Before meta (always known immediately from the file blob).
     Under preserveView, keep the old After meta on screen — the cached
     path below (or the success branch) will overwrite it cleanly when
     the new encode lands. Flashing "Encoding…" into the After meta
     mid-re-encode looks just as bad as the canvas flashing black. */
  if (!preserveView) setMetaCorners(f.file, null);
  /* Priority lever: if this idx is in the background queue but not yet
     started, jump it to the head so the next worker slot is ours. */
  if (typeof bumpToFront === 'function') bumpToFront(idx);
  /* Cached encoded result wins — render compare immediately, no spinner.
     ICO is a special case: most browsers don't reliably render PNG-in-ICO
     via CSS background-image, leaving the After image black. Fall back to
     the original (cbBefore) for the preview; the ICO blob is still used
     for download. */
  const cached = ENCODE.encoded.get(idx);
  if (cached) {
    /* Helper: clear the small qr-spinner state when the SELECTED image
       is done. Background-queue items for other files may still be in
       flight; that's fine, the qr-spinner is scoped to the current view. */
    const clearReencoding = () => {
      if (CFLOW.selected === idx) document.body.dataset.reencoding = '';
    };
    if (cached.format === 'ico') {
      /* ICO falls back to the Before image — that's already painted on
         compare-before, so no preload needed. */
      setBg(after, f.url);
      setMetaCorners(f.file, cached);
      setHasAfter(true);
      hideCenterStatus();
      markThumbEncoding(idx, false);
      clearReencoding();
    } else {
      /* Preload the cached blob URL — if scrolled away and back, the
         decoded bitmap may have been evicted; decoding first avoids a
         fallback-color flash on swap. */
      const myGen = ENCODE.gen;
      setBgPreloaded(after, cached.url).then(() => {
        if (myGen !== ENCODE.gen || CFLOW.selected !== idx) return;
        setMetaCorners(f.file, cached);
        setHasAfter(true);
        hideCenterStatus();
        markThumbEncoding(idx, false);
        clearReencoding();
      });
    }
    return;
  }
  /* Pre-encode UI state. Two paths:
       - Selection swap (default): clear After bg + show center loader
         immediately. User needs feedback that work has started for a
         different image.
       - Re-encode (preserveView): keep the old After image visible. The
         CS.deferred gate (set by invalidateEncoded → deferCenterStatus)
         suppresses every showCenterStatus call for the first 1000ms,
         catching worker progress events too, so fast re-encodes never
         flash a status overlay at all. */
  if (!preserveView) {
    after.style.backgroundImage = 'none';
    after.style.backgroundColor = '#000';
    setHasAfter(false);
    const big = f.file.size > 5 * 1024 * 1024;
    const estMs = Math.max(1500, Math.round(f.file.size / (8 * 1024 * 1024) * 1000));
    const alreadyInflight = ENCODE.inflight.has(idx);
    if (alreadyInflight) {
      showCenterStatus('Encoding…', f.name, { bigFile: false });
    } else {
      showCenterStatus('Decoding…', f.name, { bigFile: big, estMs });
    }
  }
  markThumbEncoding(idx, true);
  try {
    /* Encode the PRIMARY format first so the canvas updates fast. The
       background queue will fill in remaining formats for multi-output. */
    const blob = await encodeFile(idx);
    const url = URL.createObjectURL(blob);
    const fmtFromMime = mimeToFmt(blob.type);
    /* Attach any encoder-side meta captured from the gif-diag message.
       Stored by idx in ENCODE._lastDiag (set inside worker.onmessage). */
    const meta = (ENCODE._lastDiag && ENCODE._lastDiag.idx === idx) ? ENCODE._lastDiag.data : null;
    const _od = ENCODE.outDims.get(idx); /* R46 */
    const enc = { blob, url, size: blob.size, format: fmtFromMime, meta, outW: _od ? _od.outW : 0, outH: _od ? _od.outH : 0 };
    ENCODE.encoded.set(idx, enc);
    /* Announce encode result for screen readers. Only on success.
       Throttled inside srAnnounce; safe to call per file. */
    try {
      const beforeSize = f.file.size;
      const savedPct = beforeSize ? Math.round((beforeSize - blob.size) / beforeSize * 100) : 0;
      const total = (typeof FILES !== 'undefined') ? FILES.length : 1;
      const done = (typeof ENCODE.encoded !== 'undefined') ? ENCODE.encoded.size : 1;
      window.srAnnounce && window.srAnnounce(
        total > 1
          ? `${done} of ${total} encoded · latest ${savedPct}% smaller`
          : `Encoded · ${savedPct}% smaller`
      );
    } catch(_){}
    if (!ENCODE.allEncoded.has(idx)) ENCODE.allEncoded.set(idx, new Map());
    ENCODE.allEncoded.get(idx).set(fmtFromMime, enc);
    markThumbEncoding(idx, false);
    if (CFLOW.selected === idx) {
      const revokePending = () => {
        if (ENCODE.pendingRevokes && ENCODE.pendingRevokes.length) {
          ENCODE.pendingRevokes.forEach(u => { try { URL.revokeObjectURL(u); } catch(_){} });
          ENCODE.pendingRevokes = [];
        }
      };
      const clearReencoding = () => {
        if (CFLOW.selected === idx) document.body.dataset.reencoding = '';
      };
      if (enc.format === 'ico') {
        setBg(after, f.url);
        setMetaCorners(f.file, enc);
        setHasAfter(true);
        hideCenterStatus();
        revokePending();
        clearReencoding();
      } else {
        /* Preload + decode the new blob BEFORE swapping the bg. Old URL
           stays valid (held in pendingRevokes) until AFTER the swap, so
           the canvas never blanks. Revoke happens once the new image
           is painted. */
        const myGen = ENCODE.gen;
        setBgPreloaded(after, enc.url).then(() => {
          if (myGen !== ENCODE.gen || CFLOW.selected !== idx) return;
          setMetaCorners(f.file, enc);
          setHasAfter(true);
          hideCenterStatus();
          revokePending();
          clearReencoding();
        });
      }
    }
  } catch (err) {
    console.warn('[beta encode failed]', err);
    markThumbEncoding(idx, false);
    /* Tear down the suppression so the failure overlay can paint
       immediately even if we\'re still inside the 1000ms defer window. */
    clearDeferCenterStatus();
    /* Show the failure inline in the centered overlay so user knows it
       didn't hang — much more visible than the corner toast was. Under
       preserveView the canvas still shows the OLD image; the overlay
       just communicates that the latest setting tweak didn't apply. */
    if (CFLOW.selected === idx) {
      showCenterStatus('Encode failed', err && err.message || String(err));
    }
  }
}

/* ===== Background encode queue =====
   Drops on N files? We start encoding ALL of them right away (one at a
   time — the worker is single-threaded). When the user clicks a thumb
   that hasn't finished yet, we bumpToFront the selected idx so the next
   slot the worker grabs is the one the user is staring at. The currently
   in-flight encode can't be cancelled mid-flight, but it'll finish in
   under a second for typical photos and the bumped idx is next. */
function enqueueAll(){
  for (let i = 0; i < FILES.length; i++) {
    if (ENCODE.encoded.has(i)) continue;
    if (ENCODE.inflight.has(i)) continue;
    if (ENCODE.queue.indexOf(i) !== -1) continue;
    ENCODE.queue.push(i);
    /* Mark the thumb so the user can see "in line" vs "actively encoding" */
    const t = CFLOW.thumbs[i];
    if (t) t.classList.add('queued');
  }
  processQueue();
}
async function processQueue(){
  if (ENCODE.queueRunning) return;
  ENCODE.queueRunning = true;
  try {
    while (ENCODE.queue.length > 0) {
      /* Skip indices that completed since they were enqueued (e.g. user
         hit them via syncMainImage and the result already landed). */
      const idx = ENCODE.queue.shift();
      if (idx == null) continue;
      /* About to encode — drop the queued badge; encodeFile will set the
         .encoding badge itself. */
      const t = CFLOW.thumbs[idx];
      if (t) t.classList.remove('queued');
      if (ENCODE.encoded.has(idx)) continue;
      const myGen = ENCODE.gen;
      try {
        /* Multi-output mode: encode every active format for this idx and
           store the bundle in ENCODE.allEncoded[idx]. PRIMARY (the first
           active format) populates ENCODE.encoded as before so the compare
           canvas keeps working. */
        const formats = MULTI_OUT.enabled ? getActiveFormats() : [null];
        let primary = null;
        const bundle = new Map();
        for (const f of formats) {
          if (myGen !== ENCODE.gen) break;
          let blob;
          try { blob = await encodeFile(idx, f); }
          catch(e){ console.warn('[queue encode failed]', idx, f, e && e.message || e); continue; }
          if (myGen !== ENCODE.gen) break;
          const url = URL.createObjectURL(blob);
          const fmt = mimeToFmt(blob.type);
          const _od2 = ENCODE.outDims.get(idx); /* R46 */
          const entry = { blob, url, size: blob.size, format: fmt, outW: _od2 ? _od2.outW : 0, outH: _od2 ? _od2.outH : 0 };
          bundle.set(fmt, entry);
          if (!primary) primary = entry;
        }
        if (myGen !== ENCODE.gen) continue;
        if (primary) {
          ENCODE.encoded.set(idx, primary);
          ENCODE.allEncoded.set(idx, bundle);
        }
        markThumbEncoding(idx, false);
        if (CFLOW.selected === idx && typeof syncMainImage === 'function') {
          /* preserveView: this is an *update* of the currently-displayed
             image, not a selection swap. Don't reset zoom; don't blank
             the meta. The cached path inside syncMainImage will simply
             setBg(after, enc.url) and refresh the After meta. */
          syncMainImage(true, { preserveView: true });
        }
      } catch (e) {
        markThumbEncoding(idx, false);
        if (myGen === ENCODE.gen) console.warn('[queue encode failed]', idx, e && e.message || e);
      }
    }
  } finally {
    ENCODE.queueRunning = false;
  }
}
/* bumpToFront — the priority lever. When user selects an unencoded idx,
   move it to the head of the queue. Doesn't preempt the currently
   in-flight encode (worker can't cancel) but ensures it's next in line. */
function bumpToFront(idx){
  if (ENCODE.encoded.has(idx)) return;       /* already done */
  if (ENCODE.inflight.has(idx)) return;      /* already encoding */
  const pos = ENCODE.queue.indexOf(idx);
  if (pos >= 0) ENCODE.queue.splice(pos, 1);
  ENCODE.queue.unshift(idx);
  processQueue();
}

/* When settings change: invalidate cache + re-render the focused image
   + restart the background queue with the new settings.

   The generation counter (ENCODE.gen) is the trick that makes mid-flight
   encodes safe — the queue worker discards any blob whose gen doesn't
   match. Without it, an in-flight encode using the OLD quality would
   land in encoded after we've cleared the cache, leaving us with a
   single stale result that mismatches every other thumb. */
function invalidateEncoded(){
  ENCODE.gen++;
  /* Defer URL revocation: holding the old blob URLs alive keeps the
     previously-rendered After image visible on the canvas while the new
     encode runs. They're revoked lazily once syncMainImage paints the
     fresh result (or on the next invalidateEncoded if the user keeps
     hammering the slider). Without this delay, every settings tweak
     would briefly black-out the canvas. */
  const pending = ENCODE.pendingRevokes || [];
  ENCODE.encoded.forEach(e => { if (e && e.url) pending.push(e.url); });
  ENCODE.allEncoded.forEach(m => m.forEach(e => { if (e && e.url) pending.push(e.url); }));
  ENCODE.pendingRevokes = pending;
  ENCODE.encoded.clear();
  ENCODE.allEncoded.clear();
  ENCODE.queue.length = 0;
  CFLOW.prevSelected = -1;
  /* Suppress the center loader for 2000ms — every showCenterStatus
     call (worker progress, syncMainImage, processQueue) is gated.
     Sub-2s re-encodes never paint the pill at all; the small qr-spinner
     inside the quality selector is the only feedback. Genuinely slow
     encodes (>2s) surface the pill after the window expires. */
  document.body.dataset.reencoding = 'on';
  deferCenterStatus(2000);
  /* preserveView=true: don't reset zoom, keep the old After image up. */
  syncMainImage(true, { preserveView: true });
  enqueueAll();
}

/* ===== UX-E: scroll/pinch zoom + drag pan on the main canvas =====
   Same pattern as stable's fullscreen editor: scroll wheel zooms toward the
   cursor, drag pans once zoomed, double-click toggles 1x ↔ 2x, two-finger
   pinch on touch. Zoom resets to 1x whenever the selected file changes
   (handled inside syncMainImage above).
   The transform is applied to the .compare-zoom wrapper so cbBefore + cbAfter
   stay perfectly aligned for the compare slider. */
const ZOOM = { scale: 1, x: 0, y: 0, dragging: false, lastX: 0, lastY: 0, pinchDist: 0, _lastShownScale: 1 };
/* Canvas width cache — read once per resize. Reading
   getBoundingClientRect() inside applyZoom forces a synchronous layout
   flush mid-batch (write wrap.transform → READ rect → write divider/
   handle), which is the classic jitter signature on compare sliders
   under continuous zoom/pan input. Cache it and invalidate on resize. */
let _canvasWidthCache = 0;
function _canvasWidth(){
  if (_canvasWidthCache > 0) return _canvasWidthCache;
  const canvas = document.querySelector('body[data-state="multi"] .stage.multi .image-canvas');
  if (!canvas) return 0;
  _canvasWidthCache = canvas.getBoundingClientRect().width;
  return _canvasWidthCache;
}
window.addEventListener('resize', () => { _canvasWidthCache = 0; });
function applyZoom(){
  const wrap = document.querySelector('body[data-state="multi"] .stage.multi .compare-zoom');
  const canvas = document.querySelector('body[data-state="multi"] .stage.multi .image-canvas');
  if (!wrap || !canvas) return;
  wrap.style.transform = `translate(${ZOOM.x}px, ${ZOOM.y}px) scale(${ZOOM.scale})`;
  canvas.classList.toggle('zoomed', ZOOM.scale > 1.001);
  /* Slider stays at its SCREEN x while pan/zoom changes the image under
     it. refreshSliderFromZoom recomputes the LOCAL pct that keeps the
     divider visually anchored where the user dragged it. */
  if (typeof window.refreshSliderFromZoom === 'function') {
    window.refreshSliderFromZoom();
  }
  /* Divider transform is now driven entirely by setSplit() in one
     atomic write — keeping it here would compete on the same property
     and cause a 1-frame visual mismatch jitter during pan/zoom. */
  /* Zoom-level chip — show + auto-fade ONLY when scale actually changed.
     Without the change-check, every syncMainImage → resetZoom → applyZoom
     would flash the chip on selection swaps even though no zoom happened. */
  const chip = document.getElementById('zoomChip');
  if (chip && ZOOM._lastShownScale !== ZOOM.scale) {
    ZOOM._lastShownScale = ZOOM.scale;
    chip.textContent = Math.round(ZOOM.scale * 100) + '%';
    chip.classList.add('show');
    if (ZOOM._chipTimer) clearTimeout(ZOOM._chipTimer);
    ZOOM._chipTimer = setTimeout(() => chip.classList.remove('show'), 1200);
  }
}
function resetZoom(){
  ZOOM.scale = 1; ZOOM.x = 0; ZOOM.y = 0;
  ZOOM.dragging = false; ZOOM.pinchDist = 0;
  applyZoom();
}
function setZoomToward(nextScale, cursorX, cursorY){
  const canvas = document.querySelector('body[data-state="multi"] .stage.multi .image-canvas');
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const mx = cursorX - r.left - r.width/2;
  const my = cursorY - r.top  - r.height/2;
  const nz = Math.max(1, Math.min(6, nextScale));
  if (nz === ZOOM.scale) return;
  /* Pan adjustment so the point under the cursor stays under the cursor */
  const factor = nz / ZOOM.scale;
  ZOOM.x = mx - (mx - ZOOM.x) * factor;
  ZOOM.y = my - (my - ZOOM.y) * factor;
  ZOOM.scale = nz;
  if (ZOOM.scale <= 1) { ZOOM.x = 0; ZOOM.y = 0; }
  applyZoom();
}
function wireZoom(){
  const canvas = document.querySelector('body[data-state="multi"] .stage.multi .image-canvas');
  if (!canvas || canvas.dataset.zoomWired) return;
  canvas.dataset.zoomWired = '1';
  /* wheel zoom */
  canvas.addEventListener('wheel', e => {
    /* let the cover-flow keep its existing wheel-to-scroll behavior — only
       zoom when the wheel is over the canvas area, not the cover-flow strip */
    if (e.target.closest('.cover-flow') || e.target.closest('.menu-card')) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.18 : 0.18;
    setZoomToward(ZOOM.scale + delta, e.clientX, e.clientY);
  }, { passive: false });
  /* double-click toggles 1x ↔ 2.5x at cursor */
  canvas.addEventListener('dblclick', e => {
    if (e.target.closest('.compare-handle')) return;
    if (ZOOM.scale > 1) resetZoom();
    else setZoomToward(2.5, e.clientX, e.clientY);
  });
  /* drag-to-pan when zoomed in. Skip if the user grabbed the slider
     handle — that gesture belongs to wireSlider regardless of zoom level. */
  canvas.addEventListener('pointerdown', e => {
    if (ZOOM.scale <= 1) return;
    if (e.target.closest('.compare-handle')) return;
    if (e.target.closest('.menu-card')) return;
    if (e.target.closest('.compare-meta')) return;
    if (e.target.closest('.cover-flow')) return;
    if (e.target.closest('.brand-bar')) return;
    if (e.target.closest('.pi-actions')) return;
    if (e.target.closest('button')) return;
    ZOOM.dragging = true;
    ZOOM.lastX = e.clientX; ZOOM.lastY = e.clientY;
    canvas.classList.add('zoom-dragging');
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!ZOOM.dragging) return;
    ZOOM.x += e.clientX - ZOOM.lastX;
    ZOOM.y += e.clientY - ZOOM.lastY;
    ZOOM.lastX = e.clientX; ZOOM.lastY = e.clientY;
    applyZoom();
  });
  const endDrag = (e) => {
    ZOOM.dragging = false;
    canvas.classList.remove('zoom-dragging');
    try { canvas.releasePointerCapture(e.pointerId); } catch(_){}
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  /* touch pinch — track 2-finger distance */
  canvas.addEventListener('touchmove', e => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (ZOOM.pinchDist > 0) {
      const sc = dist / ZOOM.pinchDist;
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      setZoomToward(ZOOM.scale * sc, cx, cy);
    }
    ZOOM.pinchDist = dist;
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    if (e.touches.length < 2) ZOOM.pinchDist = 0;
  });
  /* Block right-click on the canvas to prevent users from saving the
     ORIGINAL image through "Save image as…" instead of using the
     compressed Download button. Same intent as stable's
     `oncontextmenu="return false"` on .fs-inner. */
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  /* Click-anywhere divider snap — handled inside wireSlider's pointerdown
     instead of a separate click handler. The pointerdown approach lets the
     user keep dragging from the snap point without releasing the mouse,
     which a click-only handler can't do. */

  /* Keyboard:
     +/-/0 zoom (existing)
     Arrow Left/Right cycle thumbs (mirrors stable's fs arrow nav)
     ESC closes the per-image actions overlay if open */
  document.addEventListener('keydown', e => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.body.dataset.state !== 'multi' && document.body.dataset.state !== 'solo') return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomToward(ZOOM.scale + 0.4, window.innerWidth/2, window.innerHeight/2); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoomToward(ZOOM.scale - 0.4, window.innerWidth/2, window.innerHeight/2); }
    else if (e.key === '0') { e.preventDefault(); resetZoom(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      /* Cycle thumbs (skip the add-more tile at the end). */
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const thumbCount = (typeof CFLOW !== 'undefined' && CFLOW.thumbs) ? CFLOW.thumbs.length : 0;
      if (thumbCount <= 1) return;
      let next = CFLOW.selected + dir;
      const lastImageIdx = thumbCount - 2; /* -1 is add-more, -2 is last image */
      if (next < 0) next = lastImageIdx;
      if (next > lastImageIdx) next = 0;
      e.preventDefault();
      if (typeof selectIndex === 'function') selectIndex(next);
    }
    else if (e.key === 'Escape') {
      if (document.body.dataset.piActions === 'open') {
        document.body.dataset.piActions = 'closed';
        e.preventDefault();
      }
    }
  });
}

/* ===== thumb click: select OR open per-image actions ===== */
function onThumbClick(i, e){
  if (CFLOW._suppressClick) { CFLOW._suppressClick = false; return; }
  const thumb = CFLOW.thumbs[i];
  /* Add-more tile: clicking it opens the file picker (mock) — don't select */
  if (thumb && thumb.classList.contains('add-more')) {
    /* the click handler set in buildThumbs already fires alert() */
    return;
  }
  if (i === CFLOW.selected && Math.abs(CFLOW.drift) < 0.05) {
    openPiActions();
  } else {
    selectIndex(i);
  }
}
function selectIndex(i){
  i = Math.max(0, Math.min(CFLOW.thumbs.length - 1, i));
  CFLOW.selected = i; CFLOW.drift = 0; CFLOW.vel = 0;
  document.body.dataset.piActions = 'closed';
  layoutCoverFlow();
  syncMainImage();
}

/* ===== per-image actions: hover + 2nd click + 3s timer ===== */
let piTimer = null;
function openPiActions(){
  /* Don't open hover actions while the active thumb is encoding —
     the actions reference a result that doesn't exist yet. CSS also
     disables them visually via .cflow-track:has(.cflow-thumb.active.encoding). */
  const activeThumb = document.querySelector('.cflow-thumb.active');
  if (activeThumb && activeThumb.classList.contains('encoding')) return;
  document.body.dataset.piActions = 'open';
  resetPiTimer();
}
function resetPiTimer(){
  if (piTimer) clearTimeout(piTimer);
  piTimer = setTimeout(() => {
    /* Don't close while a confirm is in flight — piConfirm will restart
       this timer when the confirm fades. */
    if (document.body.dataset.piConfirm === 'on') return;
    document.body.dataset.piActions = 'closed';
  }, 3000);
}
/* Delegated hover: any pointer movement over an active thumb opens pi-actions
   and refreshes the timer. Uses pointerover for reliable bubbling. */
function attachHoverDelegation(){
  const flow = document.getElementById('coverFlow');
  flow.addEventListener('pointerover', e => {
    if (CFLOW.draggingFrom) return;
    if (e.pointerType === 'touch') return;  /* mobile uses 2nd-tap, not hover */
    const t = e.target.closest('.cflow-thumb');
    if (!t) return;
    if (!t.classList.contains('active')) return;
    if (t.classList.contains('add-more')) return;  /* no per-image actions for the add tile */
    if (document.body.dataset.piActions === 'open') resetPiTimer();
    else openPiActions();
  });
}
/* Persistent invisible hover zone around the active thumb.
   State machine on zone entry/exit:
     - Cursor ENTERS zone:
         * if pi-actions closed -> open them
         * CLEAR piTimer so icons stay open indefinitely while in zone
     - Cursor LEAVES zone:
         * arm a 3s close timer via resetPiTimer()
     - Cursor moves WITHIN zone: no-op (timer already cleared)
     - Cursor moves OUTSIDE zone: no-op (timer already counting)
   The freeze-while-inside semantics is important — without it,
   stopping the cursor on the delete button while deciding whether
   to click would let the timer run out and close the icons. */
const PI_HOVER_ZONE_ABOVE = 80;  /* px above thumb top to cover icon area */
const PI_HOVER_ZONE_SLACK = 8;
let _piLastInZone = false;
document.addEventListener('mousemove', e => {
  if (e.pointerType === 'touch') return;
  const activeThumb = document.querySelector('.cflow-thumb.active');
  if (!activeThumb || activeThumb.classList.contains('add-more')) {
    if (_piLastInZone) {
      _piLastInZone = false;
      resetPiTimer();  /* leaving the zone -> arm close timer */
    }
    return;
  }
  const r = activeThumb.getBoundingClientRect();
  const left   = r.left   - PI_HOVER_ZONE_SLACK;
  const right  = r.right  + PI_HOVER_ZONE_SLACK;
  const top    = r.top    - PI_HOVER_ZONE_ABOVE;
  const bottom = r.bottom + PI_HOVER_ZONE_SLACK;
  const inZone = e.clientX >= left && e.clientX <= right &&
                 e.clientY >= top  && e.clientY <= bottom;
  if (inZone && !_piLastInZone) {
    /* Just ENTERED zone: open icons (if closed) + freeze timer */
    if (document.body.dataset.piActions !== 'open' && !CFLOW.draggingFrom) {
      openPiActions();
    }
    /* openPiActions arms a 3s timer; clear it so icons stay open
       indefinitely while cursor remains in zone */
    if (piTimer) { clearTimeout(piTimer); piTimer = null; }
    _piLastInZone = true;
  } else if (!inZone && _piLastInZone) {
    /* Just EXITED zone: arm the close countdown */
    _piLastInZone = false;
    if (document.body.dataset.piActions === 'open') resetPiTimer();
  }
  /* else: still-in or still-out -> no-op (timer already in right state) */
});
document.addEventListener('click', e => {
  if (document.body.dataset.piActions !== 'open') return;
  if (e.target.closest('.pi-icon')) return;
  if (e.target.closest('.cflow-thumb.active')) return;
  document.body.dataset.piActions = 'closed';
});

/* ===== drag / momentum ===== */
function onPointerDown(e){
  if (e.target.closest('.pi-icon')) return;
  CFLOW.draggingFrom = { x: e.clientX, t: performance.now(), startSel: CFLOW.selected };
  CFLOW.lastX = e.clientX; CFLOW.lastT = performance.now();
  CFLOW.vel = 0; CFLOW._dragMoved = false;
  document.getElementById('coverFlow').classList.add('dragging');
  document.body.dataset.piActions = 'closed';
  cancelAnimationFrame(CFLOW.rafId);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp, {once:true});
  e.preventDefault();
}
function onPointerMove(e){
  if (!CFLOW.draggingFrom) return;
  const dx = e.clientX - CFLOW.draggingFrom.x;
  const stride = CFLOW.STRIDE;
  CFLOW.drift = -dx / stride;
  if (Math.abs(dx) > 4) CFLOW._dragMoved = true;
  const now = performance.now();
  const dt = Math.max(1, now - CFLOW.lastT);
  CFLOW.vel = -(e.clientX - CFLOW.lastX) / stride / dt * 16;
  CFLOW.lastX = e.clientX; CFLOW.lastT = now;
  /* clamp at boundaries — last *image* (not Add-more) is the natural end */
  const LAST_IMG = CFLOW.thumbs.length - 2;
  const target = CFLOW.draggingFrom.startSel + CFLOW.drift;
  if (target < 0) CFLOW.drift = -CFLOW.draggingFrom.startSel;
  if (target > LAST_IMG) CFLOW.drift = LAST_IMG - CFLOW.draggingFrom.startSel;
  layoutCoverFlow();
  /* don't sync main image during drag */
}
function onPointerUp(){
  document.removeEventListener('pointermove', onPointerMove);
  document.getElementById('coverFlow').classList.remove('dragging');
  CFLOW.draggingFrom = null;
  CFLOW._suppressClick = CFLOW._dragMoved;
  if (Math.abs(CFLOW.vel) > 0.02) {
    runMomentum();
  } else {
    settleSelection();
  }
}
function runMomentum(){
  const LAST_IMG = CFLOW.thumbs.length - 2;
  const tick = () => {
    CFLOW.vel *= 0.93;
    CFLOW.drift += CFLOW.vel;
    while (CFLOW.drift > 0.5 && CFLOW.selected < LAST_IMG) {
      CFLOW.selected++; CFLOW.drift -= 1;
    }
    while (CFLOW.drift < -0.5 && CFLOW.selected > 0) {
      CFLOW.selected--; CFLOW.drift += 1;
    }
    /* boundary kill */
    if ((CFLOW.selected <= 0 && CFLOW.drift < 0) || (CFLOW.selected >= LAST_IMG && CFLOW.drift > 0)) {
      CFLOW.drift = 0; CFLOW.vel = 0;
    }
    layoutCoverFlow();
    if (Math.abs(CFLOW.vel) < 0.02) {
      settleSelection();
      return;
    }
    CFLOW.rafId = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(CFLOW.rafId);
  CFLOW.rafId = requestAnimationFrame(tick);
}
function settleSelection(){
  /* Snap target is the last *image* (not Add-more); Add-more is click-only */
  const LAST_IMG = CFLOW.thumbs.length - 2;
  CFLOW.selected = Math.round(CFLOW.selected + CFLOW.drift);
  CFLOW.selected = Math.max(0, Math.min(LAST_IMG, CFLOW.selected));
  CFLOW.drift = 0; CFLOW.vel = 0;
  layoutCoverFlow();
  syncMainImage();
}

/* Wheel: directly accumulate drift instead of feeding into velocity-decay
   (which snaps too quickly with the tightened 0.02 threshold for small
   trackpad deltas). After 160ms of no wheel input, settle/snap. */
let _wheelDebounce = null;
function onWheel(e){
  e.preventDefault();
  document.body.dataset.piActions = 'closed';
  cancelAnimationFrame(CFLOW.rafId);
  CFLOW.vel = 0;
  const delta = (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
  /* ~70px wheel per index step — feels close to one mouse-wheel notch per image */
  CFLOW.drift += delta / 70;
  /* Roll drift into selected when it crosses ±0.5 */
  /* Cap natural cycling at the last actual image (one before Add-more).
     Add-more is only reachable by direct click — gesture won't carry into it. */
  const LAST_IMG = CFLOW.thumbs.length - 2;
  while (CFLOW.drift > 0.5 && CFLOW.selected < LAST_IMG) {
    CFLOW.selected++; CFLOW.drift -= 1;
  }
  while (CFLOW.drift < -0.5 && CFLOW.selected > 0) {
    CFLOW.selected--; CFLOW.drift += 1;
  }
  if (CFLOW.selected <= 0 && CFLOW.drift < 0) CFLOW.drift = 0;
  if (CFLOW.selected >= LAST_IMG && CFLOW.drift > 0) CFLOW.drift = 0;
  layoutCoverFlow();
  clearTimeout(_wheelDebounce);
  _wheelDebounce = setTimeout(() => settleSelection(), 160);
}

/* ===== per-image actions ===== */
/* Tiny tooltip confirmation that pops above a pi-icon button after a
   successful action. Mirrors stable's per-card "Copied!" feedback so the
   user has explicit confirmation the click registered. */
const PI_CONFIRM_MS = 1800;  /* 1.8s — long enough to register, short enough not to feel lazy */
function piConfirm(btn, message){
  if (!btn) return;
  /* Tooltip (the explicit verb) */
  let toast = btn.querySelector('.pi-toast');
  if (!toast) {
    toast = document.createElement('span');
    toast.className = 'pi-toast';
    btn.appendChild(toast);
  }
  toast.textContent = message;
  /* Checkmark overlay — same SVG every time, lazy-injected on first
     confirmation so we don't bloat the initial DOM. */
  let check = btn.querySelector('.pi-check');
  if (!check) {
    check = document.createElement('span');
    check.className = 'pi-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.appendChild(check);
  }
  btn.classList.add('confirmed');
  /* Force pi-actions overlay to stay OPEN while the confirm is showing.
     Without this, the 3s hover timer can close the overlay mid-confirm
     (especially if user hovered for a bit before clicking) — they'd see
     a flash of green and then nothing. */
  document.body.dataset.piActions = 'open';
  document.body.dataset.piConfirm = 'on';
  /* Cancel any in-flight pi-actions auto-close while we're confirming */
  if (typeof piTimer !== 'undefined' && piTimer) clearTimeout(piTimer);
  if (btn._confirmTimer) clearTimeout(btn._confirmTimer);
  btn._confirmTimer = setTimeout(() => {
    btn.classList.remove('confirmed');
    document.body.dataset.piConfirm = '';
    /* After confirm fades, restart the normal hover-close timer so the
       overlay still goes away if the user has moved on. */
    if (typeof resetPiTimer === 'function') resetPiTimer();
  }, PI_CONFIRM_MS);
}

/* piCopy: copy the encoded blob of the focused image to the clipboard. We
   prefer the modern Clipboard API with image/* support (Chrome, Edge,
   recent Safari/Firefox). On unsupported browsers we silently fail back
   to nothing — this is a nice-to-have, not core. */
async function piCopy(btn){
  const idx = CFLOW.selected;
  const enc = ENCODE.encoded.get(idx);
  if (!enc || !enc.blob) return;
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('clipboard api unavailable');
    /* Browser clipboard image support is image/png only (universally —
       Chrome rejects image/jpeg, Safari only accepts image/png, Firefox
       same). Always convert to PNG regardless of source. The Promise<Blob>
       form preserves the user-gesture context across the async conversion. */
    const blobPromise = enc.blob.type === 'image/png'
      ? Promise.resolve(enc.blob)
      : createImageBitmap(enc.blob).then(bmp => {
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext('2d');
          /* JPEG-style background fill so transparent PNG sources don't
             come out with checkerboard background after the copy. */
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, bmp.width, bmp.height);
          ctx.drawImage(bmp, 0, 0);
          return c.convertToBlob({ type: 'image/png' });
        });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
    piConfirm(btn, 'Copied!');
  } catch (err) {
    console.warn('[beta piCopy] failed', err && err.message || err);
    /* Surface the failure so the user knows to try again — silent failure
       was the original bug report. */
    piConfirm(btn, 'Copy failed');
  }
}
async function piShare(){
  const idx = CFLOW.selected;
  const f = FILES[idx];
  if (!f) return;
  let enc = ENCODE.encoded.get(idx);
  if (!enc) {
    try { const blob = await encodeFile(idx);
      const url = URL.createObjectURL(blob);
      enc = { blob, url, size: blob.size, format: mimeToFmt(blob.type) };
      ENCODE.encoded.set(idx, enc);
    } catch(e){ alert('Encode failed: '+e.message); return; }
  }
  const base = f.file.name.replace(/\.[^.]+$/, '');
  const ext = enc.format || 'jpg';
  const file = new File([enc.blob], `${base}_imgready.${ext}`, { type: enc.blob.type });
  const shareBtn = document.querySelector('#piActions .pi-icon[title="Share this"]');
  /* shareBtn may be null if the pi-actions overlay was removed mid-flow
     (e.g., user clicked Clear All while share was awaiting). piConfirm
     already null-checks btn but we'd rather not call it at all. */
  if (navigator.canShare && navigator.canShare({ files:[file] })) {
    try {
      await navigator.share({ files:[file], title: 'imgready' });
      piConfirm(shareBtn, 'Shared');
    } catch(err){
      /* AbortError = user dismissed share sheet (no toast). Other errors =
         actual failure (toast). Distinguishing prevents the green check
         from showing when the user explicitly cancelled. */
      if (err && err.name !== 'AbortError') {
        console.warn('[beta piShare] failed', err && err.message || err);
        piConfirm(shareBtn, 'Share failed');
      }
    }
  } else {
    /* Web Share unsupported (most desktop browsers) — fall back to a plain
       download. Use the Share button to confirm because that's the button
       the user clicked. */
    triggerDownload(enc.url, `${base}_imgready.${ext}`);
    piConfirm(shareBtn, 'Downloaded');
  }
}
async function piDownload(){
  const idx = CFLOW.selected;
  const f = FILES[idx];
  if (!f) return;
  const base = f.file.name.replace(/\.[^.]+$/, '');
  const btn = document.querySelector('#piActions .pi-icon[title="Download this"]');
  /* Multi-output: bundle every encoded format as a zip via JSZip
     (already self-hosted at /vendor/jszip.min.js for the existing
     download-all flow). Each entry uses its own _imgready.{ext} name. */
  if (MULTI_OUT.enabled) {
    const bundle = ENCODE.allEncoded.get(idx);
    if (!bundle || bundle.size === 0) {
      try { await encodeFile(idx); } catch(_){}
    }
    const finalBundle = ENCODE.allEncoded.get(idx);
    if (finalBundle && finalBundle.size > 0) {
      const JSZipMod = window.JSZip || (await loadJSZip());
      if (!JSZipMod) { /* fall through to single download */ }
      else {
        const zip = new JSZipMod();
        finalBundle.forEach(e => {
          zip.file(`${base}_imgready.${e.format}`, e.blob);
        });
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        triggerDownload(url, `${base}_imgready.zip`);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        piConfirm(btn, 'Downloaded');
        return;
      }
    }
  }
  /* Single-format path */
  let enc = ENCODE.encoded.get(idx);
  if (!enc) {
    try { const blob = await encodeFile(idx);
      const url = URL.createObjectURL(blob);
      enc = { blob, url, size: blob.size, format: mimeToFmt(blob.type) };
      ENCODE.encoded.set(idx, enc);
    } catch(e){ alert('Encode failed: '+e.message); return; }
  }
  const ext = enc.format || 'jpg';
  triggerDownload(enc.url, `${base}_imgready.${ext}`);
  piConfirm(btn, 'Downloaded');
}
/* Lazy-load JSZip from the self-hosted vendor copy. */
function loadJSZip(){
  return new Promise(resolve => {
    if (window.JSZip) return resolve(window.JSZip);
    const s = document.createElement('script');
    s.src = '/vendor/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
  });
}
function triggerDownload(url, filename){
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { try { a.remove(); } catch(_){} }, 1000);
}
/* ============================================================
   EDIT MODE — second workflow surface. State held in _editState
   while the modal is open. On Save the pending edits are applied
   to FILES[idx].file (a new source blob) and the encode pipeline
   re-runs from that source. Optimize/convert flow is untouched —
   it just sees a different source file after Save.
   ============================================================ */
const _editState = {
  active: false, idx: -1,
  originalFile: null, originalUrl: null, fileType: null,
  pendingEdits: {},
  rotateState: { deg: 0, flipH: false, flipV: false, angle: 0 },
  framesState: null, bgState: null,
  _undoStack: [], _redoStack: [],
  _splitActive: false,
};
function _detectEditFileType(file){
  const ext = (file.name || '').toLowerCase().split('.').pop();
  const type = (file.type || '').toLowerCase();
  if (ext === 'gif' || type === 'image/gif') return 'gif';
  if (ext === 'png' || type === 'image/png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg' || type === 'image/jpeg') return 'jpg';
  if (ext === 'webp' || type === 'image/webp') return 'webp';
  if (ext === 'avif' || type === 'image/avif') return 'avif';
  if (ext === 'heic' || ext === 'heif' || type === 'image/heic' || type === 'image/heif') return 'heic';
  if (ext === 'tif' || ext === 'tiff') return 'tiff';
  if (ext === 'bmp') return 'bmp';
  if (ext === 'svg') return 'svg';
  if (ext === 'ico') return 'ico';
  return 'other';
}
/* R20 - 5 categorized photo tabs (Apple Photos / Pixlr X pattern).
   Transform groups Rotate+Crop; Retouch groups Pixelate+Blur. Each
   group exposes a sub-toggle inside the panel body so the surface is
   identical to the previous flat layout, just nested one level. */
/* R31 — flat camera-roll strip: each tool is a direct top-level
   button. Removed the grouped Transform/Retouch meta-tabs that hid
   Rotate, Crop, Pixelate and Blur behind a sub-toggle. The existing
   renderers (_renderRotateTab, _renderCropTab, etc.) are unchanged;
   they now get called directly from _switchEditTab. */
function _editTabsForType(t){
  const isPhoto = (t === 'png' || t === 'jpg' || t === 'webp' || t === 'avif' || t === 'heic');
  const tabs = [];
  if (t === 'gif') {
    tabs.push({ id: 'frames',   label: 'Frames',  icon: 'i-arrow-left-right' });
    return tabs;
  }
  if (isPhoto) {
    /* R76/R86 — Hid Pixelate / Text / Remove BG per user audit:
       half-baked features dilute the conversion-first SEO message.
       Renderers remain in code (no breakage) but tab buttons are
       not exposed. */
    tabs.push({ id: 'adjust',   label: 'Adjust',  icon: 'i-sliders-horizontal' });
    tabs.push({ id: 'filters',  label: 'Filters', icon: 'i-palette' });
    tabs.push({ id: 'rotate',   label: 'Rotate',  icon: 'i-rotate-cw' });
    tabs.push({ id: 'crop',     label: 'Crop',    icon: 'i-crop' });
  } else {
    tabs.push({ id: 'rotate',   label: 'Rotate',  icon: 'i-rotate-cw' });
    tabs.push({ id: 'crop',     label: 'Crop',    icon: 'i-crop' });
  }
  return tabs;
}
function piEdit(){
  const idx = CFLOW.selected;
  if (typeof FILES === 'undefined' || !FILES[idx]) return;
  openEditMode(idx);
  document.body.dataset.piActions = 'closed';
}
function openEditMode(idx){
  if (!FILES[idx]) return;
  const f = FILES[idx];
  _editState.active = true;
  _editState.idx = idx;
  /* Round 11 HEIC fix: most canvas paths (createImageBitmap, autoEnhance,
   * bgRefine, save pipeline) call into the originalFile blob directly. Raw
   * HEIC blobs are NOT decodable by Chrome/Firefox/Edge — only Safari does
   * it natively. We already decoded HEIC to a JPEG blob in addFilesFromList
   * (stored as f.decodedBlob). Use that here. f.file remains the original
   * HEIC for metadata + encoder-level use. */
  _editState.originalFile = f.decodedBlob || f.file;
  /* Round 17 HEIC fix: f.url is a blob URL for the RAW HEIC, which
   * Chrome/Firefox/Edge can't decode. When we have a decoded JPEG blob,
   * mint a dedicated URL for it so every Edit-mode preview (<img>, CSS
   * background-image) and the transformers.js BG pipeline see a real,
   * renderable image. cancelEdit revokes it via _decodedOwnUrl. */
  if (f.decodedBlob && f.decodedBlob !== f.file){
    _editState._decodedOwnUrl = URL.createObjectURL(f.decodedBlob);
    _editState.originalUrl = _editState._decodedOwnUrl;
  } else {
    _editState._decodedOwnUrl = null;
    _editState.originalUrl = f.url;
  }
  _editState.fileType = _detectEditFileType(f.file);
  _editState.pendingEdits = {};
  _editState.rotateState = { deg: 0, flipH: false, flipV: false, angle: 0 };
  _editState._undoStack = []; _editState._redoStack = [];
  _editState.framesState = null;
  if (_editState.bgState && _editState.bgState.previewUrl) {
    try { URL.revokeObjectURL(_editState.bgState.previewUrl); } catch(_){}
  }
  _editState.bgState = null;
  document.body.dataset.editOpen = 'true';
  const modal = document.getElementById('editModal');
  if (!modal) return;
  modal.removeAttribute('hidden');
  const eb0 = document.getElementById('editBody'); if (eb0) delete eb0.dataset.splitBound;
  const title = document.getElementById('editTitle');
  if (title) title.textContent = (f.name || 'image');
  const tabs = _editTabsForType(_editState.fileType);
  const tabBar = document.getElementById('editTabs');
  tabBar.innerHTML = '';
  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-tab' + (i === 0 ? ' active' : '');
    btn.dataset.tab = t.id;
    /* R20 - every tab gets an icon + label. R22 - title carries shortcut hint. */
    btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + (t.icon || 'i-arrow-left-right') + '"/></svg><span>' + t.label + '</span>';
    btn.title = t.label + ' — ' + (i + 1);
    btn.addEventListener('click', () => _switchEditTab(t.id));
    tabBar.appendChild(btn);
  });
  _switchEditTab(tabs[0].id);
  _updateEditHistoryUI();
  /* R33 — keep split-btn above the card on resize (e.g. virtual keyboard,
     orientation change). One listener per page session. */
  if (!window._editResizeBound) {
    window._editResizeBound = true;
    window.addEventListener('resize', function(){
      requestAnimationFrame(_updateSplitBtnPos);
    }, { passive: true });
  }
  /* R34 — wire zoom once per page load */
  try { _wireEditZoom(); } catch(_){}
}
/* R26 — _updateTabsOverflow + _scrollActiveTabIntoView + _wireTabsOverflowWatcher
   are dead code from R19's horizontal-scroll tab bar. R20 replaced
   those tabs with equal-width flex:1 categorized tabs that don't
   overflow, but these functions were kept calling because the CSS
   classes they toggle (.edit-tabs--overflow-l/-r) used to have
   mask-image rules that are now gone. The toggles were no-ops in
   visible effect. Stub them out to stop the runtime work. */
function _updateTabsOverflow(){ /* R26: noop */ }
/* R31 — revived: scrolls the active tool button into view inside the
   horizontal strip. Uses scrollIntoView with inline:'nearest' so it
   nudges the strip just enough without over-scrolling. */
function _scrollActiveTabIntoView(){
  const active = document.querySelector('.edit-modal .edit-tab-bar .edit-tab.active');
  if (active) active.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'nearest' });
}
let _tabsOverflowWired = false;
function _wireTabsOverflowWatcher(){ /* R26: noop */ }
/* R34 — tools render into editZoomLayer (inside editPreviewCol) so
   CSS transforms on the zoom layer only affect image content, not the
   split-compare button/overlay which live directly on editPreviewCol. */
function _editPreviewEl(){
  return document.getElementById('editZoomLayer') || document.getElementById('editPreviewCol');
}

/* R34 — edit-canvas zoom state, mirrors the main-tool ZOOM object. */
const EDIT_ZOOM = { scale:1, x:0, y:0, dragging:false, lastX:0, lastY:0, pinchDist:0, _chipTimer:null };
function _applyEditZoom(){
  const zl = document.getElementById('editZoomLayer');
  if (!zl) return;
  zl.style.transform = `translate(${EDIT_ZOOM.x}px,${EDIT_ZOOM.y}px) scale(${EDIT_ZOOM.scale})`;
  const chip = document.getElementById('editZoomChip');
  if (!chip) return;
  chip.textContent = Math.round(EDIT_ZOOM.scale * 100) + '%';
  if (EDIT_ZOOM.scale > 1.005){
    chip.classList.add('show');
    if (EDIT_ZOOM._chipTimer) clearTimeout(EDIT_ZOOM._chipTimer);
    EDIT_ZOOM._chipTimer = setTimeout(() => chip.classList.remove('show'), 1200);
  } else {
    chip.classList.remove('show');
  }
}
function _resetEditZoom(){
  EDIT_ZOOM.scale=1; EDIT_ZOOM.x=0; EDIT_ZOOM.y=0;
  EDIT_ZOOM.dragging=false; EDIT_ZOOM.pinchDist=0;
  _applyEditZoom();
}
function _setEditZoomToward(nextScale, cx, cy){
  const col = document.getElementById('editPreviewCol');
  if (!col) return;
  const r = col.getBoundingClientRect();
  const mx = cx - r.left - r.width/2;
  const my = cy - r.top  - r.height/2;
  const nz = Math.max(1, Math.min(6, nextScale));
  if (nz === EDIT_ZOOM.scale) return;
  const f = nz / EDIT_ZOOM.scale;
  EDIT_ZOOM.x = mx - (mx - EDIT_ZOOM.x)*f;
  EDIT_ZOOM.y = my - (my - EDIT_ZOOM.y)*f;
  EDIT_ZOOM.scale = nz;
  if (EDIT_ZOOM.scale <= 1){ EDIT_ZOOM.x=0; EDIT_ZOOM.y=0; }
  _applyEditZoom();
}
function _wireEditZoom(){
  const col = document.getElementById('editPreviewCol');
  if (!col || col.dataset.editZoomWired) return;
  col.dataset.editZoomWired = '1';
  /* wheel zoom — skip when target is inside the bottom pill/card */
  col.addEventListener('wheel', e => {
    if (e.target.closest('.edit-action-pill,.edit-menu-card')) return;
    /* crop has its own canvas; leave wheel alone there */
    if (document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')) return;
    e.preventDefault();
    _setEditZoomToward(EDIT_ZOOM.scale + (e.deltaY > 0 ? -0.18 : 0.18), e.clientX, e.clientY);
  }, { passive:false });
  /* double-click: toggle 1× ↔ 2.5× */
  col.addEventListener('dblclick', e => {
    if (e.target.closest('.edit-action-pill,.edit-menu-card')) return;
    if (document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')) return;
    if (EDIT_ZOOM.scale > 1) _resetEditZoom();
    else _setEditZoomToward(2.5, e.clientX, e.clientY);
  });
  /* drag-to-pan when zoomed */
  col.addEventListener('pointerdown', e => {
    if (EDIT_ZOOM.scale <= 1) return;
    if (e.target.closest('.edit-action-pill,.edit-menu-card,.edit-split-btn,.edit-crop-canvas-wrap,.edit-split-handle')) return;
    EDIT_ZOOM.dragging=true; EDIT_ZOOM.lastX=e.clientX; EDIT_ZOOM.lastY=e.clientY;
    try { col.setPointerCapture(e.pointerId); } catch(_){}
  });
  col.addEventListener('pointermove', e => {
    if (!EDIT_ZOOM.dragging) return;
    EDIT_ZOOM.x += e.clientX - EDIT_ZOOM.lastX;
    EDIT_ZOOM.y += e.clientY - EDIT_ZOOM.lastY;
    EDIT_ZOOM.lastX=e.clientX; EDIT_ZOOM.lastY=e.clientY;
    _applyEditZoom();
  });
  const _endEditDrag = e => { EDIT_ZOOM.dragging=false; try{ col.releasePointerCapture(e.pointerId); }catch(_){} };
  col.addEventListener('pointerup', _endEditDrag);
  col.addEventListener('pointercancel', _endEditDrag);
  /* pinch-to-zoom on touch */
  col.addEventListener('touchmove', e => {
    if (e.touches.length !== 2) return;
    if (document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')) return;
    e.preventDefault();
    const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY;
    const dist=Math.sqrt(dx*dx+dy*dy);
    if (EDIT_ZOOM.pinchDist>0){
      const sc=dist/EDIT_ZOOM.pinchDist;
      _setEditZoomToward(EDIT_ZOOM.scale*sc,
        (e.touches[0].clientX+e.touches[1].clientX)/2,
        (e.touches[0].clientY+e.touches[1].clientY)/2);
    }
    EDIT_ZOOM.pinchDist=dist;
  }, { passive:false });
  col.addEventListener('touchend', e => { if (e.touches.length<2) EDIT_ZOOM.pinchDist=0; });
}

function _switchEditTab(tabId){
  document.querySelectorAll('.edit-modal .edit-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });
  if (typeof _wireTabsOverflowWatcher === 'function') _wireTabsOverflowWatcher();
  /* R31 — scroll active tool into view + trigger slide-up animation. */
  requestAnimationFrame(()=>{
    _scrollActiveTabIntoView();
    const body = document.getElementById('editBody');
    if (body && body.children.length){
      body.classList.remove('anim-in');
      void body.offsetWidth;
      body.classList.add('anim-in');
    }
  });
  /* R30 — Remove any portalled adjust-tab dropdowns from a previous tab
     render. The dropdowns are appended to <body> (not #editBody) so the
     normal body.innerHTML='' below doesn't clean them up. */
  /* R30c — Class-based portal cleanup picks up every tool dropdown. */
  document.querySelectorAll('body > .edit-filter-dd-menu, body > .edit-vignette-dd-menu, body > .edit-adjust-dd-menu, body > .edit-tool-dd-menu').forEach(m => {
    if (m.parentNode === document.body) m.parentNode.removeChild(m);
  });
  const body = document.getElementById('editBody');
  body.innerHTML = '';
  const previewCol = document.getElementById('editPreviewCol');
  if (previewCol) {
    previewCol.innerHTML = '';
    /* R34 — recreate zoom layer; split UI (btn+overlay) will be appended
       by _ensureSplitUi to editPreviewCol directly, outside this layer. */
    const _zl = document.createElement('div');
    _zl.id = 'editZoomLayer'; _zl.className = 'edit-zoom-layer edit-preview-col';
    previewCol.appendChild(_zl);
    _resetEditZoom();
  }
  /* R51 — clear floating section pill before tab content renders;
     _renderAdjustTab and _renderFiltersTab will re-show it. */
  try { _hideAdjSectionPill(); } catch(_){}
  /* R20 routing - grouped tabs delegate to existing renderers via a
     sub-toggle wrapper. Legacy IDs still route for backward-compat. */
  if (tabId === 'frames') _renderFramesTab(body);
  else if (tabId === 'bg') _renderBackgroundTab(body);
  else if (tabId === 'adjust') _renderAdjustTab(body);
  else if (tabId === 'filters') _renderFiltersTab(body);
  else if (tabId === 'transform') _renderTransformTab(body);
  else if (tabId === 'add') { _renderTextTab(body).catch(e => console.warn('[add]', e)); }
  else if (tabId === 'rotate') _renderRotateTab(body);
  else if (tabId === 'crop') { _renderCropTab(body).catch(e => console.warn('[crop]', e)); }
  else if (tabId === 'pixelate') { _renderPixelateTab(body).catch(e => console.warn('[pixelate]', e)); }
  else if (tabId === 'blur') { _renderBlurTab(body).catch(e => console.warn('[blur]', e)); }
  else if (tabId === 'text') { _renderTextTab(body).catch(e => console.warn('[text]', e)); }
  /* Round 10: ensure split-compare UI persists across tab switches. */
  try { _ensureSplitUi(); } catch(_) {}
  /* R45 — recompute pill position after the new tab's options strip
     has measured its height. rAF gives the layout a tick to settle. */
  requestAnimationFrame(() => {
    try { _updateSplitBtnPos(); } catch(_){}
    try { _updateMenuCardH(); } catch(_){}
  });
}
/* R20 wrappers - Transform (Rotate|Crop) and Retouch (Pixelate|Blur). */
function _renderSubToggle(body, items, activeId, onSwitch){
  const wrap = document.createElement('div');
  wrap.className = 'edit-subtoggle';
  wrap.setAttribute('role', 'tablist');
  items.forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'edit-subtab' + (it.id === activeId ? ' active' : '');
    b.dataset.subtab = it.id;
    b.setAttribute('role', 'tab');
    b.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + it.icon + '"/></svg><span>' + it.label + '</span>';
    b.addEventListener('click', () => {
      if (it.id === activeId) return;
      onSwitch(it.id);
    });
    wrap.appendChild(b);
  });
  body.appendChild(wrap);
  const sub = document.createElement('div');
  sub.className = 'edit-subbody';
  sub.id = 'editSubBody';
  body.appendChild(sub);
  return sub;
}
function _renderTransformTab(body){
  const sub = _editState._transformSub || 'rotate';
  _editState._transformSub = sub;
  const subBody = _renderSubToggle(body, [
    { id: 'rotate', label: 'Rotate', icon: 'i-rotate-cw' },
    { id: 'crop',   label: 'Crop',   icon: 'i-scissors' }
  ], sub, (newSub) => {
    _editState._transformSub = newSub;
    body.innerHTML = '';
    _renderTransformTab(body);
    if (typeof _updateSplitBtnState === 'function') _updateSplitBtnState();
  });
  if (sub === 'rotate') _renderRotateTab(subBody);
  else if (sub === 'crop') _renderCropTab(subBody).catch(e => console.warn('[crop]', e));
}
function cancelEdit(){
  /* R30 — Clean up portalled adjust-tab dropdowns (filter / vignette menus
     are appended to <body>, not #editBody, so they wouldn't otherwise be
     removed when the modal closes). */
  /* R30c — Class-based portal cleanup picks up every tool dropdown. */
  document.querySelectorAll('body > .edit-filter-dd-menu, body > .edit-vignette-dd-menu, body > .edit-adjust-dd-menu, body > .edit-tool-dd-menu').forEach(m => {
    if (m.parentNode === document.body) m.parentNode.removeChild(m);
  });
  if (_editState._blurBitmap){ try { _editState._blurBitmap.close && _editState._blurBitmap.close(); } catch(_){} _editState._blurBitmap = null; }
  _editState._blurBaseBlob = null; _editState._blurBaseSig = null;
  /* Round 17 HEIC fix: release the decoded-JPEG blob URL we minted in
   * openEditMode so it doesn't leak between Edit sessions. */
  if (_editState._decodedOwnUrl){
    try { URL.revokeObjectURL(_editState._decodedOwnUrl); } catch(_){}
    _editState._decodedOwnUrl = null;
  }
  document.body.dataset.editOpen = 'false';
  const modal = document.getElementById('editModal');
  if (modal) modal.setAttribute('hidden', '');
  _editState.active = false;
  _editState.pendingEdits = {};
  _editState._splitActive = false;
  if (_editState.framesState && _editState.framesState.frames) {
    _editState.framesState.frames.forEach(fr => { try { fr.bitmap && fr.bitmap.close && fr.bitmap.close(); } catch(_){} });
  }
  _editState.framesState = null;
  if (_editState.bgState){
    if (_editState.bgState._refineBgBmp){ try { _editState.bgState._refineBgBmp.close && _editState.bgState._refineBgBmp.close(); } catch(_){} _editState.bgState._refineBgBmp = null; }
    if (_editState.bgState._refineOrigBmp){ try { _editState.bgState._refineOrigBmp.close && _editState.bgState._refineOrigBmp.close(); } catch(_){} _editState.bgState._refineOrigBmp = null; }
  }
  _editState.bgState = null;
  if (_editState.pendingEdits && _editState.pendingEdits.autoEnhancedUrl){
    try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
  }
  if (_editState._pxBitmap){
    try { _editState._pxBitmap.close && _editState._pxBitmap.close(); } catch(_){}
    _editState._pxBitmap = null;
  }
  _editState._pxBaseUrl && (function(){ try { URL.revokeObjectURL(_editState._pxBaseUrl); } catch(_){} })();
  _editState._pxBaseUrl = null;
  _editState._pxBaseBlob = null;
  if (_editState._txBitmap){
    try { _editState._txBitmap.close && _editState._txBitmap.close(); } catch(_){}
    _editState._txBitmap = null;
  }
  if (_editState._txBaseUrl){ try { URL.revokeObjectURL(_editState._txBaseUrl); } catch(_){} _editState._txBaseUrl = null; _editState._txBaseBlob = null; _editState._txBaseSig = null; }
}
async function saveEdit(){
  const idx = _editState.idx;
  if (idx < 0 || !FILES[idx]) { cancelEdit(); return; }
  const f = FILES[idx];
  const saveBtn = document.getElementById('editSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026'; }
  let newBlob = null;
  try {
    /* Round 17 HEIC fix: the photo-edit chain feeds workingBlob into
     * createImageBitmap() in every _applyX helper. For HEIC entries
     * f.file is the raw HEIC (un-decodable by Chrome/Firefox/Edge),
     * so start from the decoded JPEG blob the round-11 fix stashes
     * in _editState.originalFile. Non-HEIC: originalFile === f.file. */
    let workingBlob = _editState.originalFile || f.file;
    if (_editState.pendingEdits.gifEdit) {
      workingBlob = await _applyGifEdit(f.file, _editState.pendingEdits.gifEdit);
    } else if (_editState.pendingEdits.bgRemoved) {
      workingBlob = _editState.pendingEdits.bgRemoved;
      if (_editState.pendingEdits.bgRefine && _editState.pendingEdits.bgRefine.strokes && _editState.pendingEdits.bgRefine.strokes.length) {
        workingBlob = await _applyBgRefine(workingBlob, _editState.originalFile, _editState.pendingEdits.bgRefine);
      }
    } else {
      if (_editState.pendingEdits.autoEnhanced) {
        workingBlob = _editState.pendingEdits.autoEnhanced;
      }
      if (_editState.pendingEdits.rotate && _editState.rotateState && _editState.rotateState.enabled !== false) {
        workingBlob = await _applyRotation(workingBlob, _editState.pendingEdits.rotate);
      }
      /* R47 — skip if both sub-sections disabled. _applyPhotoAdjust itself
         is now per-section aware. */
      if (_editState.pendingEdits.photoAdjust && _editState.pendingEdits.photoAdjust._dirty) {
        const _pa = _editState.pendingEdits.photoAdjust;
        if (_pa.sliderEnabled !== false || _pa.filterEnabled !== false) {
          workingBlob = await _applyPhotoAdjust(workingBlob, _pa);
        }
      }
      if (_editState.pendingEdits.photoCrop) {
        workingBlob = await _applyPhotoCrop(workingBlob, _editState.pendingEdits.photoCrop);
      }
      if (_editState.pendingEdits.vignette && _editState.pendingEdits.vignette._dirty && _editState.pendingEdits.vignette.enabled !== false) {
        workingBlob = await _applyVignette(workingBlob, _editState.pendingEdits.vignette);
      }
      if (_editState.pendingEdits.pixelate && _editState.pendingEdits.pixelate.strokes && _editState.pendingEdits.pixelate.strokes.length && _editState.pendingEdits.pixelate.enabled !== false) {
        workingBlob = await _applyPixelate(workingBlob, _editState.pendingEdits.pixelate);
      }
      if (_editState.pendingEdits.blur && (
            (_editState.pendingEdits.blur.strokes && _editState.pendingEdits.blur.strokes.length) ||
            _editState.pendingEdits.blur.full) && _editState.pendingEdits.blur.enabled !== false) {
        workingBlob = await _applyBlur(workingBlob, _editState.pendingEdits.blur);
      }
      if (_editState.pendingEdits.textOverlays && _editState.pendingEdits.textOverlays.items && _editState.pendingEdits.textOverlays.items.length) {
        workingBlob = await _applyTextOverlays(workingBlob, _editState.pendingEdits.textOverlays);
      }
    }
    newBlob = (workingBlob !== f.file) ? workingBlob : null;
  } catch (err) {
    console.warn('[edit] save failed', err);
    alert('Edit failed: ' + (err.message || err));
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    return;
  }
  if (newBlob) {
    try { URL.revokeObjectURL(f.url); } catch(_){}
    let newName = f.file.name || 'image';
    if (_editState.pendingEdits.bgRemoved && newBlob === _editState.pendingEdits.bgRemoved) {
      newName = newName.replace(/\.[^.]+$/, '') + '.png';
    } else if (/\.(heic|heif)$/i.test(newName)){
      /* Round 17 HEIC fix: every Edit path encodes via canvas.toBlob,
       * which can only emit image/png or image/jpeg. Keep the file name
       * honest so downloads match the bytes inside. */
      const ext = (newBlob.type === 'image/png') ? '.png' : '.jpg';
      newName = newName.replace(/\.[^.]+$/, '') + ext;
    }
    f.file = new File([newBlob], newName, { type: newBlob.type || f.file.type });
    f.url = URL.createObjectURL(newBlob);
    f.dims = null;
    if (typeof ENCODE !== 'undefined' && ENCODE.encoded && ENCODE.encoded.has(idx)) {
      const e = ENCODE.encoded.get(idx);
      try { URL.revokeObjectURL(e.url); } catch(_){}
      ENCODE.encoded.delete(idx);
    }
    if (typeof ENCODE !== 'undefined' && ENCODE.allEncoded && ENCODE.allEncoded.has(idx)) {
      const bundle = ENCODE.allEncoded.get(idx);
      if (bundle) bundle.forEach(b => { try { URL.revokeObjectURL(b.url); } catch(_){} });
      ENCODE.allEncoded.delete(idx);
    }
    if (typeof buildThumbs === 'function') buildThumbs();
    if (typeof layoutCoverFlow === 'function') layoutCoverFlow();
    if (typeof invalidateEncoded === 'function') invalidateEncoded();
    if (typeof syncMainImage === 'function') syncMainImage(true);
  }
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  cancelEdit();
}
/* ---- EDIT UNDO/REDO HELPERS (Round 4) ---- */
function _editSnapshot(){
  const pe = _editState.pendingEdits;
  return {
    rotate: pe.rotate ? { ...pe.rotate } : null,
    photoAdjust: pe.photoAdjust ? { ...pe.photoAdjust } : null,
    photoCrop: pe.photoCrop ? { ...pe.photoCrop } : null,
    bgRemoved: pe.bgRemoved || null,
    bgRefine: pe.bgRefine ? JSON.parse(JSON.stringify(pe.bgRefine)) : null,
    autoEnhanced: pe.autoEnhanced || null,
    autoEnhancedUrl: pe.autoEnhancedUrl || null,
    pixelate: pe.pixelate ? JSON.parse(JSON.stringify(pe.pixelate)) : null,
    blur: pe.blur ? JSON.parse(JSON.stringify(pe.blur)) : null,
    vignette: pe.vignette ? { ...pe.vignette } : null,
    textOverlays: pe.textOverlays ? JSON.parse(JSON.stringify(pe.textOverlays)) : null,
    gifEdit: pe.gifEdit ? JSON.parse(JSON.stringify(pe.gifEdit)) : null,
    rotateState: { ..._editState.rotateState },
  };
}
function _editRestore(snap){
  _editState.pendingEdits = {};
  if (snap.rotate) _editState.pendingEdits.rotate = snap.rotate;
  if (snap.photoAdjust) _editState.pendingEdits.photoAdjust = snap.photoAdjust;
  if (snap.photoCrop) _editState.pendingEdits.photoCrop = snap.photoCrop;
  if (snap.bgRemoved) _editState.pendingEdits.bgRemoved = snap.bgRemoved;
  if (snap.bgRefine) _editState.pendingEdits.bgRefine = snap.bgRefine;
  if (snap.autoEnhanced) {
    _editState.pendingEdits.autoEnhanced = snap.autoEnhanced;
    _editState.pendingEdits.autoEnhancedUrl = snap.autoEnhancedUrl;
  }
  if (snap.pixelate) _editState.pendingEdits.pixelate = snap.pixelate;
  if (snap.blur) _editState.pendingEdits.blur = snap.blur;
  if (snap.vignette) _editState.pendingEdits.vignette = snap.vignette;
  if (snap.textOverlays) _editState.pendingEdits.textOverlays = snap.textOverlays;
  if (snap.gifEdit) _editState.pendingEdits.gifEdit = snap.gifEdit;
  _editState.rotateState = { ...snap.rotateState };
}
function _editPushUndo(){
  try { _updateSplitBtnState(); } catch(_){}
  _editState._undoStack.push(_editSnapshot());
  if (_editState._undoStack.length > 20) _editState._undoStack.shift();
  _editState._redoStack = [];
  _updateEditHistoryUI();
}
function _editUndo(){
  if (!_editState._undoStack.length) return;
  _editState._redoStack.push(_editSnapshot());
  _editRestore(_editState._undoStack.pop());
  _updateEditHistoryUI();
  _reRenderEditTab();
}
function _editRedo(){
  if (!_editState._redoStack.length) return;
  _editState._undoStack.push(_editSnapshot());
  _editRestore(_editState._redoStack.pop());
  _updateEditHistoryUI();
  _reRenderEditTab();
}
function _editResetAll(){
  if (_editState._blurBitmap){ try { _editState._blurBitmap.close && _editState._blurBitmap.close(); } catch(_){} _editState._blurBitmap = null; }
  _editState._blurBaseBlob = null; _editState._blurBaseSig = null;
  if (!_editState.active) return;
  _editPushUndo();
  _editState.pendingEdits = {};
  _editState.rotateState = { deg: 0, flipH: false, flipV: false, angle: 0 };
  if (_editState.bgState && _editState.bgState.previewUrl){
    try { URL.revokeObjectURL(_editState.bgState.previewUrl); } catch(_){}
  }
  if (_editState.bgState){
    if (_editState.bgState._refineBgBmp){ try { _editState.bgState._refineBgBmp.close && _editState.bgState._refineBgBmp.close(); } catch(_){} _editState.bgState._refineBgBmp = null; }
    if (_editState.bgState._refineOrigBmp){ try { _editState.bgState._refineOrigBmp.close && _editState.bgState._refineOrigBmp.close(); } catch(_){} _editState.bgState._refineOrigBmp = null; }
  }
  _editState.bgState = null;
  if (_editState._pxBitmap){
    try { _editState._pxBitmap.close && _editState._pxBitmap.close(); } catch(_){}
    _editState._pxBitmap = null;
  }
  if (_editState._pxBaseUrl){ try { URL.revokeObjectURL(_editState._pxBaseUrl); } catch(_){} _editState._pxBaseUrl = null; _editState._pxBaseBlob = null; }
  if (_editState._txBitmap){
    try { _editState._txBitmap.close && _editState._txBitmap.close(); } catch(_){}
    _editState._txBitmap = null;
  }
  if (_editState._txBaseUrl){ try { URL.revokeObjectURL(_editState._txBaseUrl); } catch(_){} _editState._txBaseUrl = null; _editState._txBaseBlob = null; _editState._txBaseSig = null; }
  _updateEditHistoryUI();
  _reRenderEditTab();
}
function _reRenderEditTab(){
  const active = document.querySelector('.edit-modal .edit-tab.active');
  if (active) _switchEditTab(active.dataset.tab);
}
function _hasEdits(){
  /* R61 — real dirty check. The previous impl counted any pendingEdits
     key as "edited", but renderers populate default state objects
     (e.g. pendingEdits.photoAdjust gets initialized at neutral values
     just to drive the UI). A fresh-opened editor would lie and report
     "Save" required. Now we look at the actual dirty flags / non-default
     values. */
  const pe = _editState.pendingEdits || {};
  const rs = _editState.rotateState  || {};
  if (rs.deg !== 0 || rs.flipH || rs.flipV || rs.angle !== 0) return true;
  if (pe.photoAdjust) {
    const a = pe.photoAdjust;
    if (a._dirty) return true;
    if (a.brightness !== 100 || a.contrast !== 100 || a.saturation !== 100) return true;
    if (a.preset && a.preset !== 'none') return true;
    if (a.globalBlur && a.globalBlur > 0) return true;
  }
  if (pe.vignette && pe.vignette._dirty) return true;
  if (pe.photoCrop) return true;
  if (pe.bgRemoved) return true;
  if (pe.pixelate && pe.pixelate.strokes && pe.pixelate.strokes.length) return true;
  if (pe.blur && ((pe.blur.strokes && pe.blur.strokes.length) || pe.blur.full)) return true;
  if (pe.textOverlays && pe.textOverlays.items && pe.textOverlays.items.length) return true;
  if (pe.autoEnhanced) return true;
  return false;
}
function _updateEditHistoryUI(){
  const resetBtn = document.getElementById('editResetBtn');
  const hasEdits = _hasEdits();
  if (resetBtn) resetBtn.disabled = !hasEdits && !_editState._undoStack.length;
  const undoBtn = document.getElementById('editUndoBtn');
  if (undoBtn) undoBtn.disabled = !_editState._undoStack.length;
  const redoBtn = document.getElementById('editRedoBtn');
  if (redoBtn) redoBtn.disabled = !_editState._redoStack.length;
  /* R60 — dynamic Save/Done label. */
  const saveTop = document.getElementById('editSaveBtnTop');
  if (saveTop) {
    if (hasEdits) {
      saveTop.textContent = 'Save';
      saveTop.title = 'Save edits';
      saveTop.classList.add('has-edits');
    } else {
      saveTop.textContent = 'Done';
      saveTop.title = 'Close editor';
      saveTop.classList.remove('has-edits');
    }
  }
  _updateEditSizeInfo();
}
function _updateEditSizeInfo(){
  const el = document.getElementById('editSizeInfo');
  if (!el || !_editState.active || typeof FILES === 'undefined') return;
  const f = FILES[_editState.idx];
  if (!f) return;
  let txt = fmtSize(f.file.size) + ' original';
  if (typeof ENCODE !== 'undefined' && ENCODE.encoded && ENCODE.encoded.has(_editState.idx)){
    const e = ENCODE.encoded.get(_editState.idx);
    if (e && e.size) txt += ' → ~' + fmtSize(e.size) + ' ' + (e.format || '').toUpperCase();
  }
  el.textContent = txt;
}
/* ---- Round 10 — Before/After split-slider ---- */

/* R47 — Adjust tab tap-to-disable. Injects a small dot inside each
   modified chip; click toggles the section's enabled flag (preserves
   values), click elsewhere on the chip opens its dropdown as before. */
function _r47WireSectionToggles(){
  const pe = _editState.pendingEdits;
  if (!pe || !pe.photoAdjust || !pe.vignette) return;
  const adj = pe.photoAdjust;
  const vig = pe.vignette;
  const slidDirty   = !(adj.brightness === 100 && adj.contrast === 100 && adj.saturation === 100);
  const filterDirty = (adj.preset !== 'none');
  const vigDirty    = !!vig._dirty;
  function wire(triggerId, isDirty, isEnabled, onToggle){
    const trig = document.getElementById(triggerId);
    if (!trig) return;
    /* Clean any existing dot before re-inserting */
    const old = trig.querySelector('.edit-section-toggle');
    if (old) old.remove();
    if (!isDirty) return;
    const dot = document.createElement('span');
    dot.className = 'edit-section-toggle' + (isEnabled ? ' on' : ' off');
    dot.title = isEnabled ? 'Disable this adjustment (values kept)' : 'Re-enable this adjustment';
    dot.setAttribute('role', 'switch');
    dot.setAttribute('aria-checked', isEnabled ? 'true' : 'false');
    dot.setAttribute('aria-label', dot.title);
    dot.addEventListener('click', function(e){
      e.stopPropagation();
      e.preventDefault();
      onToggle();
    });
    /* Insert as the FIRST child of the trigger so the dot sits left of
       the label, matching the iPhone Photos icon-on-the-left convention. */
    trig.insertBefore(dot, trig.firstChild);
    trig.classList.toggle('section-disabled', !isEnabled);
  }
  wire('editAdjustTrigger', slidDirty, adj.sliderEnabled !== false, function(){
    adj.sliderEnabled = adj.sliderEnabled === false ? true : false;
    /* Re-render the Adjust tab so chip state + preview update together. */
    _reRenderEditTab();
  });
  wire('editFilterTrigger', filterDirty, adj.filterEnabled !== false, function(){
    adj.filterEnabled = adj.filterEnabled === false ? true : false;
    _reRenderEditTab();
  });
  wire('editVignetteTrigger', vigDirty, vig.enabled !== false, function(){
    vig.enabled = vig.enabled === false ? true : false;
    _reRenderEditTab();
  });
}

function _editHasAnyEdit(){
  if (!_editState) return false;
  const r = _editState.rotateState || {};
  if (r.deg || r.angle || r.flipH || r.flipV) return true;
  const pe = _editState.pendingEdits || {};
  if (pe.bgRemoved || pe.bgRefine) return true;
  /* photoAdjust seeds itself with neutral values (100/100/100 + preset:'none'); the canonical
   * dirty signal is the ._dirty flag the adjust tab maintains via the same predicate. */
  if (pe.photoAdjust && pe.photoAdjust._dirty) return true;
  if (pe.photoCrop) return true;
  if (pe.rotate) return true;
  if (pe.autoEnhanced) return true;
  if (pe.pixelate && Array.isArray(pe.pixelate.strokes) && pe.pixelate.strokes.length) return true;
  if (pe.blur && ((Array.isArray(pe.blur.strokes) && pe.blur.strokes.length) || pe.blur.full)) return true;
  if (pe.vignette && pe.vignette._dirty) return true;
  if (pe.textOverlays && Array.isArray(pe.textOverlays) && pe.textOverlays.length) return true;
  /* GIF: frame-level mutation surfaces as pendingEdits.gifEdit. */
  if (pe.gifEdit) return true;
  if (_editState.framesState && _editState.framesState.dirty) return true;
  return false;
}
function _ensureSplitUi(){
  const col = document.getElementById('editPreviewCol');
  if (!col) return;
  /* R60 — floating action pill removed; history controls live in the
     top chrome now. Compare chip + zoom chip still get anchored to
     editPreviewCol. */
  if (!col.querySelector('.edit-compare-chip')){
    const cc = document.createElement('button');
    cc.type = 'button';
    cc.className = 'edit-compare-chip'; cc.id = 'editCompareChip';
    cc.innerHTML = '<svg class="ico" aria-hidden="true" style="width:13px;height:13px"><use href="#i-arrow-left-right"/></svg>Compare';
    cc.title = 'Compare original vs edited — drag the divider';
    cc.addEventListener('click', _toggleSplitCompare);
    col.appendChild(cc);
  }
  if (!col.querySelector('.edit-zoom-chip')){
    const zc = document.createElement('div');
    zc.className = 'edit-zoom-chip'; zc.id = 'editZoomChip';
    col.appendChild(zc);
  }
  if (!col.querySelector('.edit-split-overlay')){
    const ov = document.createElement('div');
    ov.className = 'edit-split-overlay';
    ov.id = 'editSplitOverlay';
    ov.style.setProperty('--split-x', '50%');
    ov.style.setProperty('--split-right', '50%');
    ov.innerHTML = ''
      + '<span class="edit-split-label before">Original</span>'
      + '<span class="edit-split-label after">Edited</span>'
      + '<img id="editSplitImg" alt="Original">'
      + '<div class="edit-split-handle" id="editSplitHandle" role="slider" aria-label="Compare original vs edited"></div>';
    col.appendChild(ov);
    _initSplitDrag(ov.querySelector('.edit-split-handle'));
  }
  /* Restore active state when re-rendering the same tab while split was on. */
  const ov = col.querySelector('.edit-split-overlay');
  const btn = col.querySelector('.edit-split-btn');
  if (_editState._splitActive){
    ov.classList.add('active');
    if (btn) btn.classList.add('active');
    const img = ov.querySelector('#editSplitImg');
    if (img && _editState.originalUrl) img.src = _editState.originalUrl;
  } else {
    ov.classList.remove('active');
    if (btn) btn.classList.remove('active');
  }
  /* One-shot delegated listeners on #editBody so the Compare button enables/disables
   * after the user mutates state via clicks, slider input/change, or programmatic changes. */
  const eb = document.getElementById('editBody');
  if (eb && eb.dataset.splitBound !== '1'){
    eb.dataset.splitBound = '1';
    const refresh = () => { try { queueMicrotask(_updateSplitBtnState); } catch(_) { _updateSplitBtnState(); } };
    eb.addEventListener('click', refresh, true);
    eb.addEventListener('input', refresh, true);
    eb.addEventListener('change', refresh, true);
  }
  _updateSplitBtnState();
  try { _updateSplitBtnPos(); } catch(_) {}
}
/* R33 — reposition the floating split-compare button so it always clears
   the card. The card (edit-menu-wrap) is position:absolute bottom:16px,
   so the button should sit card_height + 16 + 12px gap above the screen
   bottom. Called on every tab switch and on window resize. */
function _updateMenuCardH(){
  /* R67 — expose .edit-menu-card height as --menu-card-h on the modal
     so the floating tool surface can anchor directly above it. */
  const card = document.querySelector('.edit-modal .edit-menu-card');
  const modal = document.querySelector('.edit-modal');
  if (!card || !modal) return;
  const h = Math.round(card.getBoundingClientRect().height);
  if (h > 0) modal.style.setProperty('--menu-card-h', h + 'px');
}
function _updateSplitBtnPos(){
  _updateMenuCardH();
  /* R45 — anchor the pill above the WHOLE menu-card, not just the
     tab-bar. R43 anchored to tabBar.top which works only when the
     options strip above the tabs is short. On tabs with tall content
     (Adjust: Auto-enhance + ADJUST + FILTER + VIGNETTE dropdowns), the
     options strip pushes the card top way up while the tab-bar stays
     at the card bottom — so anchoring 32px above the tab-bar landed
     the pill INSIDE the options strip, overlapping content. Now we
     anchor 12px above the menu-card's top edge regardless of how
     tall the strip grows. */
  const menuCard = document.querySelector('.edit-modal .edit-menu-card');
  const modal    = document.querySelector('.edit-modal');
  if (!menuCard || !modal) return;
  const cardTop  = menuCard.getBoundingClientRect().top;
  const modalBot = modal.getBoundingClientRect().bottom;
  modal.style.setProperty('--split-btn-bottom', (modalBot - cardTop + 12) + 'px');
}
function _updateSplitBtnState(){
  /* R37 — compare chip replaces the split-btn in the pill. */
  const chip = document.getElementById('editCompareChip');
  const onCrop = !!document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')
              || !!document.querySelector('.edit-modal .edit-subtab.active[data-subtab="crop"]');
  if (onCrop){
    if (chip) chip.classList.remove('visible');
    if (_editState._splitActive){ _editState._splitActive = false; _ensureSplitUi(); }
    return;
  }
  const has = _editHasAnyEdit();
  if (chip){ chip.classList.toggle('visible', has); chip.classList.toggle('active', !!_editState._splitActive); }
}
function _toggleSplitCompare(){
  if (!_editState || _editState.idx < 0) return;
  /* If the full View-original overlay is currently shown, dismiss it first. */
  const fullOv = document.getElementById('editCompareOverlay');
  if (fullOv && fullOv.style.display === 'flex') _toggleEditCompare();
  _editState._splitActive = !_editState._splitActive;
  _ensureSplitUi();
}
function _initSplitDrag(handle){
  if (!handle || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';
  let dragging = false;
  const move = (clientX) => {
    const col = document.getElementById('editPreviewCol');
    if (!col) return;
    const r = col.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
    const ov = document.getElementById('editSplitOverlay');
    if (!ov) return;
    ov.style.setProperty('--split-x', pct.toFixed(2) + '%');
    ov.style.setProperty('--split-right', (100 - pct).toFixed(2) + '%');
  };
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch(_){}
    move(e.clientX);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    move(e.clientX);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch(_){}
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  /* Keyboard: ArrowLeft/Right nudges the divider 2% */
  handle.tabIndex = 0;
  handle.addEventListener('keydown', (e) => {
    const ov = document.getElementById('editSplitOverlay');
    if (!ov) return;
    const cur = parseFloat(ov.style.getPropertyValue('--split-x')) || 50;
    let next = cur;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 2);
    else if (e.key === 'ArrowRight') next = Math.min(100, cur + 2);
    else return;
    ov.style.setProperty('--split-x', next.toFixed(2) + '%');
    ov.style.setProperty('--split-right', (100 - next).toFixed(2) + '%');
    e.preventDefault();
  });
}

/* ---- EDIT COMPARE (View Original) ---- */
function _toggleEditCompare(){
  const overlay = document.getElementById('editCompareOverlay');
  if (!overlay) return;
  const showing = overlay.style.display === 'flex';
  if (!showing){
    /* Round 10: mutex with split-compare. */
    if (_editState && _editState._splitActive){ _editState._splitActive = false; try { _ensureSplitUi(); } catch(_){} }
    const img = overlay.querySelector('#editCompareImg');
    if (img && _editState.originalUrl) img.src = _editState.originalUrl;
    overlay.style.display = 'flex';
    const btn = document.getElementById('editCompareBtn');
    if (btn){ btn.textContent = 'Hide original'; btn.classList.add('active'); }
  } else {
    overlay.style.display = 'none';
    const btn = document.getElementById('editCompareBtn');
    if (btn){ btn.textContent = 'View original'; btn.classList.remove('active'); }
  }
}
document.addEventListener('keydown', e => {
  if (document.body.dataset.editOpen !== 'true') return;
  if (e.key === 'Escape'){
    const overlay = document.getElementById('editCompareOverlay');
    if (overlay && overlay.style.display === 'flex'){
      _toggleEditCompare(); e.preventDefault(); return;
    }
    if (_editState && _editState._splitActive){
      _editState._splitActive = false; try { _ensureSplitUi(); } catch(_){}
      e.preventDefault(); return;
    }
    cancelEdit(); e.preventDefault(); return;
  }
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !isInput){
    _editUndo(); e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey)) && !isInput){
    _editRedo(); e.preventDefault();
  }
  /* R21 — Photoshop-style bracket keys for brush size + Shift-bracket for
     Blur radius. Variable increment per Adobe's Photoshop convention
     (https://helpx.adobe.com/photoshop/using/default-keyboard-shortcuts.html):
     1px below 10, 5px below 50, 10px below 100, 20px above. Native key-repeat
     works because we tap the existing slider input via dispatchEvent, which
     means each repeated keydown fires one update — cursor + UI refresh for
     free via the slider's own change listener. */
  else if ((e.key === '[' || e.key === ']') && !isInput){
    const dir = (e.key === ']') ? 1 : -1;
    /* Shift+bracket routes to Blur radius if Blur sub-tab is active. */
    if (e.shiftKey){
      const radEl = document.getElementById('blRadius');
      if (radEl){
        const cur = parseInt(radEl.value, 10);
        const step = (cur < 5) ? 1 : (cur < 15) ? 2 : 5;
        const next = Math.max(parseInt(radEl.min,10), Math.min(parseInt(radEl.max,10), cur + dir * step));
        if (next !== cur){
          radEl.value = String(next);
          radEl.dispatchEvent(new Event('input', { bubbles: true }));
          radEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        e.preventDefault();
      }
      return;
    }
    /* Plain bracket: find the active brush slider, mutate, dispatch. */
    const brushIds = ['bgrBrush', 'pxBrush', 'blBrush'];
    let slider = null;
    for (let i = 0; i < brushIds.length; i++){
      const el = document.getElementById(brushIds[i]);
      if (el){ slider = el; break; }
    }
    if (slider){
      const cur = parseInt(slider.value, 10);
      const step = (cur < 10) ? 1 : (cur < 50) ? 5 : (cur < 100) ? 10 : 20;
      const next = Math.max(parseInt(slider.min,10), Math.min(parseInt(slider.max,10), cur + dir * step));
      if (next !== cur){
        slider.value = String(next);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
      e.preventDefault();
    }
  }
  /* R22 — number keys 1-N jump to Edit modal tabs. Adobe convention.
     R107 — derive tab IDs from the live DOM rather than a hard-coded
     list. R88 reduced the editor to 4 tabs (adjust, filters, rotate,
     crop); the old hard-coded list still referenced removed tabs
     (transform, retouch, add, bg), so keys 2-5 silently no-op'd.
     Querying the DOM keeps the shortcut wired to whatever tabs are
     actually visible. */
  else if (/^[1-9]$/.test(e.key) && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey){
    const tabs = document.querySelectorAll('.edit-modal .edit-tab[data-tab]');
    const idx = parseInt(e.key, 10) - 1;
    const target = tabs[idx];
    if (target){ target.click(); e.preventDefault(); }
  }
  /* R22 — Caps Lock toggle for precise crosshair (Photoshop standard). */
  if (e.getModifierState && e.getModifierState('CapsLock')){
    document.body.dataset.editPrecise = 'on';
  } else {
    document.body.dataset.editPrecise = '';
  }
});
/* R22 — track Caps Lock state on keyup too (the key itself doesn't always
   fire a keydown for CapsLock toggles in all browsers; checking
   getModifierState on every keyup catches the state change reliably). */
document.addEventListener('keyup', e => {
  if (document.body.dataset.editOpen !== 'true') return;
  if (e.getModifierState && e.getModifierState('CapsLock')){
    document.body.dataset.editPrecise = 'on';
  } else {
    document.body.dataset.editPrecise = '';
  }
});
/* R22 — track active brush drag globally so the cursor swaps to a thin
   crosshair during a stroke (CSS rule above does the actual swap). */
document.addEventListener('pointerdown', e => {
  if (document.body.dataset.editOpen !== 'true') return;
  const t = e.target;
  if (t && t.classList && (t.classList.contains('edit-pixelate-canvas')
                       || t.classList.contains('edit-blur-canvas')
                       || t.classList.contains('bg-refine-canvas'))){
    document.body.dataset.editDragging = 'on';
  }
}, true);
document.addEventListener('pointerup',   () => { document.body.dataset.editDragging = ''; }, true);
document.addEventListener('pointercancel', () => { document.body.dataset.editDragging = ''; }, true);
/* ---- ROTATE TAB ---- */
function _renderRotateTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  const previewCol = _editPreviewEl();
  if (previewCol) {
    previewCol.innerHTML = `<div class="edit-rotate-preview" id="editRotatePreview" style="background-image:url('${_editState.originalUrl || f.url}');"></div>`;
  }
  /* R53 — Angle is now a circular icon + tick-ruler scrubber below
     (Apple-Photos style). Disable toggle replaces Reset; values persist. */
  const _rotAng = _editState.rotateState.angle;
  const _angleMod = _rotAng !== 0;
  const _rotEnabled = (_editState.rotateState.enabled !== false);
  const _anglePct = ((_rotAng - (-180)) / 360) * 100;
  body.innerHTML = `
    <div class="edit-tool-toolbar edit-rotate-toolbar adj-tab-r50">
      <div class="ed-func-row${_rotEnabled ? '' : ' row-disabled'}" id="editRotateRow">
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="cw" title="Rotate 90° clockwise" aria-label="Rotate 90° clockwise">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-rotate-cw"/></svg></span>
        </button>
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="ccw" title="Rotate 90° counter-clockwise" aria-label="Rotate 90° counter-clockwise">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-rotate-ccw"/></svg></span>
        </button>
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="fh" title="Flip horizontal" aria-label="Flip horizontal">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-flip-horizontal"/></svg></span>
        </button>
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="fv" title="Flip vertical" aria-label="Flip vertical">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-flip-vertical"/></svg></span>
        </button>
      </div>
      <div class="adj-tick-ruler" id="editAngleRuler" style="--range:360;">
        <div class="adj-tick-ticks" aria-hidden="true"></div>
        <div class="adj-tick-center" aria-hidden="true"></div>
        <div class="adj-tick-dot" id="editAngleTickDot" style="left:${_anglePct.toFixed(2)}%;" aria-hidden="true"></div>
        <input type="range" id="editAngleSlider" class="adj-tick-input" min="-180" max="180" step="1" value="${_editState.rotateState.angle}" aria-label="Angle">
      </div>
    </div>
  `;
  /* R53 — show floating ANGLE pill over photo. */
  try {
    const _val = _angleMod ? (_rotAng > 0 ? '+' + _rotAng + '°' : _rotAng + '°') : '';
    _ensureAdjSectionPill('Angle', _val);
  } catch(_){}
  /* R65 — populate ticks for the Angle ruler. */
  try { _buildRulerTicks(document.getElementById('editAngleRuler')); } catch(_){}
  const preview = document.getElementById('editRotatePreview');
  function _updateRot(){
    const rs = _editState.rotateState;
    const enabled = (rs.enabled !== false);
    /* R66 — feed the RAW combined angle to CSS rotate so dragging the
       slider across 0 doesn't snap modulo and trigger a 360° spin. The
       encoded payload (used by the bake step) still normalizes to 0–360. */
    const totalRaw = rs.deg + rs.angle;
    const totalNorm = ((totalRaw % 360) + 360) % 360;
    const tx = enabled
      ? `rotate(${totalRaw}deg) scaleX(${rs.flipH ? -1 : 1}) scaleY(${rs.flipV ? -1 : 1})`
      : 'none';
    preview.style.transform = tx;
    const dirty = enabled && (rs.deg !== 0 || rs.flipH || rs.flipV || rs.angle !== 0);
    _editState.pendingEdits.rotate = dirty ? { deg: totalNorm, flipH: rs.flipH, flipV: rs.flipV } : null;
  }
  /* R53 — discrete rotate icons (CW/CCW/Flip H/Flip V) + angle slider. */
  document.querySelectorAll('#editBody .edit-rotate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _editPushUndo();
      const rs = _editState.rotateState;
      switch (btn.dataset.rot) {
        case 'cw':    rs.deg = (rs.deg + 90) % 360; break;
        case 'ccw':   rs.deg = (rs.deg + 270) % 360; break;
        case 'fh':    rs.flipH = !rs.flipH; break;
        case 'fv':    rs.flipV = !rs.flipV; break;
        case 'angle':
          /* R63 — tap-on-icon when angle !== 0 resets to 0. When already
             at 0, give the user a small visual nudge instead of silent
             no-op: briefly pulse the selected ring via a one-off class. */
          if (rs.angle !== 0) {
            rs.angle = 0;
            const sl = document.getElementById('editAngleSlider');
            const dot = document.getElementById('editAngleTickDot');
            if (sl) sl.value = 0;
            if (dot) dot.style.left = '50%';
          } else {
            btn.classList.remove('pulse');
            void btn.offsetWidth;  /* restart animation */
            btn.classList.add('pulse');
            setTimeout(() => btn.classList.remove('pulse'), 360);
          }
          break;
      }
      _updateRot();
      _r53SyncAngleUI();
    });
  });
  const slider = document.getElementById('editAngleSlider');
  const tickDot = document.getElementById('editAngleTickDot');
  function _r53UpdatePill(v){
    const lbl = document.getElementById('adjSectionPillLabel');
    const val = document.getElementById('adjSectionPillVal');
    if (lbl) lbl.textContent = 'ANGLE';
    if (val) val.textContent = (v === 0) ? '' : (v > 0 ? '+' + v + '°' : v + '°');
  }
  function _r53SyncAngleUI(){
    const v = _editState.rotateState.angle;
    if (slider) slider.value = String(v);
    if (tickDot) tickDot.style.left = (((v + 180) / 360) * 100).toFixed(2) + '%';
    /* Update the angle icon's modified/value display. */
    const angBtn = document.querySelector('#editBody .edit-rotate-btn[data-rot="angle"]');
    if (angBtn) {
      angBtn.classList.toggle('modified', v !== 0);
      const valEl = angBtn.querySelector('.adj-circle-val');
      if (valEl) valEl.textContent = (v === 0) ? '' : (v > 0 ? '+' + v : String(v));
      const dot = angBtn.querySelector('.adj-icon-dot');
      if (dot) {
        const mag = Math.min(180, Math.abs(v));
        const deg = (mag / 180) * 180;
        if (v >= 0) dot.style.setProperty('--r48-arc-from', '-90deg');
        else dot.style.setProperty('--r48-arc-from', (-90 - deg) + 'deg');
        dot.style.setProperty('--r48-arc-deg', deg + 'deg');
      }
    }
    _r53UpdatePill(v);
  }
  if (slider) {
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10);
      _editState.rotateState.angle = v;
      _updateRot();
      _r53SyncAngleUI();
    });
    slider.addEventListener('change', () => { _editPushUndo(); });
  }
  /* Disable toggle for Rotate. */
  const _rotDisable = document.getElementById('editRotateDisable');
  if (_rotDisable) {
    _rotDisable.addEventListener('click', () => {
      const rs = _editState.rotateState;
      rs.enabled = (rs.enabled === false);  /* flip — default true means click sets false */
      _rotDisable.classList.toggle('tab-disabled', rs.enabled === false);
      _rotDisable.setAttribute('aria-pressed', rs.enabled === false ? 'true' : 'false');
      _rotDisable.title = rs.enabled === false ? 'Enable rotate' : 'Disable rotate';
      const row = document.getElementById('editRotateRow');
      if (row) row.classList.toggle('row-disabled', rs.enabled === false);
      _updateRot();
    });
  }
  _r53SyncAngleUI();
}
async function _applyRotation(file, rotation){
  const bmp = await createImageBitmap(file);
  const w = bmp.width, h = bmp.height;
  const deg = rotation.deg || 0;
  const rad = deg * Math.PI / 180;
  const sinA = Math.abs(Math.sin(rad));
  const cosA = Math.abs(Math.cos(rad));
  const newW = Math.round(w * cosA + h * sinA);
  const newH = Math.round(w * sinA + h * cosA);
  const canvas = document.createElement('canvas');
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.scale(rotation.flipH ? -1 : 1, rotation.flipV ? -1 : 1);
  ctx.drawImage(bmp, -w / 2, -h / 2);
  ctx.restore();
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('rotation encode failed')), mime, 0.95);
  });
}
/* ---- FRAMES TAB (GIF frame editor) ---- */
async function _renderFramesTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  body.innerHTML = '<p style="color:rgba(255,255,255,.6);">Decoding frames\u2026</p>';
  if (typeof ImageDecoder !== 'function') {
    body.innerHTML = '<p style="color:rgba(255,200,120,.85);">Your browser doesn\u2019t support the ImageDecoder API. Frame editing requires a recent Chrome/Edge/Firefox.</p>';
    return;
  }
  /* Show original GIF as preview in left col */
  const framesPreviewCol = _editPreviewEl();
  if (framesPreviewCol) {
    framesPreviewCol.innerHTML = `<img class="edit-frames-preview-img" src="${f.url}" alt="GIF" draggable="false">`;
  }
  if (!_editState.framesState) {
    try {
      _editState.framesState = await _decodeGifFramesForEdit(f.file);
    } catch (err) {
      body.innerHTML = `<p style="color:rgba(255,120,120,.85);">Couldn\u2019t decode frames: ${err.message || err}</p>`;
      return;
    }
  }
  const fs = _editState.framesState;
  /* Initialize optimize state if missing (first time opening this tab
     for this file). Defaults match gifenc's defaults so toggling on
     the optimize panel without changing anything is a no-op. */
  if (!fs.opt) fs.opt = { paletteSize: 256, colorFormat: 'rgb565', dedupe: false };
  body.innerHTML = `
    <div class="edit-frames-actions">
      <button type="button" class="edit-frames-action-btn" data-act="reverse"><svg class="ico" aria-hidden="true"><use href="#i-rotate-cw"/></svg>Reverse all frames</button>
      <button type="button" class="edit-frames-action-btn" data-act="resetDelays">Reset delays to original</button>
    </div>
    <div class="edit-frames-strip" id="editFramesStrip"></div>
    <div class="edit-frames-controls">
      <label>Set all frames to
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="number" id="editFramesUniformMs" min="20" max="65535" value="${Math.round(1000/fs.fps)}" style="flex:1;">
          <span style="font-size:.7rem;color:rgba(255,255,255,.5);">ms</span>
          <button type="button" class="edit-frames-action-btn" id="editFramesUniformApply" style="padding:4px 10px;">Apply</button>
        </div>
      </label>
      <label>Loop count <span style="color:rgba(255,255,255,.45);font-weight:400;">(0 = forever)</span>
        <input type="number" id="editFramesLoop" min="0" max="999" value="${fs.loop}">
      </label>
      <label>Trim start (frame)
        <input type="range" id="editFramesTrimStart" min="0" max="${fs.frames.length - 1}" value="${fs.trimStart}">
        <span id="editFramesTrimStartVal" style="font-size:.78rem;color:rgba(255,255,255,.7);">${fs.trimStart}</span>
      </label>
      <label>Trim end (frame)
        <input type="range" id="editFramesTrimEnd" min="0" max="${fs.frames.length - 1}" value="${fs.trimEnd}">
        <span id="editFramesTrimEndVal" style="font-size:.78rem;color:rgba(255,255,255,.7);">${fs.trimEnd}</span>
      </label>
    </div>
    <p style="margin-top:14px;font-size:.78rem;color:rgba(255,255,255,.55);">Drag frames to reorder. Hover a frame for delete (\u00d7) and duplicate (\u2756) buttons. The remaining frames are encoded into a new GIF on Save.</p>
    <div class="edit-frames-optimize">
      <h4>Optimize \u2014 reduce file size on Save</h4>
      <div class="opt-row">
        <span>Palette size</span>
        <input type="range" id="editFramesPalette" min="16" max="256" step="8" value="${fs.opt.paletteSize}">
        <span class="opt-val" id="editFramesPaletteVal">${fs.opt.paletteSize}</span>
      </div>
      <div class="opt-row">
        <span>Color precision</span>
        <select id="editFramesColorFormat">
          <option value="rgb565" ${fs.opt.colorFormat==='rgb565'?'selected':''}>RGB 5-6-5 (best balance)</option>
          <option value="rgb444" ${fs.opt.colorFormat==='rgb444'?'selected':''}>RGB 4-4-4 (smaller)</option>
          <option value="rgba4444" ${fs.opt.colorFormat==='rgba4444'?'selected':''}>RGBA 4-4-4-4 (alpha)</option>
        </select>
        <span></span>
      </div>
      <div class="opt-row">
        <span>Dedupe duplicates</span>
        <label style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="editFramesDedupe" ${fs.opt.dedupe?'checked':''}>
          <span style="font-size:.72rem;color:rgba(255,255,255,.55);">Merge near-identical adjacent frames</span>
        </label>
        <span></span>
      </div>
    </div>
  `;
  const strip = body.querySelector('#editFramesStrip');
  function _renderStrip(){
    strip.innerHTML = '';
    fs.frames.forEach((frame, i) => {
      const div = document.createElement('div');
      div.className = 'edit-frame-thumb' + (frame.deleted ? ' deleted' : ' kept');
      div.dataset.fi = String(i);
      div.draggable = true;
      const wrap = document.createElement('div');
      wrap.className = 'frame-canvas-wrap';
      const c = document.createElement('canvas');
      c.width = 80; c.height = 80;
      const cx = c.getContext('2d');
      const rb = Math.min(80 / frame.bitmap.width, 80 / frame.bitmap.height);
      const dw = frame.bitmap.width * rb, dh = frame.bitmap.height * rb;
      cx.drawImage(frame.bitmap, (80 - dw) / 2, (80 - dh) / 2, dw, dh);
      wrap.appendChild(c);
      const num = document.createElement('span');
      num.className = 'frame-num';
      num.textContent = String(i + 1);
      wrap.appendChild(num);
      const del = document.createElement('button');
      del.className = 'frame-del';
      del.textContent = '\u00d7';
      del.title = 'Delete frame';
      del.addEventListener('click', e => {
        e.stopPropagation();
        _editPushUndo();
        frame.deleted = !frame.deleted;
        div.classList.toggle('deleted', frame.deleted);
        div.classList.toggle('kept', !frame.deleted);
        _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
      });
      wrap.appendChild(del);
      const dup = document.createElement('button');
      dup.className = 'frame-dup';
      dup.textContent = '\u2756';
      dup.title = 'Duplicate frame';
      dup.addEventListener('click', e => {
        e.stopPropagation();
        _editPushUndo();
        /* Clone the frame — shares the bitmap reference (no need to
           re-decode), copies delay + deleted flag. Insert immediately
           after the source, matching ezgif's per-frame Copy behavior. */
        const clone = { bitmap: frame.bitmap, delay: frame.delay, deleted: false, originalIdx: frame.originalIdx };
        fs.frames.splice(i + 1, 0, clone);
        _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
        _renderStrip();
      });
      wrap.appendChild(dup);
      div.appendChild(wrap);
      /* Per-frame delay input — ms (gifenc native unit). Show a hint
         in centiseconds for ezgif veterans via tooltip. */
      const delay = document.createElement('input');
      delay.type = 'number';
      delay.className = 'frame-delay-input';
      delay.min = '20'; delay.max = '65535'; delay.step = '10';
      delay.value = String(Math.max(20, Math.round(frame.delay)));
      delay.title = `Delay in milliseconds (\u2248 ${Math.round(frame.delay/10)}/100 s)`;
      delay.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        if (isFinite(v) && v >= 20) {
          frame.delay = v;
          _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
        }
      });
      div.appendChild(delay);
      /* Drag-reorder events — HTML5 DnD. Mobile fallback: long-press
         not shipped this round (deferred to round 2 of frames work
         since touch already lets users tap delete/dup/delay). */
      div.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        div.classList.add('dragging');
      });
      div.addEventListener('dragend', () => {
        strip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
        div.classList.remove('dragging');
      });
      div.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = div.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const before = e.clientX < mid;
        strip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
        div.classList.add(before ? 'drop-before' : 'drop-after');
      });
      div.addEventListener('drop', e => {
        e.preventDefault();
        _editPushUndo();
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const toRect = div.getBoundingClientRect();
        const before = e.clientX < (toRect.left + toRect.width / 2);
        let toIdx = parseInt(div.dataset.fi, 10);
        if (!before) toIdx++;
        /* Splice: remove from source, re-insert at target (account for
           index shift if source < target). */
        if (fromIdx === toIdx || fromIdx === toIdx - 1) {
          strip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
          return;
        }
        const [moved] = fs.frames.splice(fromIdx, 1);
        const realTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
        fs.frames.splice(realTo, 0, moved);
        _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
        _renderStrip();
      });
      strip.appendChild(div);
    });
  }
  _renderStrip();
  /* Action buttons: Reverse all / Reset delays. */
  body.querySelectorAll('.edit-frames-action-btn[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      _editPushUndo();
      const act = btn.dataset.act;
      if (act === 'reverse') {
        /* Reverse the frames array — preserves per-frame delay + deleted
           per ezgif's contract. */
        fs.frames = fs.frames.slice().reverse();
        _renderStrip();
      } else if (act === 'resetDelays') {
        fs.frames.forEach(fr => { fr.delay = fr.originalDelay || fr.delay; });
        _renderStrip();
      }
      _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
    });
  });
  /* Set-all-frames uniform delay applier. */
  const uniformBtn = body.querySelector('#editFramesUniformApply');
  const uniformInp = body.querySelector('#editFramesUniformMs');
  uniformBtn.addEventListener('click', () => {
    const ms = parseInt(uniformInp.value, 10);
    if (isFinite(ms) && ms >= 20) {
      _editPushUndo();
      fs.frames.forEach(fr => { fr.delay = ms; });
      fs.fps = Math.max(1, Math.min(60, Math.round(1000 / ms)));
      _renderStrip();
      _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
    }
  });
  /* Loop + trim handlers unchanged from prior shipment. */
  body.querySelector('#editFramesLoop').addEventListener('input', e => {
    fs.loop = Math.max(0, parseInt(e.target.value, 10) || 0);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  const tsEl = body.querySelector('#editFramesTrimStart');
  const teEl = body.querySelector('#editFramesTrimEnd');
  tsEl.addEventListener('input', e => {
    fs.trimStart = Math.min(parseInt(e.target.value, 10), fs.trimEnd);
    tsEl.value = String(fs.trimStart);
    body.querySelector('#editFramesTrimStartVal').textContent = String(fs.trimStart);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  teEl.addEventListener('input', e => {
    fs.trimEnd = Math.max(parseInt(e.target.value, 10), fs.trimStart);
    teEl.value = String(fs.trimEnd);
    body.querySelector('#editFramesTrimEndVal').textContent = String(fs.trimEnd);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  /* Optimize panel handlers. */
  const paletteEl = body.querySelector('#editFramesPalette');
  const paletteValEl = body.querySelector('#editFramesPaletteVal');
  paletteEl.addEventListener('input', e => {
    fs.opt.paletteSize = parseInt(e.target.value, 10) || 256;
    paletteValEl.textContent = String(fs.opt.paletteSize);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  body.querySelector('#editFramesColorFormat').addEventListener('change', e => {
    fs.opt.colorFormat = e.target.value || 'rgb565';
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  body.querySelector('#editFramesDedupe').addEventListener('change', e => {
    fs.opt.dedupe = !!e.target.checked;
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
}
function _gifEditPayload(fs){
  /* keepIndices reflects the CURRENT order of fs.frames (post-reorder /
     duplicate). Trim is applied as a positional window over the
     reordered array. Per-frame delays live on fs.frames[i].delay; the
     legacy `delay` field is kept as a fallback for older code paths. */
  const len = fs.frames.length;
  const trimStart = Math.max(0, Math.min(fs.trimStart, len - 1));
  const trimEnd = Math.max(trimStart, Math.min(fs.trimEnd, len - 1));
  const keepIndices = [];
  for (let i = trimStart; i <= trimEnd; i++) {
    if (!fs.frames[i].deleted) keepIndices.push(i);
  }
  return {
    keepIndices,
    delays: keepIndices.map(i => Math.max(20, Math.round(fs.frames[i].delay || 100))),
    delay: Math.round(1000 / Math.max(1, fs.fps)),  /* legacy fallback */
    loop: fs.loop,
    width: fs.width, height: fs.height,
    opt: fs.opt || { paletteSize: 256, colorFormat: 'rgb565', dedupe: false },
  };
}
async function _decodeGifFramesForEdit(file){
  const buf = await file.arrayBuffer();
  const dec = new ImageDecoder({ data: buf, type: 'image/gif' });
  await dec.tracks.ready;
  await dec.completed;
  const track = dec.tracks.selectedTrack;
  const count = track.frameCount;
  if (!count || count < 1) throw new Error('No frames in GIF');
  const frames = [];
  let delaySum = 0, delayN = 0;
  for (let i = 0; i < count; i++) {
    const r = await dec.decode({ frameIndex: i });
    const w = r.image.displayWidth, h = r.image.displayHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(r.image, 0, 0);
    const bmp = await createImageBitmap(c);
    const dur = (r.image.duration || 0) / 1000;
    if (dur > 0) { delaySum += dur; delayN++; }
    frames.push({ bitmap: bmp, delay: dur || 100, originalDelay: dur || 100, deleted: false, originalIdx: i });
    try { r.image.close && r.image.close(); } catch(_){}
  }
  try { dec.close && dec.close(); } catch(_){}
  const avgDelay = delayN > 0 ? delaySum / delayN : 100;
  const fps = Math.max(1, Math.min(60, Math.round(1000 / Math.max(20, avgDelay))));
  return {
    frames, fps, loop: 0,
    trimStart: 0, trimEnd: count - 1,
    width: frames[0].bitmap.width, height: frames[0].bitmap.height,
  };
}
let _gifencInlineMod = null;
async function _ensureGifencInline(){
  if (_gifencInlineMod) return _gifencInlineMod;
  _gifencInlineMod = await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm');
  return _gifencInlineMod;
}
async function _applyGifEdit(file, edits){
  const gifenc = await _ensureGifencInline();
  const GIFEncoder = gifenc.GIFEncoder, quantize = gifenc.quantize, applyPalette = gifenc.applyPalette;
  if (!GIFEncoder || !quantize || !applyPalette) throw new Error('gifenc not available');
  const fs = _editState.framesState;
  if (!fs) throw new Error('frame state missing');
  const keep = edits.keepIndices;
  if (!keep || !keep.length) throw new Error('No frames left after edits');
  const w = edits.width, h = edits.height;
  const opt = edits.opt || { paletteSize: 256, colorFormat: 'rgb565', dedupe: false };
  const paletteSize = Math.max(16, Math.min(256, opt.paletteSize || 256));
  const colorFormat = opt.colorFormat || 'rgb565';
  /* Pre-rasterize every kept frame to {data, delay}. Optional dedupe
     pass collapses near-identical adjacent frames into one and sums
     their delays. Threshold: mean per-pixel absolute diff < 4 (subtle
     compression-level variations get merged; visible motion preserved). */
  const rastered = [];
  for (let k = 0; k < keep.length; k++) {
    const idx = keep[k];
    const fr = fs.frames[idx];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(fr.bitmap, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h).data;
    const delay = edits.delays && edits.delays[k] ? edits.delays[k] : Math.max(20, edits.delay);
    rastered.push({ data, delay });
  }
  /* Dedupe — merge adjacent frames whose mean per-pixel absolute diff
     in RGB is below threshold. Combined frame keeps the EARLIER pixel
     data + the SUM of their delays. Walks linearly; safe even after
     reorder. */
  let frames = rastered;
  if (opt.dedupe && rastered.length > 1) {
    const merged = [rastered[0]];
    const THRESHOLD = 4;  /* empirical: catches LZW noise, leaves real motion */
    for (let i = 1; i < rastered.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = rastered[i];
      let sum = 0;
      const len = Math.min(prev.data.length, cur.data.length);
      for (let j = 0; j < len; j += 16) {
        sum += Math.abs(prev.data[j] - cur.data[j]);
        sum += Math.abs(prev.data[j+1] - cur.data[j+1]);
        sum += Math.abs(prev.data[j+2] - cur.data[j+2]);
      }
      const avg = sum / (len / 16 * 3);
      if (avg < THRESHOLD) {
        prev.delay = Math.min(65535, prev.delay + cur.delay);
      } else {
        merged.push(cur);
      }
    }
    frames = merged;
  }
  const enc = GIFEncoder();
  for (const fr of frames) {
    const palette = quantize(fr.data, paletteSize, { format: colorFormat });
    const indexed = applyPalette(fr.data, palette, colorFormat);
    enc.writeFrame(indexed, w, h, {
      palette, delay: Math.max(20, fr.delay),
      dispose: 2, transparent: false, repeat: edits.loop,
    });
  }
  enc.finish();
  return new Blob([enc.bytes()], { type: 'image/gif' });
}
/* ---- BACKGROUND REMOVAL TAB (scaffold; inference lands next batch) ---- */
/* ---- BACKGROUND REMOVAL TAB (Round 3 — BEN2-ONNX via transformers.js) ----
 * Licenses: transformers.js Apache-2.0 (https://github.com/huggingface/transformers.js/blob/main/LICENSE)
 *           onnx-community/BEN2-ONNX MIT (https://huggingface.co/onnx-community/BEN2-ONNX)
 * WebGPU first (dtype fp32 to avoid fp16 casting bug), WASM q8 fallback (~56 MB).
 * The pipeline singleton persists across modal open/close cycles so the model stays warm.
 */
/* Round 9: Multi-model singleton.
 * 'std' = BEN2-ONNX (Apache-2.0/MIT) — fast, default.
 * 'hq'  = BiRefNet_lite-ONNX (MIT code https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE,
 *         MIT weights https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) — finer edges, ~110 MB fp16 / ~214 MB fp32.
 * Each mode warms independently so toggling between them doesn't re-download.
 */
const _bgPipes = { std: null, hq: null };
const _bgPipePromises = { std: null, hq: null };
let _bgPipeCb = null;   // always points to the most recent progress callback

async function _getBgPipeline(progressCb, mode) {
  mode = (mode === 'hq') ? 'hq' : 'std';
  _bgPipeCb = progressCb || null;
  if (_bgPipes[mode]) return _bgPipes[mode];
  if (!_bgPipePromises[mode]) {
    _bgPipePromises[mode] = (async () => {
      const cbw = (info) => _bgPipeCb && _bgPipeCb(info);
      const mod = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
      const useGPU = !!navigator.gpu;
      let pipe;
      if (mode === 'hq') {
        /* BiRefNet_lite: AutoModel + AutoProcessor; emits 1-channel mask we composite onto original RGB. */
        const { AutoModel, AutoProcessor, RawImage } = mod;
        const id = 'onnx-community/BiRefNet_lite-ONNX';
        let model;
        try {
          const opts = useGPU
            ? { device: 'webgpu', dtype: 'fp16', progress_callback: cbw }
            : { device: 'wasm',   dtype: 'fp32', progress_callback: cbw };
          model = await AutoModel.from_pretrained(id, opts);
        } catch (e) {
          if (useGPU) {
            console.warn('[bg-hq] WebGPU init failed, WASM fp32 fallback:', e);
            model = await AutoModel.from_pretrained(id, { device: 'wasm', dtype: 'fp32', progress_callback: cbw });
          } else { throw e; }
        }
        const processor = await AutoProcessor.from_pretrained(id);
        pipe = async function birefnetRun(src) {
          const image = await RawImage.fromURL(src);
          const w = image.width, h = image.height;
          const { pixel_values } = await processor(image);
          const out = await model({ input_image: pixel_values });
          const outKey = ('output_image' in out) ? 'output_image'
                       : (Object.keys(out).find(k => out[k] && (out[k].dims || Array.isArray(out[k])))) || Object.keys(out)[0];
          let t = out[outKey];
          if (t && Array.isArray(t)) t = t[0];
          if (t && t.dims && t.dims.length === 4) t = t.squeeze(0);
          const probTensor = (t && t.sigmoid) ? t.sigmoid() : t;
          const u8Tensor   = probTensor.mul(255).to('uint8');
          const mask       = await RawImage.fromTensor(u8Tensor);
          const maskResized = mask.resize ? await mask.resize(w, h) : mask;
          const cnv = document.createElement('canvas');
          cnv.width = w; cnv.height = h;
          const ctx2 = cnv.getContext('2d');
          let drawable;
          try {
            drawable = await createImageBitmap(await (await fetch(src)).blob());
          } catch(_) {
            const im = new Image(); im.crossOrigin = 'anonymous';
            await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = src; });
            drawable = im;
          }
          ctx2.drawImage(drawable, 0, 0, w, h);
          const imgData = ctx2.getImageData(0, 0, w, h);
          const md = maskResized.data;
          const N  = w * h;
          const mc = (md.length === N) ? 1 : (md.length === N*4 ? 4 : (md.length === N*3 ? 3 : 1));
          for (let i = 0, j = 0; j < N; i += 4, j++) {
            imgData.data[i+3] = md[j*mc];
          }
          ctx2.putImageData(imgData, 0, 0);
          return [{ toBlob: (type) => new Promise(res => cnv.toBlob(res, type || 'image/png')) }];
        };
      } else {
        const { pipeline } = mod;
        try {
          const opts = useGPU
            ? { device: 'webgpu', dtype: 'fp32', progress_callback: cbw }
            : { device: 'wasm',   dtype: 'q8',   progress_callback: cbw };
          pipe = await pipeline('background-removal', 'onnx-community/BEN2-ONNX', opts);
        } catch (e) {
          if (useGPU) {
            console.warn('[bg] WebGPU init failed, falling back to WASM q8:', e);
            pipe = await pipeline('background-removal', 'onnx-community/BEN2-ONNX',
              { device: 'wasm', dtype: 'q8', progress_callback: cbw });
          } else { throw e; }
        }
      }
      _bgPipes[mode] = pipe;
      return pipe;
    })().catch(e => { _bgPipePromises[mode] = null; throw e; });
  }
  return _bgPipePromises[mode];
}

function _renderBackgroundTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.bgState) _editState.bgState = {};
  const state = _editState.bgState;
  const hasDone = !!_editState.pendingEdits.bgRemoved;

  /* Preview in left column — swap to interactive canvas once a mask exists */
  const bgPreviewCol = _editPreviewEl();
  if (bgPreviewCol) {
    if (hasDone) {
      bgPreviewCol.innerHTML = '<div class="bg-checkerboard" id="bgCheckboard"><canvas id="bgRefineCanvas" class="bg-refine-canvas"></canvas></div>';
    } else {
      bgPreviewCol.innerHTML = '<div class="bg-checkerboard" id="bgCheckboard">'
        + '<img id="bgResultImg" class="bg-result-img" alt="Result" style="display:none">'
        + '<img id="bgOrigThumb" class="bg-orig-thumb" alt="Original">'
        + '</div>';
    }
  }
  /* Controls in right panel */
  const ref = _editState.pendingEdits.bgRefine || { brushPx: 48, hardness: 0.5, mode: 'erase' };
  const refineHTML = hasDone ? (''
    + '<div class="bg-refine-section">'
    +   '<h4>Refine mask</h4>'
    +   '<div class="bg-refine-tool-strip ed-toggle-pair">'
    +     '<button type="button" class="ed-circle-btn' + (ref.mode==="erase"?" active":"") + '" data-bgr-mode="erase" title="Erase" aria-pressed="' + (ref.mode==="erase") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-eraser"/></svg></span>'
    +       '<span class="ed-circle-cap">ERASE</span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn' + (ref.mode==="restore"?" active":"") + '" data-bgr-mode="restore" title="Restore" aria-pressed="' + (ref.mode==="restore") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-brush"/></svg></span>'
    +       '<span class="ed-circle-cap">RESTORE</span>'
    +     '</button>'
    +   '</div>'
    +   '<div class="adj-row">'
    +     '<span class="adj-label">Brush</span>'
    +     '<input type="range" id="bgrBrush" min="6" max="160" step="1" value="' + ref.brushPx + '" title="Brush size — [ and ]">'
    +     '<span class="adj-val" id="bgrBrushVal">' + ref.brushPx + '</span>'
    +   '</div>'
    +   '<div class="adj-row">'
    +     '<span class="adj-label">Soft</span>'
    +     '<input type="range" id="bgrHardness" min="0" max="100" step="1" value="' + Math.round((ref.hardness != null ? ref.hardness : 0.5) * 100) + '">'
    +     '<span class="adj-val" id="bgrHardnessVal">' + Math.round((ref.hardness != null ? ref.hardness : 0.5) * 100) + '%</span>'
    +   '</div>'
    +   '<button type="button" class="ed-circle-btn ed-circle-sm ed-disable-btn' + (((_editState.pendingEdits.bgRefine && _editState.pendingEdits.bgRefine.enabled === false) ? " tab-disabled" : "")) + '" id="bgrDisable" title="' + (((_editState.pendingEdits.bgRefine && _editState.pendingEdits.bgRefine.enabled === false) ? "Enable refinements" : "Disable refinements")) + '" aria-pressed="' + (((_editState.pendingEdits.bgRefine && _editState.pendingEdits.bgRefine.enabled === false) ? "true" : "false")) + '">'
    +     '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-power"/></svg></span>'
    +   '</button>'
    +   '<p class="bg-refine-help">Erase trims extra pixels; Restore brings back the original. Lower Soft = feathered edges, higher = crisp. Use [ and ] to resize.</p>'
    + '</div>'
  ) : '';
  if (!state.mode) state.mode = 'std';
  const mode = state.mode;
  const stdHint = 'First use downloads an AI model (~60 MB, one-time). Runs offline after.';
  const hqHint  = 'First use downloads a larger model (~110 MB, one-time). Finer hair and edges.';
  body.innerHTML = ''
    + '<div class="edit-bg-card">'
    +   '<div class="bg-icon"><svg class="ico ico-lg" aria-hidden="true"><use href="#i-scissors"/></svg></div>'
    +   '<h3>Remove background</h3>'
    +   '<p id="bgModelTag" class="bg-subtitle">' + (mode === 'hq'
          ? 'High quality — slower, sharper edges'
          : 'Cuts out the subject. Saves as transparent PNG.') + '</p>'
    + '</div>'
    + '<div class="bg-mode-toggle" role="tablist" aria-label="Background-removal model quality">'
    +   '<button type="button" class="bg-mode-btn' + (mode==="std"?" active":"") + '" data-bg-mode="std" role="tab" aria-selected="' + (mode==="std") + '">Standard</button>'
    +   '<button type="button" class="bg-mode-btn' + (mode==="hq" ?" active":"") + '" data-bg-mode="hq"  role="tab" aria-selected="' + (mode==="hq") + '">HQ <span class="bg-mode-pill">~110 MB</span></button>'
    + '</div>'
    + '<div id="bgProgressWrap" class="edit-bg-progress-wrap" style="display:none">'
    +   '<div class="edit-bg-progress-bar"><div id="bgFill" class="edit-bg-progress-fill" style="width:0%"></div></div>'
    +   '<span id="bgProgLabel" class="edit-bg-progress-label">Loading model…</span>'
    + '</div>'
    + '<p id="bgSuccessMsg" class="edit-bg-success-msg" style="display:none"></p>'
    + '<button type="button" class="edit-bg-run" id="bgRunBtn">'
    +   (hasDone ? '<svg class="ico" aria-hidden="true"><use href="#i-rotate-ccw"/></svg>Remove again' : '<svg class="ico" aria-hidden="true"><use href="#i-scissors"/></svg>Remove background')
    + '</button>'
    + '<p class="edit-bg-hint" id="bgHint">' + (mode === 'hq' ? hqHint : stdHint) + '</p>'
    + refineHTML;

  const progressWr = document.getElementById('bgProgressWrap');
  const fill       = document.getElementById('bgFill');
  const progLabel  = document.getElementById('bgProgLabel');
  const successMsg = document.getElementById('bgSuccessMsg');
  const runBtn     = document.getElementById('bgRunBtn');

  if (!hasDone) {
    const origThumb = document.getElementById('bgOrigThumb');
    if (origThumb) origThumb.src = _editState.originalUrl || f.url;
  } else {
    successMsg.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg>Background removed — click Save to apply.';
    successMsg.style.color = '#6fcf97';
    successMsg.style.display = '';
    _initBgRefine().catch(e => console.warn('[bg-refine]', e));
  }

  /* Round 9: HQ-mode toggle. Switches model between BEN2-ONNX (std) and BiRefNet_lite-ONNX (hq).
   * Toggling does NOT clear an existing mask — user can compare runs on the same image. */
  body.querySelectorAll('.bg-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.getAttribute('data-bg-mode');
      if (!m || _editState.bgState.mode === m) return;
      _editState.bgState.mode = m;
      body.querySelectorAll('.bg-mode-btn').forEach(b => {
        const isMe = b.getAttribute('data-bg-mode') === m;
        b.classList.toggle('active', isMe);
        b.setAttribute('aria-selected', isMe ? 'true' : 'false');
      });
      const hint = document.getElementById('bgHint');
      if (hint) hint.textContent = (m === 'hq') ? hqHint : stdHint;
      const tag = document.getElementById('bgModelTag');
      if (tag) tag.textContent = (m === 'hq')
        ? 'High quality — slower, sharper edges'
        : 'Cuts out the subject. Saves as transparent PNG.';
    });
  });

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    progressWr.style.display = '';
    fill.style.width = '0%';
    progLabel.textContent = 'Loading model…';
    successMsg.style.display = 'none';

    try {
      const onProgress = (info) => {
        if (info.status === 'downloading' && info.progress != null) {
          const pct = Math.min(Math.round(info.progress), 85);
          fill.style.width = pct + '%';
          progLabel.textContent = 'Downloading: ' + pct + '%';
        } else if (info.status === 'initiate' || info.status === 'loading') {
          fill.style.width = '70%';
          progLabel.textContent = 'Initializing model…';
        } else if (info.status === 'ready') {
          fill.style.width = '88%';
          progLabel.textContent = 'Running inference…';
        }
      };

      const pipe = await _getBgPipeline(onProgress, _editState.bgState.mode || 'std');
      fill.style.width = '90%';
      progLabel.textContent = 'Removing background…';

      const [res] = await pipe(_editState.originalUrl || f.url);
      const blob = await res.toBlob('image/png');

      _editPushUndo();
      _editState.pendingEdits.bgRemoved = blob;
      /* New mask invalidates prior refinement strokes */
      delete _editState.pendingEdits.bgRefine;
      if (state._refineBgBmp){ try { state._refineBgBmp.close && state._refineBgBmp.close(); } catch(_){} state._refineBgBmp = null; }
      if (state._refineOrigBmp){ try { state._refineOrigBmp.close && state._refineOrigBmp.close(); } catch(_){} state._refineOrigBmp = null; }

      if (state.previewUrl) { try { URL.revokeObjectURL(state.previewUrl); } catch(_){} }
      state.previewUrl = URL.createObjectURL(blob);

      fill.style.width = '100%';
      progLabel.textContent = 'Done!';

      setTimeout(() => {
        progressWr.style.display = 'none';
        runBtn.disabled = false;
        runBtn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-rotate-ccw"/></svg>Remove again';
        _reRenderEditTab();
      }, 500);

    } catch(err) {
      console.error('[bg] removal failed', err);
      progressWr.style.display = 'none';
      successMsg.textContent = '⚠ Failed: ' + (err.message || String(err)).slice(0, 90);
      successMsg.style.color = '#eb5757';
      successMsg.style.display = '';
      runBtn.disabled = false;
    }
  });
}


/* ---- ROUND 8: BACKGROUND REFINE BRUSHES (erase / restore over BEN2 alpha) ---- */
function _bgMakeBrushSprite(radius, hardness){
  const r = Math.max(0.5, radius);
  const size = Math.max(2, Math.ceil(r * 2) + 2);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const cx = size / 2, cy = size / 2;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  const h = Math.max(0, Math.min(0.99, hardness != null ? hardness : 0.5));
  g.addColorStop(0, 'rgba(255,255,255,1)');
  if (h > 0) g.addColorStop(h, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}
function _bgRingCursor(diameterPx){
  const d = Math.max(8, Math.min(220, Math.round(diameterPx)));
  const r = Math.max(2, d / 2 - 1);
  const cx = d / 2;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + d + '" height="' + d + '">'
    + '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="white" stroke-width="1.6" />'
    + '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="black" stroke-width="1" stroke-dasharray="3 3" />'
    + '</svg>';
  return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '") ' + cx + ' ' + cx + ', crosshair';
}
function _bgStampStrokeInto(maskCtx, stk, dw, dh){
  if (!stk.pts || !stk.pts.length) return;
  const minD = Math.min(dw, dh);
  const r = (stk.pts[0].r != null ? stk.pts[0].r : 0.04) * minD;
  const sprite = _bgMakeBrushSprite(r, stk.hardness != null ? stk.hardness : 0.5);
  const half = sprite.width / 2;
  let last = null;
  for (let i = 0; i < stk.pts.length; i++){
    const p = stk.pts[i];
    const x = p.x * dw, y = p.y * dh;
    maskCtx.drawImage(sprite, x - half, y - half);
    if (last){
      const dx = x - last.x, dy = y - last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, r / 3);
      const n = Math.ceil(dist / step);
      for (let k = 1; k < n; k++){
        const t = k / n;
        maskCtx.drawImage(sprite, last.x + dx * t - half, last.y + dy * t - half);
      }
    }
    last = { x: x, y: y };
  }
}
async function _initBgRefine(){
  const state = _editState.bgState;
  if (!_editState.pendingEdits.bgRemoved) return;
  if (!_editState.pendingEdits.bgRefine){
    _editState.pendingEdits.bgRefine = { strokes: [], brushPx: 48, hardness: 0.5, mode: 'erase' };
  }
  const ref = _editState.pendingEdits.bgRefine;
  const canvas = document.getElementById('bgRefineCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  if (!state._refineBgBmp){
    state._refineBgBmp = await createImageBitmap(_editState.pendingEdits.bgRemoved);
  }
  if (!state._refineOrigBmp){
    state._refineOrigBmp = await createImageBitmap(_editState.originalFile);
  }
  const bgBmp = state._refineBgBmp;
  const origBmp = state._refineOrigBmp;
  function fitDims(){
    const cw = (wrap.clientWidth  || 800);
    const ch = (wrap.clientHeight || 600);
    const ratio = bgBmp.width / bgBmp.height;
    let dw = cw, dh = cw / ratio;
    if (dh > ch){ dh = ch; dw = ch * ratio; }
    return { dw: Math.max(1, Math.floor(dw)), dh: Math.max(1, Math.floor(dh)) };
  }
  const dims = fitDims();
  const dw = dims.dw, dh = dims.dh;
  canvas.width = dw; canvas.height = dh;
  canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
  const ctx = canvas.getContext('2d');
  const eraseMask = document.createElement('canvas');
  eraseMask.width = dw; eraseMask.height = dh;
  const emctx = eraseMask.getContext('2d');
  const restoreMask = document.createElement('canvas');
  restoreMask.width = dw; restoreMask.height = dh;
  const rmctx = restoreMask.getContext('2d');
  const origFit = document.createElement('canvas');
  origFit.width = dw; origFit.height = dh;
  origFit.getContext('2d').drawImage(origBmp, 0, 0, dw, dh);

  function refreshCursor(){ canvas.style.cursor = _bgRingCursor(ref.brushPx); }
  refreshCursor();

  function replayAll(){
    emctx.clearRect(0, 0, dw, dh);
    rmctx.clearRect(0, 0, dw, dh);
    ref.strokes.forEach(stk => {
      _bgStampStrokeInto(stk.mode === 'erase' ? emctx : rmctx, stk, dw, dh);
    });
  }
  function render(){
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(bgBmp, 0, 0, dw, dh);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(eraseMask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(origFit, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(restoreMask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }
  replayAll(); render();

  let painting = false, curStroke = null, curSprite = null, curHalf = 0, curR = 0, curMaskCtx = null, lastXY = null;
  let pendingRender = false;
  function scheduleRender(){
    if (pendingRender) return;
    pendingRender = true;
    requestAnimationFrame(function(){ pendingRender = false; render(); });
  }
  function ptFromClient(cx, cy){
    const rect = canvas.getBoundingClientRect();
    const x = cx - rect.left, y = cy - rect.top;
    return { x: x / dw, y: y / dh, r: (ref.brushPx / 2) / Math.min(dw, dh) };
  }
  function stampIncrement(p){
    curStroke.pts.push(p);
    const x = p.x * dw, y = p.y * dh;
    curMaskCtx.drawImage(curSprite, x - curHalf, y - curHalf);
    if (lastXY){
      const dx = x - lastXY.x, dy = y - lastXY.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, curR / 3);
      const n = Math.ceil(dist / step);
      for (let k = 1; k < n; k++){
        const t = k / n;
        curMaskCtx.drawImage(curSprite, lastXY.x + dx * t - curHalf, lastXY.y + dy * t - curHalf);
      }
    }
    lastXY = { x: x, y: y };
  }
  function down(ev){
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    try { canvas.setPointerCapture(ev.pointerId); } catch(_){}
    _editPushUndo();
    painting = true;
    curStroke = { mode: ref.mode, hardness: ref.hardness, pts: [] };
    ref.strokes.push(curStroke);
    const p = ptFromClient(ev.clientX, ev.clientY);
    curR = p.r * Math.min(dw, dh);
    curSprite = _bgMakeBrushSprite(curR, ref.hardness);
    curHalf = curSprite.width / 2;
    curMaskCtx = (curStroke.mode === 'erase') ? emctx : rmctx;
    lastXY = null;
    stampIncrement(p);
    scheduleRender();
    _updateEditHistoryUI();
  }
  function move(ev){
    if (!painting) return;
    ev.preventDefault();
    let events;
    try { events = ev.getCoalescedEvents && ev.getCoalescedEvents().length ? ev.getCoalescedEvents() : [ev]; }
    catch(_){ events = [ev]; }
    for (let i = 0; i < events.length; i++){
      stampIncrement(ptFromClient(events[i].clientX, events[i].clientY));
    }
    scheduleRender();
  }
  function up(ev){
    if (!painting) return;
    painting = false;
    curStroke = null; curSprite = null; curMaskCtx = null; lastXY = null;
    try { canvas.releasePointerCapture(ev.pointerId); } catch(_){}
    scheduleRender();
  }
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  document.querySelectorAll('#editBody [data-bgr-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#editBody [data-bgr-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      ref.mode = b.dataset.bgrMode;
    });
  });
  const bSl  = document.getElementById('bgrBrush');
  const bVal = document.getElementById('bgrBrushVal');
  if (bSl){
    bSl.addEventListener('input', () => {
      ref.brushPx = parseInt(bSl.value, 10);
      bVal.textContent = ref.brushPx;
      refreshCursor();
    });
  }
  const hSl  = document.getElementById('bgrHardness');
  const hVal = document.getElementById('bgrHardnessVal');
  if (hSl){
    hSl.addEventListener('input', () => {
      ref.hardness = parseInt(hSl.value, 10) / 100;
      hVal.textContent = Math.round(ref.hardness * 100) + '%';
    });
  }
  const clearBtn = document.getElementById('bgrClear');
  if (clearBtn){
    clearBtn.addEventListener('click', () => {
      if (!ref.strokes.length) return;
      _editPushUndo();
      ref.strokes = [];
      replayAll();
      render();
      _updateEditHistoryUI();
    });
  }
}
async function _applyBgRefine(bgRemovedBlob, originalBlob, refInfo){
  if (!refInfo || !refInfo.strokes || !refInfo.strokes.length) return bgRemovedBlob;
  const [bgBmp, origBmp] = await Promise.all([
    createImageBitmap(bgRemovedBlob),
    createImageBitmap(originalBlob)
  ]);
  const W = bgBmp.width, H = bgBmp.height;
  const eraseMask = document.createElement('canvas');
  eraseMask.width = W; eraseMask.height = H;
  const emctx = eraseMask.getContext('2d');
  const restoreMask = document.createElement('canvas');
  restoreMask.width = W; restoreMask.height = H;
  const rmctx = restoreMask.getContext('2d');
  refInfo.strokes.forEach(stk => {
    _bgStampStrokeInto(stk.mode === 'erase' ? emctx : rmctx, stk, W, H);
  });
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  octx.drawImage(bgBmp, 0, 0);
  octx.globalCompositeOperation = 'destination-out';
  octx.drawImage(eraseMask, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  const rest = document.createElement('canvas');
  rest.width = W; rest.height = H;
  const rctx = rest.getContext('2d');
  rctx.drawImage(origBmp, 0, 0, W, H);
  rctx.globalCompositeOperation = 'destination-in';
  rctx.drawImage(restoreMask, 0, 0);
  octx.drawImage(rest, 0, 0);
  try { bgBmp.close && bgBmp.close(); } catch(_){}
  try { origBmp.close && origBmp.close(); } catch(_){}
  return await new Promise(res => out.toBlob(b => res(b), 'image/png'));
}


/* R30c — File-level helpers for tool dropdowns. Hoisted out of
   _renderAdjustTab so Rotate / Pixelate / Blur / BG-refine can use the
   same open/close/portal machinery without duplicating code. */
function _editPositionMenu(trig, menu){
  const r = trig.getBoundingClientRect();
  const menuW = menu.offsetWidth || 140;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
  menu.style.left = left + 'px';
  menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  menu.style.top = 'auto';
}
function _editPortalMenu(menu){
  if (menu.parentNode !== document.body) document.body.appendChild(menu);
}
function _editCloseAllToolDropdowns(){
  document.querySelectorAll('.edit-filter-dd.open, .edit-vignette-dd.open, .edit-adjust-dd.open, .edit-tool-dd.open')
    .forEach(dd => dd.classList.remove('open'));
  document.querySelectorAll('.edit-filter-dd-menu.open, .edit-vignette-dd-menu.open, .edit-adjust-dd-menu.open, .edit-tool-dd-menu.open')
    .forEach(m => m.classList.remove('open'));
  document.querySelectorAll('[id^="edit"][id$="Trigger"]')
    .forEach(t => { if (t.hasAttribute('aria-expanded')) t.setAttribute('aria-expanded', 'false'); });
}
const _editCloseAdjustDropdowns = _editCloseAllToolDropdowns;
function _editWireDropdown(ddId, trigId, menuId){
  const dd = document.getElementById(ddId);
  const trig = document.getElementById(trigId);
  const menu = document.getElementById(menuId);
  if (!dd || !trig || !menu) return;
  trig.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = !dd.classList.contains('open');
    _editCloseAllToolDropdowns();
    if (willOpen){
      dd.classList.add('open');
      menu.classList.add('open');
      trig.setAttribute('aria-expanded', 'true');
      _editPortalMenu(menu);
      _editPositionMenu(trig, menu);
    }
  });
  if (menu.querySelector('input,textarea')){
    menu.addEventListener('click', e => e.stopPropagation());
    menu.addEventListener('mousedown', e => e.stopPropagation());
  }
}
if (!window._editToolDropdownGlobalAttached){
  document.addEventListener('click', () => _editCloseAllToolDropdowns());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _editCloseAllToolDropdowns(); });
  window.addEventListener('resize', () => _editCloseAllToolDropdowns());
  window._editToolDropdownGlobalAttached = true;
}

/* ---- ADJUST TAB (photo: brightness / contrast / saturation / filter presets) ---- */
function _renderAdjustTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.pendingEdits.photoAdjust) {
    /* R47 — sliderEnabled + filterEnabled let users tap-to-disable each
       section while preserving the slider/preset values. iPhone Photos pattern. */
    /* R48 — `selected` tracks which adjustment the shared scrubber
       controls. iPhone Photos pattern: one slider, many icons. */
    _editState.pendingEdits.photoAdjust = { brightness: 100, contrast: 100, saturation: 100, globalBlur: 0, preset: 'none', presetCss: '', _dirty: false, sliderEnabled: true, filterEnabled: true, selected: 'brightness' };
  }
  const adj = _editState.pendingEdits.photoAdjust;
  /* R47 — back-fill flags for state restored from older sessions/undo snapshots. */
  if (adj.sliderEnabled === undefined) adj.sliderEnabled = true;
  if (adj.filterEnabled === undefined) adj.filterEnabled = true;
  if (adj.selected === undefined) adj.selected = 'brightness';  /* R48 */
  if (adj.globalBlur === undefined) adj.globalBlur = 0;          /* R59 */
  if (!_editState.pendingEdits.vignette) {
    _editState.pendingEdits.vignette = { amount: 0, midpoint: 50, _dirty: false, enabled: true };
  }
  if (_editState.pendingEdits.vignette.enabled === undefined) _editState.pendingEdits.vignette.enabled = true;
  const vig = _editState.pendingEdits.vignette;
  const PRESETS = [
    { id: 'none',    label: 'Original', css: '' },
    { id: 'bw',      label: 'B&W',      css: 'grayscale(100%)' },
    { id: 'sepia',   label: 'Sepia',    css: 'sepia(100%)' },
    { id: 'vintage', label: 'Vintage',  css: 'sepia(40%) contrast(110%) brightness(90%) saturate(130%)' },
    { id: 'invert',  label: 'Invert',   css: 'invert(100%)' },
    { id: 'cool',    label: 'Cool',     css: 'hue-rotate(200deg) saturate(140%) brightness(105%)' },
    { id: 'warm',    label: 'Warm',     css: 'sepia(30%) saturate(180%) brightness(105%)' },
  ];
  const fmt = v => { const d = v - 100; return d > 0 ? ('+' + d) : ('' + d); };
  const adjPreviewCol = _editPreviewEl();
  if (adjPreviewCol) {
    const _adjSrcUrl = _editState.pendingEdits.autoEnhancedUrl || _editState.originalUrl || f.url;
    adjPreviewCol.innerHTML = `<div class="edit-adjust-preview-wrap"><div class="edit-adjust-img-frame"><img id="editAdjPreview" src="${_adjSrcUrl}" class="edit-adjust-preview" draggable="false" alt=""><div class="edit-vignette-overlay" id="editAdjVignette"></div></div></div>`;
  }
  const _aeOn = !!_editState.pendingEdits.autoEnhanced;
  /* R30 — Adjust tab now mirrors home toolbar density:
     - Auto enhance pill (unchanged)
     - 3 sliders inline (unchanged — sliders need live exploration)
     - FILTER as dropdown chip (was: 7-pill horizontal-scroll strip)
     - VIGNETTE as dropdown chip (was: always-visible amount + midpoint).
     Both dropdowns mirror home .resize-presets-trigger pattern. */
  const _currentPresetLabel = (PRESETS.find(p => p.id === adj.preset) || PRESETS[0]).label;
  const _vigSummary = vig.amount === 0 ? 'Off' : (vig.amount > 0 ? '+' + vig.amount : String(vig.amount));
  /* R30b — Adjust trigger summary. Mirrors iOS Photos' modified indicator:
     "Default" when untouched, "Modified" + accent dot when any slider has
     been moved off 100. */
  const _adjModified = !(adj.brightness === 100 && adj.contrast === 100 && adj.saturation === 100);
  const _adjSummary = _adjModified ? 'Modified' : 'Default';
  const _chev = '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 7 6 4 9 7"/></svg>';
  /* R46 — Adjust controls now flow inline in a single toolbar row,
     mirroring home .adjust-panel density. The 4 chips (auto-enhance,
     ADJUST▾, FILTER▾, VIGNETTE▾) used to stack into 4 vertical rows
     because each chip had width:100%. Wrapping them in
     .edit-tool-toolbar forces horizontal flex; per-chip CSS in R46
     drops the 100% width to content-width. */
    /* R49b — restore missing const declarations consumed by the flat
     carousel template. The first R49 transform's OLD_BLOCK match
     silently failed (a whitespace mismatch I didn't catch), so the
     consts never made it into the file. _renderAdjustTab threw
     ReferenceError on render, leaving the Adjust tab blank. */
  const _fmtV = (val, def) => { const d = val - def; return d > 0 ? ('+' + d) : ('' + d); };
  const _adjVignetteVal = (vig.amount === 0) ? '' : (vig.amount > 0 ? '+' + vig.amount : String(vig.amount));
  const _FILTER_SWATCH = {
    none:    '#888',
    bw:      'linear-gradient(135deg, #fff 0%, #fff 50%, #1a1a1a 50%, #1a1a1a 100%)',
    sepia:   '#a87a5c',
    vintage: '#b8a47c',
    invert:  'radial-gradient(circle, #fff 30%, #111 70%)',
    cool:    '#6090d8',
    warm:    '#d89060',
  };
  /* R50 — Apple Photos pattern. Section-label pill floats over the
     photo; circular icons sit in a horizontal row; tick-mark ruler
     drives the currently-selected adjustment. Filters live in their
     own tab (see _renderFiltersTab). */
  const _scrubKey = adj.selected || 'brightness';
  const _scrubMin = (_scrubKey === 'vignette') ? -100 : 0;
  const _scrubMax = (_scrubKey === 'vignette') ?  100 : 200;
  const _scrubDef = (_scrubKey === 'vignette') ?    0 : 100;
  const _scrubVal = (_scrubKey === 'vignette') ? (vig.amount || 0) : adj[_scrubKey];
  const _scrubDelta = _scrubVal - _scrubDef;
  const _scrubLabel = ({brightness:'BRIGHTNESS',contrast:'CONTRAST',saturation:'SATURATION',vignette:'VIGNETTE'})[_scrubKey];
  const _scrubPct = ((_scrubVal - _scrubMin) / (_scrubMax - _scrubMin)) * 100;
  const _scrubValDisplay = (_scrubKey === 'vignette')
    ? (_scrubVal === 0 ? '0' : (_scrubVal > 0 ? '+' + _scrubVal : String(_scrubVal)))
    : fmt(_scrubVal);
  body.innerHTML = `
    <div class="edit-tool-toolbar edit-adjust-toolbar adj-tab-r50">
      <div class="adj-flat-carousel adj-carousel-r50" role="tablist" aria-label="Adjustments">
        <button type="button" class="adj-flat-btn adj-circle-btn adj-auto-btn${_aeOn?' active':''}" data-adj-action="auto" title="Auto enhance" aria-label="Auto enhance" aria-pressed="${_aeOn}">
          <span class="adj-circle-ring" aria-hidden="true"></span>
          <span class="adj-circle-inner"><svg class="ico" aria-hidden="true"><use href="#${_aeOn?'i-check':'i-wand-sparkles'}"/></svg></span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='brightness'?' selected':''}${adj.brightness!==100?' modified':''}" data-adj-key="brightness" title="Brightness (double-click to reset)" aria-label="Brightness" role="tab" aria-selected="${_scrubKey==='brightness'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-sun"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="brightness">${adj.brightness !== 100 ? _fmtV(adj.brightness, 100) : ''}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='contrast'?' selected':''}${adj.contrast!==100?' modified':''}" data-adj-key="contrast" title="Contrast (double-click to reset)" aria-label="Contrast" role="tab" aria-selected="${_scrubKey==='contrast'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-contrast"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="contrast">${adj.contrast !== 100 ? _fmtV(adj.contrast, 100) : ''}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='saturation'?' selected':''}${adj.saturation!==100?' modified':''}" data-adj-key="saturation" title="Saturation (double-click to reset)" aria-label="Saturation" role="tab" aria-selected="${_scrubKey==='saturation'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-droplets"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="saturation">${adj.saturation !== 100 ? _fmtV(adj.saturation, 100) : ''}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='vignette'?' selected':''}${vig.amount!==0?' modified':''}" data-adj-key="vignette" title="Vignette (double-click to reset)" aria-label="Vignette" role="tab" aria-selected="${_scrubKey==='vignette'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-aperture"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="vignette">${_adjVignetteVal}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='globalBlur'?' selected':''}${adj.globalBlur!==0?' modified':''}" data-adj-key="globalBlur" title="Blur (whole image)" aria-label="Blur" role="tab" aria-selected="${_scrubKey==='globalBlur'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-droplets"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="globalBlur">${adj.globalBlur ? '+' + adj.globalBlur : ''}</span>
          </span>
        </button>
      </div>
      <div class="adj-tick-ruler" id="adjScrubberWrap" data-scrub-key="${_scrubKey}" style="--range:${(_scrubMax - _scrubMin)};">
        <div class="adj-tick-ticks" aria-hidden="true"></div>
        <div class="adj-tick-center" aria-hidden="true"></div>
        <div class="adj-tick-dot" id="adjTickDot" style="left:${_scrubPct.toFixed(2)}%;" aria-hidden="true"></div>
        <input type="range" id="adjScrubSlider" class="adj-tick-input" min="${_scrubMin}" max="${_scrubMax}" step="1" value="${_scrubVal}" aria-label="Adjustment value">
      </div>
    </div>
  `;
  /* R65 — populate ticks for the Adjust scrubber. */
  try { _buildRulerTicks(document.getElementById('adjScrubberWrap')); } catch(_){}
  /* R71b — ensure section pill is created on initial render. The pill
     is created lazily by _syncScrubberToSelected; queue a microtask call
     after the scrubber wiring finishes so the pill exists on first paint.
     Plus directly call _ensureAdjSectionPill upfront so the pill renders
     even if scrubber wiring is short-circuited. */
  try {
    const _initKey = (adj.selected || 'brightness');
    const _initLabel = ({brightness:'Brightness',contrast:'Contrast',saturation:'Saturation',vignette:'Vignette',globalBlur:'Blur'})[_initKey] || _initKey;
    let _initVal = '';
    if (_initKey === 'vignette') {
      const v = vig.amount || 0;
      _initVal = v === 0 ? '' : (v > 0 ? '+' + v : String(v));
    } else if (_initKey === 'globalBlur') {
      _initVal = (adj.globalBlur && adj.globalBlur > 0) ? '+' + adj.globalBlur : '';
    } else {
      const d = adj[_initKey] - 100;
      _initVal = d === 0 ? '' : (d > 0 ? '+' + d : String(d));
    }
    _ensureAdjSectionPill(_initLabel, _initVal);
  } catch(_){}
  const previewImg = document.getElementById('editAdjPreview');
  function _getAdjFilter(){
    const a = _editState.pendingEdits.photoAdjust;
    /* R54 — per-key enabled flags (brightnessEnabled, contrastEnabled,
       saturationEnabled). Disabled keys are skipped from the filter
       composition so their value is visually nullified while preserved
       in state. */
    const filterOn = a.filterEnabled !== false;
    const sliderOn = a.sliderEnabled !== false;
    const pre = (filterOn && a.preset !== 'none' && a.presetCss) ? a.presetCss + ' ' : '';
    let sliders = '';
    if (sliderOn) {
      if (a.brightnessEnabled !== false) sliders += `brightness(${a.brightness}%) `;
      if (a.contrastEnabled   !== false) sliders += `contrast(${a.contrast}%) `;
      if (a.saturationEnabled !== false) sliders += `saturate(${a.saturation}%) `;
      /* R59 — global Blur as part of the CSS filter chain. */
      if (a.globalBlurEnabled !== false && a.globalBlur > 0) sliders += `blur(${a.globalBlur}px) `;
    }
    return (pre + sliders.trim()) || 'none';
  }
  function _markDirty(){
    const a = _editState.pendingEdits.photoAdjust;
    a._dirty = !(a.brightness === 100 && a.contrast === 100 && a.saturation === 100 && a.preset === 'none' && !(a.globalBlur > 0));
    previewImg.style.filter = _getAdjFilter();
    /* R48 — old ADJUST chip is gone; just sync the icon row's modified
       state. Filter chip + Vignette chip still have their own modified
       dot wiring from R47 (no change needed). */
    if (typeof _syncIconStates === 'function') _syncIconStates();
  }
  _markDirty();
  /* R48 — single scrubber routes input to the currently-selected
     adjustment. Icon clicks switch which key the scrubber controls. */
  /* R50 — scrubber drives tick ruler + floating section pill. */
  const _adjLabels = { brightness: 'BRIGHTNESS', contrast: 'CONTRAST', saturation: 'SATURATION', vignette: 'VIGNETTE', globalBlur: 'BLUR' };
  const scrubSlider = document.getElementById('adjScrubSlider');
  const scrubRuler  = document.getElementById('adjScrubberWrap');
  const scrubDot    = document.getElementById('adjTickDot');
  const pillLabel   = document.getElementById('adjSectionPillLabel');
  const pillVal     = document.getElementById('adjSectionPillVal');
  function _scrubRange(key){
    if (key === 'vignette')   return { min: -100, max: 100, def: 0 };
    if (key === 'globalBlur') return { min: 0,    max: 40,  def: 0 };
    return { min: 0, max: 200, def: 100 };
  }
  function _scrubValueFor(key){
    if (key === 'vignette') return _editState.pendingEdits.vignette.amount || 0;
    if (key === 'globalBlur') return _editState.pendingEdits.photoAdjust.globalBlur || 0;
    return _editState.pendingEdits.photoAdjust[key];
  }
  function _scrubDisplay(key, v){
    if (key === 'vignette') return v === 0 ? '0' : (v > 0 ? '+' + v : String(v));
    return fmt(v);
  }
  function _syncTickPos(){
    if (!scrubSlider || !scrubDot) return;
    const k = (_editState.pendingEdits.photoAdjust.selected || 'brightness');
    const r = _scrubRange(k);
    const v = _scrubValueFor(k);
    const pct = ((v - r.min) / (r.max - r.min)) * 100;
    scrubDot.style.left = pct.toFixed(2) + '%';
  }
  function _syncScrubberToSelected(){
    const a = _editState.pendingEdits.photoAdjust;
    const key = a.selected || 'brightness';
    const r = _scrubRange(key);
    const v = _scrubValueFor(key);
    if (scrubSlider) {
      scrubSlider.min = String(r.min);
      scrubSlider.max = String(r.max);
      scrubSlider.value = String(v);
    }
    if (scrubRuler) {
      scrubRuler.dataset.scrubKey = key;
      scrubRuler.style.setProperty('--range', String(r.max - r.min));
      try { _buildRulerTicks(scrubRuler); } catch(_){}
    }
    /* R51 — the pill now lives in editPreviewCol; resolve refs lazily so
       re-rendering the tab picks them up. */
    const _pillEl = document.getElementById('adjSectionPill') || _ensureAdjSectionPill(_adjLabels[key] || key.toUpperCase(), '');
    const _lbl = document.getElementById('adjSectionPillLabel');
    const _val = document.getElementById('adjSectionPillVal');
    if (_lbl) _lbl.textContent = _adjLabels[key] || key.toUpperCase();
    if (_val) _val.textContent = (v === r.def) ? '' : _scrubDisplay(key, v);
    if (_pillEl) _pillEl.hidden = false;
    _syncTickPos();
  }
  function _syncIconStates(){
    const a = _editState.pendingEdits.photoAdjust;
    const v = _editState.pendingEdits.vignette;
    document.querySelectorAll('#editBody .adj-icon-btn').forEach(btn => {
      const k = btn.dataset.adjKey;
      let val, defVal, mag, delta, disabled;
      if (k === 'vignette') {
        val = v.amount; defVal = 0; delta = val; mag = Math.min(100, Math.abs(val));
        disabled = (v.enabled === false);
      } else if (k === 'globalBlur') {
        val = a.globalBlur || 0; defVal = 0; delta = val; mag = Math.min(40, val) / 40 * 100;
        disabled = (a.globalBlurEnabled === false);
      } else {
        val = a[k]; defVal = 100; delta = val - defVal; mag = Math.min(100, Math.abs(delta));
        disabled = (a[k + 'Enabled'] === false);
      }
      btn.classList.toggle('selected', a.selected === k);
      btn.classList.toggle('modified', val !== defVal);
      btn.classList.toggle('icon-disabled', disabled);
      btn.setAttribute('aria-selected', a.selected === k ? 'true' : 'false');
      const valEl = btn.querySelector('.adj-icon-val');
      if (valEl) {
        valEl.textContent = (val !== defVal) ? (delta > 0 ? '+'+delta : String(delta)) : '';
      }
      const dot = btn.querySelector('.adj-icon-dot');
      if (dot) {
        const deg = (mag / 100) * 180;
        if (delta >= 0) dot.style.setProperty('--r48-arc-from', '-90deg');
        else dot.style.setProperty('--r48-arc-from', (-90 - deg) + 'deg');
        dot.style.setProperty('--r48-arc-deg', deg + 'deg');
      }
    });
  }
  /* R57 — iOS-style center detent.
     When the value crosses the default, brief resistance + haptic feedback
     before continuing. State held on the slider element so we don't leak
     between renders. */
  function _applyDetent(slider, newV, prevV, defV){
    /* Only act if we just crossed the default in either direction. */
    const crossed = (prevV < defV && newV > defV) || (prevV > defV && newV < defV) || (prevV !== defV && newV === defV);
    if (!crossed) return newV;
    /* Snap to default and require the user to drag the slider in this
       direction once more to leave. We mark a "sticky" state on the
       element; the next input that goes past default by >= 2 units is
       allowed through, otherwise we clamp back to default. */
    if (newV === defV) {
      slider._detentSticky = true;
      try { if (navigator.vibrate) navigator.vibrate(8); } catch(_){}
      return defV;
    }
    /* Crossed past default in one event — snap to default for this tick. */
    slider._detentSticky = true;
    slider._detentDir = newV > defV ? 1 : -1;
    slider._detentMomentum = 0;
    try { if (navigator.vibrate) navigator.vibrate(8); } catch(_){}
    return defV;
  }
  function _checkDetentRelease(slider, newV, defV){
    /* If sticky and user is dragging away again, count momentum until 2 units */
    if (!slider._detentSticky) return newV;
    if (newV === defV) { slider._detentMomentum = 0; return defV; }
    const dir = newV > defV ? 1 : -1;
    /* If user reversed past default, allow through immediately. */
    if (slider._detentDir && dir !== slider._detentDir && Math.abs(newV - defV) >= 1) {
      slider._detentSticky = false;
      return newV;
    }
    slider._detentMomentum = (slider._detentMomentum || 0) + 1;
    if (slider._detentMomentum >= 2) {
      slider._detentSticky = false;
      return newV;
    }
    return defV;
  }
  if (scrubSlider) {
    scrubSlider.addEventListener('input', () => {
      /* R74 — dropped during-drag detent. User feedback was that it
         felt sluggish (had to drag past zero an extra tick to release).
         Visual gold center mark already gives the "where zero is" cue
         and the on-release snap below handles the final detent. */
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const key = a.selected || 'brightness';
      const r = _scrubRange(key);
      let v = parseInt(scrubSlider.value, 10);
      if (key === 'vignette') {
        v_.amount = v;
        _vigMarkDirty();
      } else if (key === 'globalBlur') {
        a.globalBlur = v;
        a._dirty = a._dirty || v !== 0;
      } else {
        a[key] = v;
      }
      const _val = document.getElementById('adjSectionPillVal');
      if (_val) _val.textContent = (v === r.def) ? '' : _scrubDisplay(key, v);
      _syncTickPos();
      _syncIconStates();
      _markDirty();
    });
    /* R50 — soft snap-to-default on release. */
    scrubSlider.addEventListener('change', () => {
      /* R57 — reset detent on release so next drag starts fresh. */
      scrubSlider._detentSticky = false;
      scrubSlider._detentMomentum = 0;
      scrubSlider._detentDir = 0;
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const key = a.selected || 'brightness';
      const r = _scrubRange(key);
      const cur = _scrubValueFor(key);
      /* R74 — moderate release snap: ±2 around default snaps on lift.
         Lets users land deliberately at ±1, ±2 with a confident grip
         (release while clearly off-center); but a sloppy lift near 0
         confirms 0. Tested feel: "responsive snap" the user asked for. */
      if (Math.abs(cur - r.def) <= 2 && cur !== r.def) {
        if (key === 'vignette') { v_.amount = r.def; _vigMarkDirty(); }
        else { a[key] = r.def; }
        scrubSlider.value = String(r.def);
        const _val = document.getElementById('adjSectionPillVal');
        if (_val) _val.textContent = '';
        _syncTickPos();
        _syncIconStates();
        _markDirty();
      }
      _editPushUndo();
    });
  }
  document.querySelectorAll('#editBody .adj-icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const k = btn.dataset.adjKey;
      if (!k) return;
      if (a.selected === k) {
        /* R64 — toggle disable ONLY when the value is non-default.
           Default state already pre-selects 'brightness'; without this
           guard, the very first click on Brightness was treated as
           "selected → toggle" and set brightnessEnabled=false, leaving
           subsequent scrubber drags invisible because brightness was
           silently disabled. */
        const r = _scrubRange(k);
        const v = _scrubValueFor(k);
        if (v !== r.def) {
          if (k === 'vignette') {
            v_.enabled = (v_.enabled === false);
          } else {
            const flag = k + 'Enabled';
            a[flag] = (a[flag] === false);
          }
          _editPushUndo();
          _syncScrubberToSelected();
          _syncIconStates();
          _markDirty();
          return;
        }
        /* Selected + unmodified — give a pulse so the click isn't silent. */
        btn.classList.remove('pulse');
        void btn.offsetWidth;
        btn.classList.add('pulse');
        setTimeout(() => btn.classList.remove('pulse'), 360);
        return;
      }
      a.selected = k;
      _syncScrubberToSelected();
      _syncIconStates();
    });
    /* R48b — double-click resets that adjustment to default (100).
       Apple Photos has no per-section reset gesture on touch; this is
       the Lightroom Mobile convention adapted for desktop where
       double-click is free. */
    btn.addEventListener('dblclick', () => {
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const k = btn.dataset.adjKey;
      if (!k) return;
      const r = _scrubRange(k);
      const cur = _scrubValueFor(k);
      if (cur === r.def) return;
      _editPushUndo();
      if (k === 'vignette') { v_.amount = r.def; _vigMarkDirty(); }
      else { a[k] = r.def; }
      if (a.selected === k && scrubSlider) {
        scrubSlider.value = String(r.def);
        const _val = document.getElementById('adjSectionPillVal');
        if (_val) _val.textContent = '';
        _syncTickPos();
      }
      _syncIconStates();
      _markDirty();
    });
  });
  /* R49 — old filter popover handler removed; new flat .adj-filter-btn handler is wired above. */
  /* R30c — Helpers are file-level now; just wire the three dropdowns. */
  _editWireDropdown('editFilterDD','editFilterTrigger','editFilterMenu');
  _editWireDropdown('editVignetteDD','editVignetteTrigger','editVignetteMenu');
  _editWireDropdown('editAdjustDD','editAdjustTrigger','editAdjustMenu');
  /* R30b — Reset button inside Adjust popover */
  const _adjReset = document.getElementById('adjResetBtn');
  if (_adjReset){
    _adjReset.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = _editState.pendingEdits.photoAdjust;
      if (a.brightness === 100 && a.contrast === 100 && a.saturation === 100) return;
      _editPushUndo();
      a.brightness = 100; a.contrast = 100; a.saturation = 100;
      const map = [['adjBrightness','adjBrightnessVal',100],
                   ['adjContrast','adjContrastVal',100],
                   ['adjSaturation','adjSaturationVal',100]];
      map.forEach(([id,vid,v]) => {
        const sl = document.getElementById(id); if (sl) sl.value = v;
        const lb = document.getElementById(vid); if (lb) lb.textContent = '0';
      });
      _markDirty();
      _updateEditHistoryUI();
    });
  }
  /* R50 — Auto enhance is the first circle in the carousel. Click toggles. */
  const aeBtn = body.querySelector('[data-adj-action="auto"]');
  if (aeBtn) {
    aeBtn.addEventListener('click', async () => {
      if (aeBtn.disabled) return;
      if (_editState.pendingEdits.autoEnhanced) {
        _editPushUndo();
        if (_editState.pendingEdits.autoEnhancedUrl) {
          try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
        }
        delete _editState.pendingEdits.autoEnhanced;
        delete _editState.pendingEdits.autoEnhancedUrl;
        _updateEditHistoryUI();
        _reRenderEditTab();
        return;
      }
      aeBtn.disabled = true;
      aeBtn.classList.add('busy');
      _editPushUndo();
      try {
        const enhanced = await _runAutoEnhance(_editState.originalFile);
        if (_editState.pendingEdits.autoEnhancedUrl) {
          try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
        }
        _editState.pendingEdits.autoEnhanced = enhanced;
        _editState.pendingEdits.autoEnhancedUrl = URL.createObjectURL(enhanced);
        _updateEditHistoryUI();
        _reRenderEditTab();
      } catch (err) {
        console.warn('[auto-enhance]', err);
        alert('Auto enhance failed: ' + (err.message || err));
        aeBtn.disabled = false;
        aeBtn.classList.remove('busy');
      }
    });
  }
  const aeUndo = document.getElementById('adjAutoEnhanceUndo');
  if (aeUndo) {
    aeUndo.addEventListener('click', () => {
      _editPushUndo();
      if (_editState.pendingEdits.autoEnhancedUrl) {
        try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
      }
      delete _editState.pendingEdits.autoEnhanced;
      delete _editState.pendingEdits.autoEnhancedUrl;
      _updateEditHistoryUI();
      _reRenderEditTab();
    });
  }
  /* Vignette wiring */
  const _vigEl = document.getElementById('editAdjVignette');
  function _vigBuildBg(){
    const v = _editState.pendingEdits.vignette;
    if (!v || v.amount === 0) return 'transparent';
    /* R47 — respect tap-to-disable */
    if (v.enabled === false) return 'transparent';
    const amt = Math.abs(v.amount) / 100;
    const start = Math.max(0, Math.min(100, v.midpoint));
    const col = v.amount > 0 ? '0,0,0' : '255,255,255';
    return `radial-gradient(ellipse at center, rgba(${col},0) ${start}%, rgba(${col},${amt.toFixed(3)}) 100%)`;
  }
  function _vigPaintPreview(){
    if (_vigEl) _vigEl.style.background = _vigBuildBg();
  }
  function _vigMarkDirty(){
    const v = _editState.pendingEdits.vignette;
    v._dirty = v.amount !== 0;
    _vigPaintPreview();
    _updateEditHistoryUI();
  }
  _vigPaintPreview();
  const vigReset = document.getElementById('vigReset');
  /* R48b — reset-all button: zeros brightness/contrast/saturation in
     one click. Distinct from the global Reset in the action pill —
     that one clears every edit (rotate, crop, etc.); this one only
     touches the 3 adjustment values, like a per-tab revert. */
  /* R47 — wire tap-to-disable dots on the 3 modified-able chips */
  try { _r47WireSectionToggles(); } catch(_){}
  function _vigUpdateResetState(){
    if (vigReset) vigReset.disabled = !(_editState.pendingEdits.vignette._dirty);
  }
  _vigUpdateResetState();
  /* R30 — keep the vignette dropdown trigger label in sync with amount.
     Shows "Off" when 0, "+30"/"-15" otherwise. */
  function _updateVigTriggerValue(){
    const el = document.getElementById('editVignetteValue');
    if (!el) return;
    const a = _editState.pendingEdits.vignette.amount;
    el.textContent = a === 0 ? 'Off' : (a > 0 ? '+' + a : String(a));
  }
  [['vigAmount','amount','vigAmountVal', v => (v>0?'+'+v:String(v))],
   ['vigMid','midpoint','vigMidVal', v => String(v)]].forEach(([id, key, valId, fmtFn]) => {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    if (!sl) return;
    sl.addEventListener('input', () => {
      const val = parseInt(sl.value, 10);
      _editState.pendingEdits.vignette[key] = val;
      if (vl) vl.textContent = fmtFn(val);
      _vigMarkDirty();
      _vigUpdateResetState();
      if (key === 'amount') _updateVigTriggerValue();
    });
    sl.addEventListener('change', () => { _editPushUndo(); });
  });
  if (vigReset){
    vigReset.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = _editState.pendingEdits.vignette;
      if (!v._dirty) return;
      _editPushUndo();
      v.amount = 0; v.midpoint = 50; v._dirty = false;
      const a = document.getElementById('vigAmount'); if (a) a.value = '0';
      const av = document.getElementById('vigAmountVal'); if (av) av.textContent = '0';
      const m = document.getElementById('vigMid'); if (m) m.value = '50';
      const mv = document.getElementById('vigMidVal'); if (mv) mv.textContent = '50';
      _vigPaintPreview();
      _updateEditHistoryUI();
      _vigUpdateResetState();
      _updateVigTriggerValue();
    });
  }
}

/* R50 — Filters tab. Split out of Adjust. VSCO/Apple Photos pattern. */


/* R65 — Build tick DOM elements inside a .adj-tick-ticks container.
   range, minorStep, majorEvery are derived from the ruler's --range
   CSS variable. */
function _buildRulerTicks(rulerEl){
  /* R73 — fixed visual density. 40 minor ticks total, major every 5
     (9 majors visible). Same visual on every scrubber, independent of
     the underlying unit range. Apple Photos uses constant density too. */
  if (!rulerEl) return;
  const ticksEl = rulerEl.querySelector('.adj-tick-ticks');
  if (!ticksEl) return;
  const MINOR_COUNT = 40;
  const MAJOR_EVERY = 5;
  const frag = document.createDocumentFragment();
  for (let i = 0; i <= MINOR_COUNT; i++) {
    const pct = (i / MINOR_COUNT) * 100;
    const tick = document.createElement('span');
    tick.className = 'adj-tick' + ((i % MAJOR_EVERY === 0) ? ' major' : '');
    tick.style.left = pct.toFixed(4) + '%';
    frag.appendChild(tick);
  }
  ticksEl.innerHTML = '';
  ticksEl.appendChild(frag);
}

/* R51 — floating section-label pill (BRIGHTNESS, SATURATION, etc.).
   Lives in editPreviewCol so it floats OVER the photo, above the action
   pill, matching Apple Photos. _renderAdjustTab + _renderFiltersTab call
   this to set the label; _switchEditTab clears it on other tabs. */
function _ensureAdjSectionPill(label, value){
  /* R71 — host the pill INSIDE the floating tool surface as its first
     child. That way it stacks above the icons naturally (in flow) and
     can't drift over the icon row. Falls back to editPreviewCol if
     the tool surface isn't present yet. */
  const surface = document.getElementById('editBody');
  const host = surface || document.getElementById('editPreviewCol');
  if (!host) return null;
  let pill = host.querySelector(':scope > .adj-section-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.className = 'adj-section-pill';
    pill.innerHTML = '<span class="adj-section-pill-label"></span><span class="adj-section-pill-val"></span>';
    /* Insert at top so it's the first floating element above the toolbar. */
    if (host.firstChild) host.insertBefore(pill, host.firstChild);
    else host.appendChild(pill);
  }
  const lblEl = pill.querySelector('.adj-section-pill-label');
  const valEl = pill.querySelector('.adj-section-pill-val');
  if (lblEl) lblEl.textContent = (label || '').toUpperCase();
  if (valEl) valEl.textContent = value || '';
  pill.hidden = !label;
  pill.id = 'adjSectionPill';
  if (lblEl) lblEl.id = 'adjSectionPillLabel';
  if (valEl) valEl.id = 'adjSectionPillVal';
  return pill;
}
function _hideAdjSectionPill(){
  const col = document.getElementById('editPreviewCol');
  if (!col) return;
  const pill = col.querySelector('.adj-section-pill');
  if (pill) pill.hidden = true;
}

function _renderFiltersTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  /* R75 — pill creation moved AFTER body.innerHTML below (was wiped). */
  if (!_editState.pendingEdits.photoAdjust) {
    _editState.pendingEdits.photoAdjust = { brightness: 100, contrast: 100, saturation: 100, globalBlur: 0, preset: 'none', presetCss: '', _dirty: false, sliderEnabled: true, filterEnabled: true, selected: 'brightness' };
  }
  const adj = _editState.pendingEdits.photoAdjust;
  if (adj.filterEnabled === undefined) adj.filterEnabled = true;
  const PRESETS = [
    { id: 'none',    label: 'Original', css: '' },
    { id: 'bw',      label: 'B&W',      css: 'grayscale(100%)' },
    { id: 'sepia',   label: 'Sepia',    css: 'sepia(100%)' },
    { id: 'vintage', label: 'Vintage',  css: 'sepia(40%) contrast(110%) brightness(90%) saturate(130%)' },
    { id: 'invert',  label: 'Invert',   css: 'invert(100%)' },
    { id: 'cool',    label: 'Cool',     css: 'hue-rotate(200deg) saturate(140%) brightness(105%)' },
    { id: 'warm',    label: 'Warm',     css: 'sepia(30%) saturate(180%) brightness(105%)' },
  ];
  const adjPreviewCol = _editPreviewEl();
  if (adjPreviewCol) {
    const _src = _editState.pendingEdits.autoEnhancedUrl || _editState.originalUrl || f.url;
    adjPreviewCol.innerHTML = '<div class="edit-adjust-preview-wrap"><div class="edit-adjust-img-frame"><img id="editAdjPreview" src="' + _src + '" class="edit-adjust-preview" draggable="false" alt=""><div class="edit-vignette-overlay" id="editAdjVignette"></div></div></div>';
    const _img = document.getElementById('editAdjPreview');
    if (_img) {
      const filterOn = adj.filterEnabled !== false;
      const pre = (filterOn && adj.preset !== 'none' && adj.presetCss) ? adj.presetCss + ' ' : '';
      const sliders = (adj.sliderEnabled !== false) ? 'brightness(' + adj.brightness + '%) contrast(' + adj.contrast + '%) saturate(' + adj.saturation + '%)' : '';
      _img.style.filter = (pre + sliders) || 'none';
    }
  }
  const _previewSrc = _editState.pendingEdits.autoEnhancedUrl || _editState.originalUrl || f.url;
  body.innerHTML = `
    <div class="edit-tool-toolbar filters-tab-r50">
      <div class="filters-thumb-row" role="tablist" aria-label="Filters">
        ${PRESETS.map(p => `
          <button type="button" class="filter-thumb${p.id === adj.preset ? ' active' : ''}" data-preset="${p.id}" data-css="${p.css}" title="${p.label}" aria-pressed="${p.id === adj.preset}">
            <span class="filter-thumb-img" style="background-image:url('${_previewSrc}');${p.css ? 'filter:' + p.css + ';' : ''}"></span>
            <span class="filter-thumb-name">${p.label}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  /* R75 — create pill AFTER innerHTML so it persists. */
  try { _ensureAdjSectionPill('Filters', ''); } catch(_){}
  body.querySelectorAll('.filter-thumb').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.preset;
      const css = btn.dataset.css || '';
      const a = _editState.pendingEdits.photoAdjust;
      if (a.preset === id) return;
      _editPushUndo();
      a.preset = id;
      a.presetCss = css;
      a._dirty = !(a.brightness === 100 && a.contrast === 100 && a.saturation === 100 && a.preset === 'none' && !(a.globalBlur > 0));
      body.querySelectorAll('.filter-thumb').forEach(b => {
        const on = b.dataset.preset === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const _img = document.getElementById('editAdjPreview');
      if (_img) {
        const filterOn = a.filterEnabled !== false;
        const pre = (filterOn && a.preset !== 'none' && a.presetCss) ? a.presetCss + ' ' : '';
        const sliders = (a.sliderEnabled !== false) ? 'brightness(' + a.brightness + '%) contrast(' + a.contrast + '%) saturate(' + a.saturation + '%)' : '';
        _img.style.filter = (pre + sliders) || 'none';
      }
      _updateEditHistoryUI();
    });
  });
}

async function _applyPhotoAdjust(file, adjInfo){
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  /* R47 — honor per-section enables. If both disabled the function
     would have been skipped by the saveEdit gate; defensive only. */
  const _filtOn = adjInfo.filterEnabled !== false;
  const _slidOn = adjInfo.sliderEnabled !== false;
  const pre = (_filtOn && adjInfo.preset !== 'none' && adjInfo.presetCss) ? adjInfo.presetCss + ' ' : '';
  let slid = '';
  if (_slidOn) {
    if (adjInfo.brightnessEnabled !== false) slid += `brightness(${adjInfo.brightness}%) `;
    if (adjInfo.contrastEnabled   !== false) slid += `contrast(${adjInfo.contrast}%) `;
    if (adjInfo.saturationEnabled !== false) slid += `saturate(${adjInfo.saturation}%) `;
    if (adjInfo.globalBlurEnabled !== false && adjInfo.globalBlur > 0) slid += `blur(${adjInfo.globalBlur}px) `;
  }
  ctx.filter = (pre + slid.trim()) || 'none';
  ctx.drawImage(bmp, 0, 0);
  ctx.filter = 'none';
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('adjust encode failed')), mime, 0.95);
  });
}

/* Round 14 — Vignette: radial gradient composited on top of the photo.
   info = { amount: -100..+100, midpoint: 0..100, _dirty }
   Positive amount = darken corners; negative = lighten corners.
   Ellipse follows the image aspect ratio so the falloff feels natural. */
async function _applyVignette(file, info){
  if (!info || !info._dirty || info.amount === 0) return file;
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const cx = W / 2, cy = H / 2;
  const minHalf = Math.min(W, H) / 2;
  /* Build an elliptical gradient by scaling the canvas before drawing a circular one. */
  const sx = (W / 2) / minHalf;
  const sy = (H / 2) / minHalf;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(sx, sy);
  ctx.translate(-cx, -cy);
  const inner = minHalf * (Math.max(0, Math.min(100, info.midpoint)) / 100);
  const outer = minHalf;
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  const amt = Math.abs(info.amount) / 100;
  if (info.amount > 0){
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${amt})`);
  } else {
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, `rgba(255,255,255,${amt})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  /* Preserve transparency where present (PNG/WEBP); else stick with input mime. */
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('vignette encode failed')), mime, 0.95);
  });
}

/* ---- CROP TAB (photo: aspect presets + drag handles) ---- */
async function _renderCropTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  const cropPreviewCol = _editPreviewEl();
  if (cropPreviewCol) {
    cropPreviewCol.innerHTML = `<div class="edit-crop-canvas-wrap" id="editCropWrap"><canvas id="editCropCanvas"></canvas></div>`;
  }
  body.innerHTML = `
    <div class="edit-crop-presets" id="editCropPresets">
      <span style="font-size:.76rem;font-weight:600;color:rgba(255,255,255,.5);margin-right:4px;letter-spacing:.04em;text-transform:uppercase;">Ratio</span>
      ${[{l:'Free',v:'free'},{l:'1:1',v:'1:1'},{l:'4:3',v:'4:3'},{l:'3:2',v:'3:2'},{l:'16:9',v:'16:9'}]
        .map(p=>`<button type="button" class="edit-preset-btn${p.v==='free'?' active':''}" data-aspect="${p.v}">${p.l}</button>`).join('')}
    </div>
    <p style="font-size:.7rem;color:rgba(255,255,255,.35);margin:0;">Drag the corners or edges to crop</p>
    <button type="button" class="edit-frames-action-btn" id="editCropApplyBtn" style="width:100%;margin-top:auto;">Apply</button>
  `;
  const canvas = document.getElementById('editCropCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('editCropWrap');
  let bmp;
  try { bmp = await createImageBitmap(_editState.originalFile || f.file); }
  catch(e) { body.innerHTML = '<p style="color:rgba(255,120,120,.85);">Could not load image for crop.</p>'; return; }
  const imgW = bmp.width, imgH = bmp.height;
  const pcEl = _editPreviewEl();
  const maxW = Math.min(((pcEl ? pcEl.clientWidth : 640) || 640) - 8, 1600);
  const maxH = Math.min(((pcEl ? pcEl.clientHeight : 500) || 500) - 8, 1000);
  const scale = Math.min(maxW / imgW, maxH / imgH, 1);
  const dispW = Math.round(imgW * scale), dispH = Math.round(imgH * scale);
  canvas.width = dispW; canvas.height = dispH;
  canvas.style.cssText = `width:${dispW}px;height:${dispH}px;display:block;cursor:crosshair;`;
  const HSIZE = 9;
  const pad = 12;
  let crop = { x: pad, y: pad, w: dispW - pad*2, h: dispH - pad*2, aspect: null };
  if (_editState.pendingEdits.photoCrop) {
    const pc = _editState.pendingEdits.photoCrop;
    crop = { x: Math.round(pc.x * scale), y: Math.round(pc.y * scale),
              w: Math.round(pc.w * scale), h: Math.round(pc.h * scale), aspect: pc.aspect };
  }
  function drawCrop(){
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(bmp, 0, 0, dispW, dispH);
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, dispW, dispH);
    // Clear and redraw image inside crop box
    ctx.save();
    ctx.beginPath(); ctx.rect(crop.x, crop.y, crop.w, crop.h); ctx.clip();
    ctx.drawImage(bmp, 0, 0, dispW, dispH);
    ctx.restore();
    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(crop.x + 0.5, crop.y + 0.5, crop.w, crop.h);
    // Rule-of-thirds
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.5;
    for (let i = 1; i <= 2; i++){
      const gx = crop.x + crop.w * i / 3, gy = crop.y + crop.h * i / 3;
      ctx.beginPath(); ctx.moveTo(gx, crop.y); ctx.lineTo(gx, crop.y + crop.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(crop.x, gy); ctx.lineTo(crop.x + crop.w, gy); ctx.stroke();
    }
    // Handles
    const { x, y, w, h } = crop;
    const cx = x + w/2, cy = y + h/2;
    [[x,y],[cx,y],[x+w,y],[x,cy],[x+w,cy],[x,y+h],[cx,y+h],[x+w,y+h]].forEach(([hx,hy]) => {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.stroke();
    });
  }
  function getZone(mx, my){
    const { x, y, w, h } = crop;
    const cx = x+w/2, cy = y+h/2;
    const pts = {nw:[x,y],n:[cx,y],ne:[x+w,y],w:[x,cy],e:[x+w,cy],sw:[x,y+h],s:[cx,y+h],se:[x+w,y+h]};
    for (const [name,[hx,hy]] of Object.entries(pts)){
      if (Math.abs(mx-hx)<=HSIZE+2 && Math.abs(my-hy)<=HSIZE+2) return name;
    }
    if (mx>x && mx<x+w && my>y && my<y+h) return 'move';
    return null;
  }
  const CMAP = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};
  function clamp(c){
    const MIN=20;
    if (c.w < MIN) c.w = MIN; if (c.h < MIN) c.h = MIN;
    if (c.x < 0) c.x = 0; if (c.y < 0) c.y = 0;
    if (c.x + c.w > dispW) { if (c.w < dispW) c.x = dispW - c.w; else c.w = dispW - c.x; }
    if (c.y + c.h > dispH) { if (c.h < dispH) c.y = dispH - c.h; else c.h = dispH - c.y; }
    return c;
  }
  let dragZ = null, dsx = 0, dsy = 0, dsc = null;
  function getEvtXY(e){
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return [src.clientX - r.left, src.clientY - r.top];
  }
  canvas.addEventListener('mousemove', e => {
    const [mx,my] = getEvtXY(e);
    if (dragZ) {
      const dx = mx-dsx, dy = my-dsy;
      const sc = Object.assign({},dsc);
      if (dragZ==='move'){sc.x+=dx;sc.y+=dy;}
      else if (dragZ==='se'){sc.w+=dx;sc.h+=dy;}
      else if (dragZ==='nw'){sc.x+=dx;sc.y+=dy;sc.w-=dx;sc.h-=dy;}
      else if (dragZ==='ne'){sc.w+=dx;sc.y+=dy;sc.h-=dy;}
      else if (dragZ==='sw'){sc.x+=dx;sc.w-=dx;sc.h+=dy;}
      else if (dragZ==='n'){sc.y+=dy;sc.h-=dy;}
      else if (dragZ==='s'){sc.h+=dy;}
      else if (dragZ==='e'){sc.w+=dx;}
      else if (dragZ==='w'){sc.x+=dx;sc.w-=dx;}
      if (crop.aspect && dragZ!=='move'){sc.h=Math.round(sc.w/crop.aspect);}
      crop=clamp(sc); drawCrop();
    } else {
      const z=getZone(mx,my); canvas.style.cursor=CMAP[z]||'crosshair';
    }
  });
  canvas.addEventListener('mousedown', e => {
    const [mx,my]=getEvtXY(e); dragZ=getZone(mx,my);
    if (dragZ){dsx=mx;dsy=my;dsc=Object.assign({},crop);e.preventDefault();}
  });
  const stopDrag = () => { dragZ = null; };
  document.addEventListener('mouseup', stopDrag);
  // Clean up listener when tab switches
  const obs = new MutationObserver(() => { if (!canvas.isConnected){ document.removeEventListener('mouseup',stopDrag); obs.disconnect(); try{bmp.close&&bmp.close();}catch(_){} } });
  obs.observe(_editPreviewEl() || body, {childList:true,subtree:true});
  document.querySelectorAll('#editBody [data-aspect]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#editBody [data-aspect]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const v = btn.dataset.aspect;
      if (v === 'free') { crop.aspect = null; }
      else { const [a,b2]=v.split(':').map(Number); crop.aspect=a/b2; crop.h=Math.round(crop.w/crop.aspect); crop=clamp(crop); }
      drawCrop();
    });
  });
  document.getElementById('editCropApplyBtn').addEventListener('click', () => {
    _editPushUndo();
    _editState.pendingEdits.photoCrop = {
      x: Math.round(crop.x / scale), y: Math.round(crop.y / scale),
      w: Math.max(1,Math.round(crop.w / scale)), h: Math.max(1,Math.round(crop.h / scale)),
      aspect: crop.aspect
    };
    const btn = document.getElementById('editCropApplyBtn');
    if (btn){ btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg>Crop applied'; btn.style.background='rgba(60,160,60,.2)'; btn.style.borderColor='rgba(60,200,60,.3)'; }
  });
  drawCrop();
}
async function _applyPhotoCrop(file, cropInfo){
  const bmp = await createImageBitmap(file);
  const sx=Math.max(0,cropInfo.x), sy=Math.max(0,cropInfo.y);
  const sw=Math.min(cropInfo.w, bmp.width-sx), sh=Math.min(cropInfo.h, bmp.height-sy);
  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res,rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('crop encode failed')), mime, 0.95);
  });
}

/* ---- ROUND 6: AUTO-ENHANCE (gray-world WB + percentile auto-levels + sat) ---- */
async function _runAutoEnhance(file){
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const imgData = ctx.getImageData(0, 0, W, H);
  _autoEnhanceData(imgData);
  ctx.putImageData(imgData, 0, 0);
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('auto-enhance encode failed')), mime, 0.95);
  });
}
function _autoEnhanceData(imgData){
  const d = imgData.data, n = d.length, px = (n >> 2) || 1;
  /* 1. Gray-world white balance (tamed) */
  let sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < n; i += 4){ sumR += d[i]; sumG += d[i+1]; sumB += d[i+2]; }
  const mR = sumR / px, mG = sumG / px, mB = sumB / px;
  const gray = (mR + mG + mB) / 3;
  const tame = v => Math.min(1.45, Math.max(0.70, v));
  const cR = tame(gray / Math.max(mR, 1e-3));
  const cG = tame(gray / Math.max(mG, 1e-3));
  const cB = tame(gray / Math.max(mB, 1e-3));
  for (let i = 0; i < n; i += 4){
    let r = d[i] * cR, g = d[i+1] * cG, b = d[i+2] * cB;
    d[i]   = r < 0 ? 0 : (r > 255 ? 255 : r);
    d[i+1] = g < 0 ? 0 : (g > 255 ? 255 : g);
    d[i+2] = b < 0 ? 0 : (b > 255 ? 255 : b);
  }
  /* 2. Per-channel auto-levels (0.5% / 99.5% percentile clip) */
  const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
  for (let i = 0; i < n; i += 4){ histR[d[i]]++; histG[d[i+1]]++; histB[d[i+2]]++; }
  function pct(hist){
    const lo = px * 0.005, hi = px * 0.995;
    let cum = 0, loV = 0, hiV = 255, foundLo = false;
    for (let v = 0; v < 256; v++){
      cum += hist[v];
      if (!foundLo && cum >= lo){ loV = v; foundLo = true; }
      if (cum >= hi){ hiV = v; break; }
    }
    if (hiV <= loV) hiV = loV + 1;
    return [loV, hiV];
  }
  const [rLo, rHi] = pct(histR);
  const [gLo, gHi] = pct(histG);
  const [bLo, bHi] = pct(histB);
  const lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
  const rS = 255 / (rHi - rLo), gS = 255 / (gHi - gLo), bS = 255 / (bHi - bLo);
  for (let v = 0; v < 256; v++){
    lutR[v] = (v - rLo) * rS;
    lutG[v] = (v - gLo) * gS;
    lutB[v] = (v - bLo) * bS;
  }
  for (let i = 0; i < n; i += 4){
    d[i] = lutR[d[i]]; d[i+1] = lutG[d[i+1]]; d[i+2] = lutB[d[i+2]];
  }
  /* 3. Modest saturation bump (+15%) via luma-preserving scale */
  const sat = 1.15;
  for (let i = 0; i < n; i += 4){
    const r = d[i], g = d[i+1], b = d[i+2];
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let nr = Y + (r - Y) * sat;
    let ng = Y + (g - Y) * sat;
    let nb = Y + (b - Y) * sat;
    d[i]   = nr < 0 ? 0 : (nr > 255 ? 255 : nr);
    d[i+1] = ng < 0 ? 0 : (ng > 255 ? 255 : ng);
    d[i+2] = nb < 0 ? 0 : (nb > 255 ? 255 : nb);
  }
  return imgData;
}

/* ---- ROUND 6: PIXELATE TAB (brush-based mosaic redaction) ---- */
async function _pxBaseBlob(){
  /* Build the snapshot that pixelate is layered on top of:
     applies auto-enhance + rotate + adjust + crop to the original file.
     Cached on _editState until upstream edits change. */
  const pe = _editState.pendingEdits;
  const sig = JSON.stringify({
    a: !!pe.autoEnhanced,
    r: pe.rotate || null,
    j: pe.photoAdjust && pe.photoAdjust._dirty ? pe.photoAdjust : null,
    c: pe.photoCrop || null,
    v: pe.vignette && pe.vignette._dirty ? pe.vignette : null
  });
  if (_editState._pxBaseSig === sig && _editState._pxBaseBlob){
    return _editState._pxBaseBlob;
  }
  let blob = _editState.originalFile;
  if (pe.autoEnhanced) blob = pe.autoEnhanced;
  if (pe.rotate) blob = await _applyRotation(blob, pe.rotate);
  if (pe.photoAdjust && pe.photoAdjust._dirty) blob = await _applyPhotoAdjust(blob, pe.photoAdjust);
  if (pe.photoCrop) blob = await _applyPhotoCrop(blob, pe.photoCrop);
  if (pe.vignette && pe.vignette._dirty) blob = await _applyVignette(blob, pe.vignette);
  if (_editState._pxBaseUrl){ try { URL.revokeObjectURL(_editState._pxBaseUrl); } catch(_){} }
  _editState._pxBaseBlob = blob;
  _editState._pxBaseUrl = URL.createObjectURL(blob);
  _editState._pxBaseSig = sig;
  if (_editState._pxBitmap){ try { _editState._pxBitmap.close && _editState._pxBitmap.close(); } catch(_){} }
  _editState._pxBitmap = null;
  return blob;
}
async function _renderPixelateTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.pendingEdits.pixelate){
    _editState.pendingEdits.pixelate = { strokes: [], blockSize: 14, brushPx: 38, mode: 'paint', enabled: true };
  }
  const px = _editState.pendingEdits.pixelate;
  const previewCol = _editPreviewEl();
  if (previewCol){
    previewCol.innerHTML = '<div class="edit-pixelate-wrap"><canvas id="editPixelateCanvas" class="edit-pixelate-canvas"></canvas></div>';
  }
  /* R54 — unified pattern. Selectable params (Brush, Cell) live as
     circular icons; the shared scrubber drives whichever is selected.
     Paint/Erase remain mode toggles. */
  if (px.selected === undefined) px.selected = 'brush';
  const _pxKey = px.selected;
  const _pxRangeNow = (_pxKey === 'cell') ? { min: 4, max: 60 } : { min: 6, max: 160 };
  const _pxValNow = (_pxKey === 'cell') ? px.blockSize : px.brushPx;
  const _pxPct = ((_pxValNow - _pxRangeNow.min) / (_pxRangeNow.max - _pxRangeNow.min)) * 100;
  body.innerHTML = ''
    + '<div class="edit-pixelate-controls adj-tab-r50">'
    +   '<div class="ed-func-row' + (px.enabled === false ? ' row-disabled' : '') + '" id="pxRow">'
    +     '<button type="button" class="ed-circle-btn' + (px.mode==="paint"?" active":"") + '" data-px-mode="paint" title="Paint" aria-pressed="' + (px.mode==="paint") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-brush"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn' + (px.mode==="erase"?" active":"") + '" data-px-mode="erase" title="Erase" aria-pressed="' + (px.mode==="erase") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-eraser"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn adj-circle-btn' + (_pxKey==="brush"?" selected":"") + '" data-px-key="brush" title="Brush size" aria-pressed="' + (_pxKey==="brush") + '">'
    +       '<span class="ed-circle-ring" aria-hidden="true"></span>'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-aperture"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn adj-circle-btn' + (_pxKey==="cell"?" selected":"") + '" data-px-key="cell" title="Cell size" aria-pressed="' + (_pxKey==="cell") + '">'
    +       '<span class="ed-circle-ring" aria-hidden="true"></span>'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-grid"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn ed-circle-sm ed-disable-btn' + (px.enabled === false ? " tab-disabled" : "") + '" id="pxDisable" title="' + (px.enabled === false ? "Enable pixelate" : "Disable pixelate") + '" aria-pressed="' + (px.enabled === false ? "true" : "false") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-power"/></svg></span>'
    +     '</button>'
    +   '</div>'
    +   '<div class="adj-tick-ruler" id="pxRuler" style="--range:' + (_pxRangeNow.max - _pxRangeNow.min) + ';">'
    +     '<div class="adj-tick-ticks" aria-hidden="true"></div>'
    +     '<div class="adj-tick-center" aria-hidden="true"></div>'
    +     '<div class="adj-tick-dot" id="pxTickDot" style="left:' + _pxPct.toFixed(2) + '%;" aria-hidden="true"></div>'
    +     '<input type="range" id="pxScrub" class="adj-tick-input" min="' + _pxRangeNow.min + '" max="' + _pxRangeNow.max + '" step="1" value="' + _pxValNow + '" aria-label="Pixelate scrubber">'
    +   '</div>'
    + '</div>';
  /* R54 — show floating PIXELATE pill over photo. */
  try {
    const _lbl = _pxKey === 'cell' ? 'CELL' : 'BRUSH';
    _ensureAdjSectionPill('Pixelate · ' + _lbl, String(_pxValNow));
  } catch(_){}
  /* R65 — populate ticks for Pixelate ruler. */
  try { _buildRulerTicks(document.getElementById('pxRuler')); } catch(_){}
  /* Build preview source (applies upstream edits) */
  await _pxBaseBlob();
  let bmp = _editState._pxBitmap;
  if (!bmp){
    bmp = await createImageBitmap(_editState._pxBaseBlob);
    _editState._pxBitmap = bmp;
  }
  const canvas = document.getElementById('editPixelateCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  function fitDims(){
    const cw = (wrap.clientWidth || 800);
    const ch = (wrap.clientHeight || 600);
    const ratio = bmp.width / bmp.height;
    let dw = cw, dh = cw / ratio;
    if (dh > ch){ dh = ch; dw = ch * ratio; }
    return { dw: Math.max(1, Math.floor(dw)), dh: Math.max(1, Math.floor(dh)) };
  }
  const dims = fitDims();
  const dw = dims.dw, dh = dims.dh;
  canvas.width = dw; canvas.height = dh;
  canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
  /* Round 15 — show a sized ring cursor so the brush footprint is visible */
  function _pxRefreshCursor(){ canvas.style.cursor = _bgRingCursor(px.brushPx); }
  _pxRefreshCursor();
  /* R30c — keep "Brush ▾" trigger summary in sync */
  function _pxRefreshSummary(){
    const el = document.getElementById('editPxSummary');
    if (el) el.textContent = 'Brush ' + px.brushPx + ' · Cell ' + px.blockSize;
  }
  _editWireDropdown('editPxDD','editPxTrigger','editPxMenu');
  function buildPixelatedPreview(blockSrc){
    const sx = dw / bmp.width;
    const block = Math.max(2, Math.round(blockSrc * sx));
    const tw = Math.max(1, Math.floor(dw / block));
    const th = Math.max(1, Math.floor(dh / block));
    const tiny = document.createElement('canvas');
    tiny.width = tw; tiny.height = th;
    const tctx = tiny.getContext('2d');
    tctx.imageSmoothingEnabled = false;
    tctx.drawImage(bmp, 0, 0, tw, th);
    const out = document.createElement('canvas');
    out.width = dw; out.height = dh;
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(tiny, 0, 0, tw, th, 0, 0, dw, dh);
    return out;
  }
  let pixCache = null, pixCacheBlock = -1;
  function getPix(){
    if (pixCache && pixCacheBlock === px.blockSize) return pixCache;
    pixCache = buildPixelatedPreview(px.blockSize);
    pixCacheBlock = px.blockSize;
    return pixCache;
  }
  const mask = document.createElement('canvas');
  mask.width = dw; mask.height = dh;
  const mctx = mask.getContext('2d');
  function drawStrokeAt(ctxM, stk, scaleX, scaleY){
    ctxM.fillStyle = '#fff';
    ctxM.strokeStyle = '#fff';
    ctxM.globalCompositeOperation = (stk.mode === 'erase') ? 'destination-out' : 'source-over';
    const minD = Math.min(scaleX, scaleY);
    for (let i = 0; i < stk.pts.length; i++){
      const p = stk.pts[i];
      const x = p.x * scaleX, y = p.y * scaleY, r = p.r * minD;
      ctxM.beginPath(); ctxM.arc(x, y, r, 0, Math.PI * 2); ctxM.fill();
      if (i > 0){
        const prev = stk.pts[i-1];
        const px0 = prev.x * scaleX, py0 = prev.y * scaleY;
        ctxM.lineWidth = r * 2; ctxM.lineCap = 'round';
        ctxM.beginPath(); ctxM.moveTo(px0, py0); ctxM.lineTo(x, y); ctxM.stroke();
      }
    }
    ctxM.globalCompositeOperation = 'source-over';
  }
  function replay(){
    mctx.clearRect(0, 0, dw, dh);
    px.strokes.forEach(stk => drawStrokeAt(mctx, stk, dw, dh));
  }
  const ctx = canvas.getContext('2d');
  function render(){
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(bmp, 0, 0, dw, dh);
    replay();
    const pix = getPix();
    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(pix, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }
  render();
  let painting = false, curStroke = null;
  function ptFromEv(ev){
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
    return { x: cx / dw, y: cy / dh, r: (px.brushPx / 2) / Math.min(dw, dh) };
  }
  function down(ev){
    ev.preventDefault();
    _editPushUndo();
    painting = true;
    curStroke = { mode: px.mode, pts: [ptFromEv(ev)] };
    px.strokes.push(curStroke);
    render();
    _updateEditHistoryUI();
  }
  function move(ev){
    if (!painting) return;
    ev.preventDefault();
    curStroke.pts.push(ptFromEv(ev));
    render();
  }
  function up(){ painting = false; curStroke = null; }
  canvas.addEventListener('mousedown', down);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('touchstart', down, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', up);
  /* R54 — Disable toggle. */
  const _pxDisable = document.getElementById('pxDisable');
  if (_pxDisable) {
    _pxDisable.addEventListener('click', () => {
      const p = _editState.pendingEdits.pixelate;
      p.enabled = (p.enabled === false);
      _pxDisable.classList.toggle('tab-disabled', p.enabled === false);
      _pxDisable.setAttribute('aria-pressed', p.enabled === false ? 'true' : 'false');
      _pxDisable.title = p.enabled === false ? 'Enable pixelate' : 'Disable pixelate';
      const row = document.getElementById('pxRow');
      if (row) row.classList.toggle('row-disabled', p.enabled === false);
      try { if (typeof render === 'function') render(); } catch(_){}
    });
  }
  /* R54 — selectable param icons drive the scrubber. */
  const _pxScrub = document.getElementById('pxScrub');
  const _pxTickDot = document.getElementById('pxTickDot');
  function _pxRange(k){ return (k === 'cell') ? { min:4, max:60 } : { min:6, max:160 }; }
  function _pxVal(k){ return (k === 'cell') ? px.blockSize : px.brushPx; }
  function _pxSetVal(k, v){
    if (k === 'cell') px.blockSize = v; else px.brushPx = v;
  }
  function _pxSyncUI(){
    const k = px.selected || 'brush';
    const r = _pxRange(k);
    const v = _pxVal(k);
    if (_pxScrub){ _pxScrub.min = String(r.min); _pxScrub.max = String(r.max); _pxScrub.value = String(v); }
    if (_pxTickDot) _pxTickDot.style.left = (((v - r.min)/(r.max - r.min))*100).toFixed(2) + '%';
    /* R65 — rebuild ticks when key changes (range differs Brush vs Cell). */
    const ruler = document.getElementById('pxRuler');
    if (ruler) {
      ruler.style.setProperty('--range', String(r.max - r.min));
      try { _buildRulerTicks(ruler); } catch(_){}
    }
    const lbl = document.getElementById('adjSectionPillLabel');
    const val = document.getElementById('adjSectionPillVal');
    if (lbl) lbl.textContent = ('PIXELATE · ' + (k === 'cell' ? 'CELL' : 'BRUSH'));
    if (val) val.textContent = String(v);
  }
  document.querySelectorAll('#editBody [data-px-key]').forEach(b => {
    b.addEventListener('click', () => {
      px.selected = b.dataset.pxKey;
      document.querySelectorAll('#editBody [data-px-key]').forEach(o => {
        const sel = o.dataset.pxKey === px.selected;
        o.classList.toggle('selected', sel);
        o.setAttribute('aria-pressed', sel ? 'true' : 'false');
      });
      _pxSyncUI();
    });
  });
  if (_pxScrub){
    _pxScrub.addEventListener('input', () => {
      const k = px.selected || 'brush';
      const v = parseInt(_pxScrub.value, 10);
      _pxSetVal(k, v);
      _pxSyncUI();
      if (typeof _pxRefreshCursor === 'function') _pxRefreshCursor();
      if (typeof render === 'function') render();
    });
    _pxScrub.addEventListener('change', () => { _editPushUndo(); });
  }
  document.querySelectorAll('#editBody [data-px-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#editBody [data-px-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      px.mode = b.dataset.pxMode;
    });
  });
  /* R54 — legacy pxBrush/pxBlock sliders removed; their values are now
     driven by the unified scrubber. Guard the lookups so a missing
     element doesn't throw and abort the remaining wiring. */
  const brushSl = document.getElementById('pxBrush');
  const brushVal = document.getElementById('pxBrushVal');
  if (brushSl) {
    brushSl.addEventListener('input', () => {
      px.brushPx = parseInt(brushSl.value, 10);
      if (brushVal) brushVal.textContent = px.brushPx;
      if (typeof _pxRefreshCursor === 'function') _pxRefreshCursor();
      if (typeof _pxRefreshSummary === 'function') _pxRefreshSummary();
    });
  }
  const blockSl = document.getElementById('pxBlock');
  const blockVal = document.getElementById('pxBlockVal');
  if (blockSl) {
    blockSl.addEventListener('input', () => {
      px.blockSize = parseInt(blockSl.value, 10);
      if (blockVal) blockVal.textContent = px.blockSize;
      pixCache = null;
      render();
      if (typeof _pxRefreshSummary === 'function') _pxRefreshSummary();
    });
    blockSl.addEventListener('change', () => { _editPushUndo(); });
  }
  /* R54 — Clear is gone (replaced by Disable). Guard the legacy lookup
     so a missing button doesn't throw and abort the rest of the wiring. */
  const _pxClearBtn = document.getElementById('pxClear');
  if (_pxClearBtn) {
    _pxClearBtn.addEventListener('click', () => {
      if (!px.strokes.length) return;
      _editPushUndo();
      px.strokes = [];
      render();
      _updateEditHistoryUI();
    });
  }
}
async function _applyPixelate(file, pixInfo){
  if (!pixInfo || !pixInfo.strokes || !pixInfo.strokes.length) return file;
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const block = Math.max(2, pixInfo.blockSize | 0);
  const tw = Math.max(1, Math.floor(W / block));
  const th = Math.max(1, Math.floor(H / block));
  const tiny = document.createElement('canvas');
  tiny.width = tw; tiny.height = th;
  const tctx = tiny.getContext('2d');
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(bmp, 0, 0, tw, th);
  const pix = document.createElement('canvas');
  pix.width = W; pix.height = H;
  const pctx = pix.getContext('2d');
  pctx.imageSmoothingEnabled = false;
  pctx.drawImage(tiny, 0, 0, tw, th, 0, 0, W, H);
  const mask = document.createElement('canvas');
  mask.width = W; mask.height = H;
  const mctx = mask.getContext('2d');
  pixInfo.strokes.forEach(stk => {
    mctx.fillStyle = '#fff';
    mctx.strokeStyle = '#fff';
    mctx.globalCompositeOperation = (stk.mode === 'erase') ? 'destination-out' : 'source-over';
    const minD = Math.min(W, H);
    for (let i = 0; i < stk.pts.length; i++){
      const p = stk.pts[i];
      const x = p.x * W, y = p.y * H, r = p.r * minD;
      mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
      if (i > 0){
        const prev = stk.pts[i-1];
        const px0 = prev.x * W, py0 = prev.y * H;
        mctx.lineWidth = r * 2; mctx.lineCap = 'round';
        mctx.beginPath(); mctx.moveTo(px0, py0); mctx.lineTo(x, y); mctx.stroke();
      }
    }
    mctx.globalCompositeOperation = 'source-over';
  });
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ttctx = tmp.getContext('2d');
  ttctx.drawImage(pix, 0, 0);
  ttctx.globalCompositeOperation = 'destination-in';
  ttctx.drawImage(mask, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('pixelate encode failed')), mime, 0.95);
  });
}

/* ============================================================
   BLUR TAB (Round 13)
   - Brush-based blur over a pre-rendered ctx.filter='blur(Npx)' canvas
   - "Apply to all" toggle for full-image gaussian blur (DoF aesthetic)
   - Same architecture as Pixelate (Round 6): strokes stored as normalized
     [0..1] coords + per-stroke mode/radius, so they replay at full source
     resolution on save via _applyBlur(blob, blurInfo)
   - Zero new external deps; Canvas2D ctx.filter is browser-native:
     https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/filter
   - Cross-browser support: Chrome 52+, Firefox 49+, Safari 16.4+. For older
     Safari (iOS <16.4) ctx.filter returns undefined; the apply path falls
     back to downsample-upsample bilinear approximation (cheap, acceptable
     visual fidelity for redaction use cases).
   ============================================================ */
async function _blurBaseBlob(){
  /* Compose upstream edits (auto-enhance + rotate + adjust + crop + pixelate)
     so the blur brush previews land on the same image the user will save. */
  const pe = _editState.pendingEdits;
  const sig = JSON.stringify({
    a: !!pe.autoEnhanced,
    r: pe.rotate || null,
    j: pe.photoAdjust && pe.photoAdjust._dirty ? pe.photoAdjust : null,
    c: pe.photoCrop || null,
    v: pe.vignette && pe.vignette._dirty ? pe.vignette : null,
    p: pe.pixelate && pe.pixelate.strokes && pe.pixelate.strokes.length ? pe.pixelate : null
  });
  if (_editState._blurBaseSig === sig && _editState._blurBaseBlob){
    return _editState._blurBaseBlob;
  }
  let blob = _editState.originalFile;
  if (pe.autoEnhanced) blob = pe.autoEnhanced;
  if (pe.rotate) blob = await _applyRotation(blob, pe.rotate);
  if (pe.photoAdjust && pe.photoAdjust._dirty) blob = await _applyPhotoAdjust(blob, pe.photoAdjust);
  if (pe.photoCrop) blob = await _applyPhotoCrop(blob, pe.photoCrop);
  if (pe.vignette && pe.vignette._dirty) blob = await _applyVignette(blob, pe.vignette);
  if (pe.pixelate && pe.pixelate.strokes && pe.pixelate.strokes.length) blob = await _applyPixelate(blob, pe.pixelate);
  _editState._blurBaseBlob = blob;
  _editState._blurBaseSig = sig;
  if (_editState._blurBitmap){ try { _editState._blurBitmap.close && _editState._blurBitmap.close(); } catch(_){} }
  _editState._blurBitmap = null;
  return blob;
}
async function _renderBlurTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.pendingEdits.blur){
    _editState.pendingEdits.blur = { strokes: [], radius: 14, brushPx: 50, mode: 'paint', full: false, enabled: true };
  }
  const bl = _editState.pendingEdits.blur;
  const previewCol = _editPreviewEl();
  if (previewCol){
    previewCol.innerHTML = '<div class="edit-blur-wrap"><canvas id="editBlurCanvas" class="edit-blur-canvas"></canvas></div>';
  }
  /* R54 — unified Blur layout. */
  if (bl.selected === undefined) bl.selected = 'brush';
  const _blKey = bl.selected;
  const _blR = (_blKey === 'amount') ? { min:2, max:40 } : { min:6, max:160 };
  const _blV = (_blKey === 'amount') ? bl.radius : bl.brushPx;
  const _blPct = ((_blV - _blR.min) / (_blR.max - _blR.min)) * 100;
  body.innerHTML = ''
    + '<div class="edit-blur-controls adj-tab-r50">'
    +   '<div class="ed-func-row' + (bl.enabled === false ? ' row-disabled' : '') + '" id="blRow">'
    +     '<button type="button" class="ed-circle-btn' + (bl.mode==="paint"?" active":"") + '" data-bl-mode="paint" title="Paint" aria-pressed="' + (bl.mode==="paint") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-brush"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn' + (bl.mode==="erase"?" active":"") + '" data-bl-mode="erase" title="Erase" aria-pressed="' + (bl.mode==="erase") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-eraser"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn' + (bl.full ? " active" : "") + '" id="blApplyAll" title="' + (bl.full ? "Brush only" : "Whole image") + '" aria-pressed="' + (bl.full?"true":"false") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-globe"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn adj-circle-btn' + (_blKey==="brush"?" selected":"") + '" data-bl-key="brush" title="Brush size" aria-pressed="' + (_blKey==="brush") + '">'
    +       '<span class="ed-circle-ring" aria-hidden="true"></span>'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-aperture"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn adj-circle-btn' + (_blKey==="amount"?" selected":"") + '" data-bl-key="amount" title="Blur amount" aria-pressed="' + (_blKey==="amount") + '">'
    +       '<span class="ed-circle-ring" aria-hidden="true"></span>'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-droplets"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn ed-circle-sm ed-disable-btn' + (bl.enabled === false ? " tab-disabled" : "") + '" id="blDisable" title="' + (bl.enabled === false ? "Enable blur" : "Disable blur") + '" aria-pressed="' + (bl.enabled === false ? "true" : "false") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-power"/></svg></span>'
    +     '</button>'
    +   '</div>'
    +   '<div class="adj-tick-ruler" id="blRuler" style="--range:' + (_blR.max - _blR.min) + ';">'
    +     '<div class="adj-tick-ticks" aria-hidden="true"></div>'
    +     '<div class="adj-tick-center" aria-hidden="true"></div>'
    +     '<div class="adj-tick-dot" id="blTickDot" style="left:' + _blPct.toFixed(2) + '%;" aria-hidden="true"></div>'
    +     '<input type="range" id="blScrub" class="adj-tick-input" min="' + _blR.min + '" max="' + _blR.max + '" step="1" value="' + _blV + '" aria-label="Blur scrubber">'
    +   '</div>'
    + '</div>';
  try {
    const _lbl = _blKey === 'amount' ? 'AMOUNT' : 'BRUSH';
    _ensureAdjSectionPill('Blur · ' + _lbl, String(_blV));
  } catch(_){}
  /* R65 — populate ticks for Blur ruler. */
  try { _buildRulerTicks(document.getElementById('blRuler')); } catch(_){}
  /* Build preview source */
  await _blurBaseBlob();
  let bmp = _editState._blurBitmap;
  if (!bmp){
    bmp = await createImageBitmap(_editState._blurBaseBlob);
    _editState._blurBitmap = bmp;
  }
  const canvas = document.getElementById('editBlurCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  function fitDims(){
    const cw = (wrap.clientWidth || 800);
    const ch = (wrap.clientHeight || 600);
    const ratio = bmp.width / bmp.height;
    let dw = cw, dh = cw / ratio;
    if (dh > ch){ dh = ch; dw = ch * ratio; }
    return { dw: Math.max(1, Math.floor(dw)), dh: Math.max(1, Math.floor(dh)) };
  }
  const dims = fitDims();
  const dw = dims.dw, dh = dims.dh;
  canvas.width = dw; canvas.height = dh;
  canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
  /* Round 15 — show a sized ring cursor so the brush footprint is visible */
  function _blRefreshCursor(){ canvas.style.cursor = _bgRingCursor(bl.brushPx); }
  _blRefreshCursor();
  /* R30c — keep Brush ▾ trigger summary in sync */
  function _blRefreshSummary(){
    const el = document.getElementById('editBlSummary');
    if (el) el.textContent = 'Brush ' + bl.brushPx + ' · Amt ' + bl.radius;
  }
  _editWireDropdown('editBlDD','editBlTrigger','editBlMenu');
  /* Pre-render a fully blurred copy (preview-resolution). Use ctx.filter when
     available; fall back to nearest-neighbour downsample-upsample for old Safari. */
  let blurCache = null, blurCacheR = -1;
  function buildBlurredPreview(radiusSrc){
    /* Scale the source-resolution radius to preview pixels so brush-preview
       blur strength matches what _applyBlur produces at full res. */
    const sx = dw / bmp.width;
    const radius = Math.max(1, radiusSrc * sx);
    const out = document.createElement('canvas');
    out.width = dw; out.height = dh;
    const octx = out.getContext('2d');
    if (typeof octx.filter !== 'undefined'){
      octx.filter = 'blur(' + radius.toFixed(2) + 'px)';
      octx.drawImage(bmp, 0, 0, dw, dh);
      octx.filter = 'none';
    } else {
      /* Fallback: scale-down then scale-up (cheap pseudo-gaussian). */
      const k = Math.max(2, Math.floor(radius));
      const tw = Math.max(1, Math.floor(dw / k));
      const th = Math.max(1, Math.floor(dh / k));
      const tiny = document.createElement('canvas');
      tiny.width = tw; tiny.height = th;
      const tctx = tiny.getContext('2d');
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(bmp, 0, 0, tw, th);
      octx.imageSmoothingEnabled = true;
      octx.drawImage(tiny, 0, 0, tw, th, 0, 0, dw, dh);
    }
    return out;
  }
  function getBlur(){
    if (blurCache && blurCacheR === bl.radius) return blurCache;
    blurCache = buildBlurredPreview(bl.radius);
    blurCacheR = bl.radius;
    return blurCache;
  }
  const mask = document.createElement('canvas');
  mask.width = dw; mask.height = dh;
  const mctx = mask.getContext('2d');
  function drawStrokeAt(ctxM, stk, scaleX, scaleY){
    ctxM.fillStyle = '#fff';
    ctxM.strokeStyle = '#fff';
    ctxM.globalCompositeOperation = (stk.mode === 'erase') ? 'destination-out' : 'source-over';
    const minD = Math.min(scaleX, scaleY);
    for (let i = 0; i < stk.pts.length; i++){
      const p = stk.pts[i];
      const x = p.x * scaleX, y = p.y * scaleY, r = p.r * minD;
      ctxM.beginPath(); ctxM.arc(x, y, r, 0, Math.PI * 2); ctxM.fill();
      if (i > 0){
        const prev = stk.pts[i-1];
        const px0 = prev.x * scaleX, py0 = prev.y * scaleY;
        ctxM.lineWidth = r * 2; ctxM.lineCap = 'round';
        ctxM.beginPath(); ctxM.moveTo(px0, py0); ctxM.lineTo(x, y); ctxM.stroke();
      }
    }
    ctxM.globalCompositeOperation = 'source-over';
  }
  function replay(){
    mctx.clearRect(0, 0, dw, dh);
    if (bl.full){
      /* full-image: fill the entire mask so the blurred copy is composited everywhere */
      mctx.fillStyle = '#fff';
      mctx.fillRect(0, 0, dw, dh);
      /* but still respect erase strokes (let user punch sharp holes) */
      bl.strokes.forEach(stk => {
        if (stk.mode === 'erase') drawStrokeAt(mctx, stk, dw, dh);
      });
    } else {
      bl.strokes.forEach(stk => drawStrokeAt(mctx, stk, dw, dh));
    }
  }
  const ctx = canvas.getContext('2d');
  function render(){
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(bmp, 0, 0, dw, dh);
    replay();
    const bcanvas = getBlur();
    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(bcanvas, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }
  render();
  let painting = false, curStroke = null;
  function ptFromEv(ev){
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
    return { x: cx / dw, y: cy / dh, r: (bl.brushPx / 2) / Math.min(dw, dh) };
  }
  function down(ev){
    ev.preventDefault();
    _editPushUndo();
    painting = true;
    curStroke = { mode: bl.mode, pts: [ptFromEv(ev)] };
    bl.strokes.push(curStroke);
    render();
    _updateEditHistoryUI();
  }
  function move(ev){
    if (!painting) return;
    ev.preventDefault();
    curStroke.pts.push(ptFromEv(ev));
    render();
  }
  function up(){ painting = false; curStroke = null; }
  canvas.addEventListener('mousedown', down);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('touchstart', down, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', up);
  /* R54 — Disable toggle for Blur. */
  const _blDisable = document.getElementById('blDisable');
  if (_blDisable) {
    _blDisable.addEventListener('click', () => {
      const b = _editState.pendingEdits.blur;
      b.enabled = (b.enabled === false);
      _blDisable.classList.toggle('tab-disabled', b.enabled === false);
      _blDisable.setAttribute('aria-pressed', b.enabled === false ? 'true' : 'false');
      _blDisable.title = b.enabled === false ? 'Enable blur' : 'Disable blur';
      const row = document.getElementById('blRow');
      if (row) row.classList.toggle('row-disabled', b.enabled === false);
      try { if (typeof render === 'function') render(); } catch(_){}
    });
  }
  /* R54 — selectable param icons drive the scrubber. */
  const _blScrub = document.getElementById('blScrub');
  const _blTickDot = document.getElementById('blTickDot');
  function _blRange(k){ return (k === 'amount') ? { min:2, max:40 } : { min:6, max:160 }; }
  function _blVal(k){ return (k === 'amount') ? bl.radius : bl.brushPx; }
  function _blSetVal(k, v){ if (k === 'amount') bl.radius = v; else bl.brushPx = v; }
  function _blSyncUI(){
    const k = bl.selected || 'brush';
    const r = _blRange(k);
    const v = _blVal(k);
    if (_blScrub){ _blScrub.min = String(r.min); _blScrub.max = String(r.max); _blScrub.value = String(v); }
    if (_blTickDot) _blTickDot.style.left = (((v - r.min)/(r.max - r.min))*100).toFixed(2) + '%';
    const ruler = document.getElementById('blRuler');
    if (ruler) {
      ruler.style.setProperty('--range', String(r.max - r.min));
      try { _buildRulerTicks(ruler); } catch(_){}
    }
    const lbl = document.getElementById('adjSectionPillLabel');
    const val = document.getElementById('adjSectionPillVal');
    if (lbl) lbl.textContent = ('BLUR · ' + (k === 'amount' ? 'AMOUNT' : 'BRUSH'));
    if (val) val.textContent = String(v);
  }
  document.querySelectorAll('#editBody [data-bl-key]').forEach(b => {
    b.addEventListener('click', () => {
      bl.selected = b.dataset.blKey;
      document.querySelectorAll('#editBody [data-bl-key]').forEach(o => {
        const sel = o.dataset.blKey === bl.selected;
        o.classList.toggle('selected', sel);
        o.setAttribute('aria-pressed', sel ? 'true' : 'false');
      });
      _blSyncUI();
    });
  });
  if (_blScrub){
    _blScrub.addEventListener('input', () => {
      const k = bl.selected || 'brush';
      const v = parseInt(_blScrub.value, 10);
      _blSetVal(k, v);
      _blSyncUI();
      if (typeof _blRefreshCursor === 'function') _blRefreshCursor();
      if (typeof render === 'function') render();
    });
    _blScrub.addEventListener('change', () => { _editPushUndo(); });
  }
  document.querySelectorAll('#editBody [data-bl-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#editBody [data-bl-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      bl.mode = b.dataset.blMode;
    });
  });
  /* R54 — legacy Blur sliders removed; their values are now driven by
     the unified scrubber. Guard lookups. */
  const brushSl = document.getElementById('blBrush');
  const brushVal = document.getElementById('blBrushVal');
  if (brushSl) {
    brushSl.addEventListener('input', () => {
      bl.brushPx = parseInt(brushSl.value, 10);
      if (brushVal) brushVal.textContent = bl.brushPx;
      if (typeof _blRefreshCursor === 'function') _blRefreshCursor();
      if (typeof _blRefreshSummary === 'function') _blRefreshSummary();
    });
  }
  const radiusSl = document.getElementById('blRadius');
  const radiusVal = document.getElementById('blRadiusVal');
  if (radiusSl) {
    radiusSl.addEventListener('input', () => {
      bl.radius = parseInt(radiusSl.value, 10);
      if (radiusVal) radiusVal.textContent = bl.radius;
      blurCache = null;
      render();
      if (typeof _blRefreshSummary === 'function') _blRefreshSummary();
    });
    radiusSl.addEventListener('change', () => { _editPushUndo(); });
  }
  /* R54 — blApplyAll is now a circular icon (no textContent label). */
  const _blApplyAll = document.getElementById('blApplyAll');
  if (_blApplyAll) {
    _blApplyAll.addEventListener('click', () => {
      _editPushUndo();
      bl.full = !bl.full;
      _blApplyAll.classList.toggle('active', bl.full);
      _blApplyAll.setAttribute('aria-pressed', bl.full ? 'true' : 'false');
      _blApplyAll.title = bl.full ? 'Brush only' : 'Whole image';
      render();
      _updateEditHistoryUI();
    });
  }
  /* R54 — Clear replaced by Disable; guard null. */
  const _blClearBtn = document.getElementById('blClear');
  if (_blClearBtn) {
    _blClearBtn.addEventListener('click', () => {
      if (!bl.strokes.length && !bl.full) return;
      _editPushUndo();
      bl.strokes = [];
      bl.full = false;
      render();
      _updateEditHistoryUI();
    });
  }
}
async function _applyBlur(file, blurInfo){
  if (!blurInfo) return file;
  const hasStrokes = blurInfo.strokes && blurInfo.strokes.length;
  if (!hasStrokes && !blurInfo.full) return file;
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const radius = Math.max(1, blurInfo.radius | 0);
  /* Pre-render a fully blurred copy at full resolution. */
  const blurC = document.createElement('canvas');
  blurC.width = W; blurC.height = H;
  const bctx = blurC.getContext('2d');
  if (typeof bctx.filter !== 'undefined'){
    bctx.filter = 'blur(' + radius + 'px)';
    bctx.drawImage(bmp, 0, 0);
    bctx.filter = 'none';
  } else {
    /* Fallback for old Safari: scale-down then scale-up (pseudo-gaussian). */
    const k = Math.max(2, Math.floor(radius));
    const tw = Math.max(1, Math.floor(W / k));
    const th = Math.max(1, Math.floor(H / k));
    const tiny = document.createElement('canvas');
    tiny.width = tw; tiny.height = th;
    const tctx = tiny.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(bmp, 0, 0, tw, th);
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(tiny, 0, 0, tw, th, 0, 0, W, H);
  }
  /* Build mask at full resolution */
  const mask = document.createElement('canvas');
  mask.width = W; mask.height = H;
  const mctx = mask.getContext('2d');
  if (blurInfo.full){
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, W, H);
    /* respect erase strokes */
    (blurInfo.strokes || []).forEach(stk => {
      if (stk.mode !== 'erase') return;
      mctx.fillStyle = '#fff';
      mctx.strokeStyle = '#fff';
      mctx.globalCompositeOperation = 'destination-out';
      const minD = Math.min(W, H);
      for (let i = 0; i < stk.pts.length; i++){
        const p = stk.pts[i];
        const x = p.x * W, y = p.y * H, r = p.r * minD;
        mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
        if (i > 0){
          const prev = stk.pts[i-1];
          const px0 = prev.x * W, py0 = prev.y * H;
          mctx.lineWidth = r * 2; mctx.lineCap = 'round';
          mctx.beginPath(); mctx.moveTo(px0, py0); mctx.lineTo(x, y); mctx.stroke();
        }
      }
      mctx.globalCompositeOperation = 'source-over';
    });
  } else {
    (blurInfo.strokes || []).forEach(stk => {
      mctx.fillStyle = '#fff';
      mctx.strokeStyle = '#fff';
      mctx.globalCompositeOperation = (stk.mode === 'erase') ? 'destination-out' : 'source-over';
      const minD = Math.min(W, H);
      for (let i = 0; i < stk.pts.length; i++){
        const p = stk.pts[i];
        const x = p.x * W, y = p.y * H, r = p.r * minD;
        mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
        if (i > 0){
          const prev = stk.pts[i-1];
          const px0 = prev.x * W, py0 = prev.y * H;
          mctx.lineWidth = r * 2; mctx.lineCap = 'round';
          mctx.beginPath(); mctx.moveTo(px0, py0); mctx.lineTo(x, y); mctx.stroke();
        }
      }
      mctx.globalCompositeOperation = 'source-over';
    });
  }
  /* Composite: blurred-copy masked by mask, drawn on top of original. */
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ttctx = tmp.getContext('2d');
  ttctx.drawImage(blurC, 0, 0);
  ttctx.globalCompositeOperation = 'destination-in';
  ttctx.drawImage(mask, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('blur encode failed')), mime, 0.95);
  });
}

/* ============================================================
   TEXT OVERLAY + WATERMARK (Round 7)
   - System-font stack only (zero new deps, zero license risk)
   - Canvas2D + Pointer Events
   - Stroke-then-fill for readable outlined captions
   - Snap-to-center guides at 6px tolerance
   - 9-anchor quick-position grid (corners + edges + center)
   - Image logo (watermark): FileReader -> dataURL, drawn via drawImage
   - Cited: MDN strokeText/fillText/CanvasRenderingContext2D, Canva default-text,
     WaterMarquee 30% watermark opacity, Adobe Express 9-anchor grid.
   ============================================================ */
const _TX_FONTS = [
  { label: 'Sans',     value: 'Arial, system-ui, sans-serif' },
  { label: 'Helvetica',value: 'Helvetica, Arial, sans-serif' },
  { label: 'Impact',   value: 'Impact, "Arial Black", sans-serif' },
  { label: 'Serif',    value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono',     value: '"Courier New", Courier, monospace' },
  { label: 'Verdana',  value: 'Verdana, Tahoma, sans-serif' },
  { label: 'Trebuchet',value: '"Trebuchet MS", Verdana, sans-serif' },
  { label: 'Comic',    value: '"Comic Sans MS", "Trebuchet MS", sans-serif' },
];

async function _txBaseBlob(){
  /* Compose upstream edits (auto-enhance + rotate + adjust + crop + pixelate)
     so the text overlay preview positions match the final saved image. */
  const pe = _editState.pendingEdits;
  const sig = JSON.stringify({
    a: !!pe.autoEnhanced,
    r: pe.rotate || null,
    j: pe.photoAdjust && pe.photoAdjust._dirty ? pe.photoAdjust : null,
    c: pe.photoCrop || null,
    v: pe.vignette && pe.vignette._dirty ? pe.vignette : null,
    p: pe.pixelate && pe.pixelate.strokes && pe.pixelate.strokes.length ? pe.pixelate : null,
    b: pe.blur && ((pe.blur.strokes && pe.blur.strokes.length) || pe.blur.full) ? pe.blur : null
  });
  if (_editState._txBaseSig === sig && _editState._txBaseBlob){
    return _editState._txBaseBlob;
  }
  let blob = _editState.originalFile;
  if (pe.autoEnhanced) blob = pe.autoEnhanced;
  if (pe.rotate) blob = await _applyRotation(blob, pe.rotate);
  if (pe.photoAdjust && pe.photoAdjust._dirty) blob = await _applyPhotoAdjust(blob, pe.photoAdjust);
  if (pe.photoCrop) blob = await _applyPhotoCrop(blob, pe.photoCrop);
  if (pe.vignette && pe.vignette._dirty) blob = await _applyVignette(blob, pe.vignette);
  if (pe.pixelate && pe.pixelate.strokes && pe.pixelate.strokes.length) blob = await _applyPixelate(blob, pe.pixelate);
  if (pe.blur && ((pe.blur.strokes && pe.blur.strokes.length) || pe.blur.full)) blob = await _applyBlur(blob, pe.blur);
  if (_editState._txBaseUrl){ try { URL.revokeObjectURL(_editState._txBaseUrl); } catch(_){} }
  _editState._txBaseBlob = blob;
  _editState._txBaseUrl = URL.createObjectURL(blob);
  _editState._txBaseSig = sig;
  if (_editState._txBitmap){ try { _editState._txBitmap.close && _editState._txBitmap.close(); } catch(_){} }
  _editState._txBitmap = null;
  return blob;
}

function _txNewTextItem(state, kind){
  const id = 'tx' + (state.nextId++);
  if (kind === 'watermark'){
    return {
      id, type: 'text', text: '© ' + (new Date().getFullYear()),
      x: 0.96, y: 0.95, ax: 1, ay: 1,
      fontFamily: 'Arial, system-ui, sans-serif',
      fontSize: 40, bold: true, italic: false,
      fill: '#ffffff', stroke: '#000000', strokeWidth: 1,
      shadow: false, opacity: 0.35
    };
  }
  return {
    id, type: 'text', text: 'Your text',
    x: 0.5, y: 0.5, ax: 0.5, ay: 0.5,
    fontFamily: 'Impact, "Arial Black", sans-serif',
    fontSize: 96, bold: true, italic: false,
    fill: '#ffffff', stroke: '#000000', strokeWidth: 4,
    shadow: false, opacity: 1.0
  };
}

function _txNewImageItem(state, dataUrl, w, h){
  const id = 'tx' + (state.nextId++);
  return {
    id, type: 'image', imgDataUrl: dataUrl, imgW: w, imgH: h,
    x: 0.96, y: 0.96, ax: 1, ay: 1,
    scale: 0.22,   /* fraction of base-image width */
    opacity: 0.85, rotation: 0
  };
}

function _txDrawItem(ctx, item, baseW, baseH, scaleX, scaleY, imgCache){
  const sMin = Math.min(scaleX, scaleY);
  ctx.save();
  ctx.globalAlpha = (item.opacity != null) ? item.opacity : 1;
  if (item.type === 'image'){
    const img = imgCache[item.id];
    if (!img || !img.complete) { ctx.restore(); return null; }
    const drawW = (item.scale * baseW) * scaleX;
    const drawH = drawW * (item.imgH / item.imgW);
    const cx = item.x * baseW * scaleX;
    const cy = item.y * baseH * scaleY;
    const x = cx - drawW * item.ax;
    const y = cy - drawH * item.ay;
    ctx.drawImage(img, x, y, drawW, drawH);
    ctx.restore();
    return { x, y, w: drawW, h: drawH, cx, cy };
  }
  // text
  const sz = item.fontSize * sMin;
  const family = item.fontFamily;
  const wts = (item.bold ? 'bold ' : '') + (item.italic ? 'italic ' : '');
  ctx.font = wts + sz + 'px ' + family;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const lines = (item.text || '').split('\n');
  let maxW = 0;
  const m0 = ctx.measureText('Mg');
  const ascent = (m0.actualBoundingBoxAscent != null) ? m0.actualBoundingBoxAscent : sz * 0.8;
  const descent = (m0.actualBoundingBoxDescent != null) ? m0.actualBoundingBoxDescent : sz * 0.2;
  const lh = sz * 1.18;
  const widths = lines.map(t => { const m = ctx.measureText(t); if (m.width > maxW) maxW = m.width; return m.width; });
  const totalH = (lines.length - 1) * lh + (ascent + descent);
  const cx = item.x * baseW * scaleX;
  const cy = item.y * baseH * scaleY;
  const blockX = cx - maxW * item.ax;
  const blockY = cy - totalH * item.ay;
  if (item.shadow){
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = Math.max(2, sz * 0.08);
    ctx.shadowOffsetX = sz * 0.04;
    ctx.shadowOffsetY = sz * 0.06;
  }
  if (item.strokeWidth > 0){
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = item.stroke || '#000';
    ctx.lineWidth = item.strokeWidth * sMin * 2; /* doubled so stroke shows half outside */
    for (let i = 0; i < lines.length; i++){
      const lx = blockX;
      const ly = blockY + ascent + i * lh;
      ctx.strokeText(lines[i], lx, ly);
    }
  }
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  ctx.fillStyle = item.fill || '#fff';
  for (let i = 0; i < lines.length; i++){
    const lx = blockX;
    const ly = blockY + ascent + i * lh;
    ctx.fillText(lines[i], lx, ly);
  }
  ctx.restore();
  return { x: blockX, y: blockY, w: maxW, h: totalH, cx, cy };
}

async function _renderTextTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.pendingEdits.textOverlays){
    _editState.pendingEdits.textOverlays = { items: [], selectedId: null, nextId: 1 };
  }
  const state = _editState.pendingEdits.textOverlays;
  const previewCol = _editPreviewEl();
  if (previewCol){
    previewCol.innerHTML = '<div class="edit-text-wrap" id="editTextWrap"><canvas id="editTextCanvas" class="edit-text-canvas"></canvas></div>';
  }
  body.innerHTML = ''
    + '<div class="edit-text-controls">'
    +   '<div class="tx-add-row ed-func-row">'
    +     '<button type="button" class="ed-circle-btn" data-tx-add="text" title="Add text" aria-label="Add text">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-type"/></svg></span>'
    +       '<span class="ed-circle-cap">TEXT</span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn" data-tx-add="watermark" title="Add watermark" aria-label="Add watermark">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-stamp"/></svg></span>'
    +       '<span class="ed-circle-cap">MARK</span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn" data-tx-add="logo" title="Upload an image logo" aria-label="Add logo">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-image"/></svg></span>'
    +       '<span class="ed-circle-cap">LOGO</span>'
    +     '</button>'
    +   '</div>'
    +   '<input type="file" id="txLogoInput" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="display:none;">'
    +   '<div class="tx-item-list" id="txItemList"></div>'
    +   '<div class="tx-sel-controls" id="txSelControls"></div>'
    +   '<p class="tx-anchor-help">Drag any item on the image to position it. Click an item below to select.</p>'
    + '</div>';

  await _txBaseBlob();
  let bmp = _editState._txBitmap;
  if (!bmp){
    bmp = await createImageBitmap(_editState._txBaseBlob);
    _editState._txBitmap = bmp;
  }
  const baseW = bmp.width, baseH = bmp.height;
  const canvas = document.getElementById('editTextCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  function fitDims(){
    const cw = (wrap.clientWidth || 800);
    const ch = (wrap.clientHeight || 600);
    const ratio = baseW / baseH;
    let dw = cw, dh = cw / ratio;
    if (dh > ch){ dh = ch; dw = ch * ratio; }
    return { dw: Math.max(1, Math.floor(dw)), dh: Math.max(1, Math.floor(dh)) };
  }
  const dims = fitDims();
  const dw = dims.dw, dh = dims.dh;
  canvas.width = dw; canvas.height = dh;
  canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
  const sx = dw / baseW, sy = dh / baseH;
  const imgCache = {};
  const ctx = canvas.getContext('2d');
  let snapGuides = { x: false, y: false };

  function ensureImgs(cb){
    let pending = 0;
    state.items.forEach(it => {
      if (it.type === 'image' && !imgCache[it.id]){
        pending++;
        const im = new Image();
        im.onload = () => { imgCache[it.id] = im; if (--pending === 0) cb(); };
        im.onerror = () => { if (--pending === 0) cb(); };
        im.src = it.imgDataUrl;
      }
    });
    if (pending === 0) cb();
  }
  function render(){
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(bmp, 0, 0, dw, dh);
    state.items.forEach(it => {
      const bb = _txDrawItem(ctx, it, baseW, baseH, sx, sy, imgCache);
      it._bbox = bb;
    });
    /* selection outline */
    const sel = state.items.find(it => it.id === state.selectedId);
    if (sel && sel._bbox){
      ctx.save();
      ctx.strokeStyle = 'rgba(255,182,80,.9)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(sel._bbox.x - 2, sel._bbox.y - 2, sel._bbox.w + 4, sel._bbox.h + 4);
      ctx.restore();
    }
    /* snap guides */
    if (snapGuides.x){
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(dw/2, 0); ctx.lineTo(dw/2, dh); ctx.stroke();
      ctx.restore();
    }
    if (snapGuides.y){
      ctx.save();
      ctx.strokeStyle = 'rgba(120,200,255,.7)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(0, dh/2); ctx.lineTo(dw, dh/2); ctx.stroke();
      ctx.restore();
    }
  }
  function renderAll(){ ensureImgs(render); }

  function buildList(){
    const list = document.getElementById('txItemList');
    if (!list) return;
    if (!state.items.length){
      list.innerHTML = '<div class="tx-empty">Nothing added yet — pick Text, Watermark, or Logo above to start.</div>';
    } else {
      list.innerHTML = state.items.map(it => {
        const lbl = it.type === 'image' ? 'Logo' : (it.text || '(empty)').slice(0, 26);
        const ic = it.type === 'image' ? 'IMG' : 'T';
        return '<div class="tx-item-row' + (it.id === state.selectedId ? ' active' : '') + '" data-tx-id="' + it.id + '">'
          + '<span class="tx-item-icon">' + ic + '</span>'
          + '<span class="tx-item-label">' + (lbl.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')) + '</span>'
          + '<button type="button" class="tx-item-del" data-tx-del="' + it.id + '" title="Delete">&times;</button>'
          + '</div>';
      }).join('');
    }
    list.querySelectorAll('[data-tx-id]').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.matches('[data-tx-del]')) return;
        state.selectedId = row.dataset.txId;
        rebuild();
      });
    });
    list.querySelectorAll('[data-tx-del]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _editPushUndo();
        const id = btn.dataset.txDel;
        state.items = state.items.filter(x => x.id !== id);
        delete imgCache[id];
        if (state.selectedId === id) state.selectedId = state.items.length ? state.items[state.items.length-1].id : null;
        rebuild();
        _updateEditHistoryUI();
      });
    });
  }

  function buildSelControls(){
    const sel = state.items.find(it => it.id === state.selectedId);
    const host = document.getElementById('txSelControls');
    if (!host) return;
    if (!sel){
      host.innerHTML = '';
      return;
    }
    if (sel.type === 'text'){
      host.innerHTML = ''
        + '<input type="text" class="tx-text-input" id="txTextInput" maxlength="300" placeholder="Text">'
        + '<select class="tx-font-select" id="txFontSelect">' + _TX_FONTS.map(fn => '<option value="' + fn.value + '">' + fn.label + '</option>').join('') + '</select>'
        + '<div class="adj-row"><span class="adj-label">Size</span><input type="range" id="txSize" min="12" max="320" step="1"><span class="adj-val" id="txSizeVal"></span></div>'
        + '<div class="adj-row"><span class="adj-label">Outline</span><input type="range" id="txStrokeW" min="0" max="12" step="1"><span class="adj-val" id="txStrokeWVal"></span></div>'
        + '<div class="adj-row"><span class="adj-label">Opacity</span><input type="range" id="txOpacity" min="5" max="100" step="1"><span class="adj-val" id="txOpacityVal"></span></div>'
        + '<div class="tx-color-row"><span>Fill</span><input type="text" id="txFillTxt"><input type="color" id="txFill"></div>'
        + '<div class="tx-color-row"><span>Outline</span><input type="text" id="txStrokeTxt"><input type="color" id="txStroke"></div>'
        + '<div class="tx-toggle-row">'
        +   '<button type="button" class="edit-preset-btn" data-tx-toggle="bold">Bold</button>'
        +   '<button type="button" class="edit-preset-btn" data-tx-toggle="italic">Italic</button>'
        +   '<button type="button" class="edit-preset-btn" data-tx-toggle="shadow">Shadow</button>'
        + '</div>'
        + '<div class="tx-anchor-grid" id="txAnchorGrid">'
        +   ['tl','tc','tr','ml','mc','mr','bl','bc','br'].map(p => '<button type="button" class="tx-anchor-btn" data-anchor="' + p + '" title="Snap to ' + p + '">' + p + '</button>').join('')
        + '</div>';

      const input = document.getElementById('txTextInput'); input.value = sel.text;
      input.addEventListener('input', () => { sel.text = input.value; renderAll(); });
      input.addEventListener('change', () => { _editPushUndo(); buildList(); _updateEditHistoryUI(); });

      const fs = document.getElementById('txFontSelect'); fs.value = sel.fontFamily;
      fs.addEventListener('change', () => { _editPushUndo(); sel.fontFamily = fs.value; renderAll(); _updateEditHistoryUI(); });

      const ssz = document.getElementById('txSize'); const sszV = document.getElementById('txSizeVal');
      ssz.value = sel.fontSize; sszV.textContent = sel.fontSize;
      ssz.addEventListener('input', () => { sel.fontSize = parseInt(ssz.value,10); sszV.textContent = ssz.value; renderAll(); });
      ssz.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });

      const stw = document.getElementById('txStrokeW'); const stwV = document.getElementById('txStrokeWVal');
      stw.value = sel.strokeWidth; stwV.textContent = sel.strokeWidth;
      stw.addEventListener('input', () => { sel.strokeWidth = parseInt(stw.value,10); stwV.textContent = stw.value; renderAll(); });
      stw.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });

      const op = document.getElementById('txOpacity'); const opV = document.getElementById('txOpacityVal');
      op.value = Math.round(sel.opacity*100); opV.textContent = op.value + '%';
      op.addEventListener('input', () => { sel.opacity = parseInt(op.value,10)/100; opV.textContent = op.value + '%'; renderAll(); });
      op.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });

      const fill = document.getElementById('txFill'); const fillT = document.getElementById('txFillTxt');
      fill.value = sel.fill; fillT.value = sel.fill;
      const onFill = v => { sel.fill = v; fill.value = v; fillT.value = v; renderAll(); };
      fill.addEventListener('input', () => onFill(fill.value));
      fill.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });
      fillT.addEventListener('change', () => { if (/^#[0-9a-fA-F]{6}$/.test(fillT.value)){ onFill(fillT.value); _editPushUndo(); _updateEditHistoryUI(); } else { fillT.value = sel.fill; }});

      const stk = document.getElementById('txStroke'); const stkT = document.getElementById('txStrokeTxt');
      stk.value = sel.stroke; stkT.value = sel.stroke;
      const onStk = v => { sel.stroke = v; stk.value = v; stkT.value = v; renderAll(); };
      stk.addEventListener('input', () => onStk(stk.value));
      stk.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });
      stkT.addEventListener('change', () => { if (/^#[0-9a-fA-F]{6}$/.test(stkT.value)){ onStk(stkT.value); _editPushUndo(); _updateEditHistoryUI(); } else { stkT.value = sel.stroke; }});

      ['bold','italic','shadow'].forEach(k => {
        const btn = host.querySelector('[data-tx-toggle="' + k + '"]');
        if (btn){
          if (sel[k]) btn.classList.add('active');
          btn.addEventListener('click', () => { _editPushUndo(); sel[k] = !sel[k]; btn.classList.toggle('active', sel[k]); renderAll(); _updateEditHistoryUI(); });
        }
      });
    } else {
      host.innerHTML = ''
        + '<div class="adj-row"><span class="adj-label">Size %</span><input type="range" id="txImgSize" min="5" max="80" step="1"><span class="adj-val" id="txImgSizeVal"></span></div>'
        + '<div class="adj-row"><span class="adj-label">Opacity</span><input type="range" id="txImgOp" min="5" max="100" step="1"><span class="adj-val" id="txImgOpVal"></span></div>'
        + '<div class="tx-anchor-grid" id="txAnchorGrid">'
        +   ['tl','tc','tr','ml','mc','mr','bl','bc','br'].map(p => '<button type="button" class="tx-anchor-btn" data-anchor="' + p + '" title="Snap to ' + p + '">' + p + '</button>').join('')
        + '</div>';

      const sz = document.getElementById('txImgSize'); const szV = document.getElementById('txImgSizeVal');
      sz.value = Math.round(sel.scale*100); szV.textContent = sz.value + '%';
      sz.addEventListener('input', () => { sel.scale = parseInt(sz.value,10)/100; szV.textContent = sz.value + '%'; renderAll(); });
      sz.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });

      const op = document.getElementById('txImgOp'); const opV = document.getElementById('txImgOpVal');
      op.value = Math.round(sel.opacity*100); opV.textContent = op.value + '%';
      op.addEventListener('input', () => { sel.opacity = parseInt(op.value,10)/100; opV.textContent = op.value + '%'; renderAll(); });
      op.addEventListener('change', () => { _editPushUndo(); _updateEditHistoryUI(); });
    }

    /* anchor grid common */
    host.querySelectorAll('[data-anchor]').forEach(btn => {
      btn.addEventListener('click', () => {
        _editPushUndo();
        const a = btn.dataset.anchor;
        const map = { tl:[0.04,0.05,0,0], tc:[0.5,0.05,0.5,0], tr:[0.96,0.05,1,0],
                      ml:[0.04,0.5,0,0.5], mc:[0.5,0.5,0.5,0.5], mr:[0.96,0.5,1,0.5],
                      bl:[0.04,0.95,0,1], bc:[0.5,0.95,0.5,1], br:[0.96,0.95,1,1] };
        const m = map[a]; if (!m) return;
        sel.x = m[0]; sel.y = m[1]; sel.ax = m[2]; sel.ay = m[3];
        renderAll(); _updateEditHistoryUI();
      });
    });
  }
  function rebuild(){
    buildList();
    buildSelControls();
    renderAll();
  }

  /* logo upload */
  const fileInput = document.getElementById('txLogoInput');
  document.querySelectorAll('#editBody [data-tx-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.txAdd;
      if (kind === 'logo'){
        fileInput.click();
        return;
      }
      _editPushUndo();
      const item = _txNewTextItem(state, kind);
      state.items.push(item);
      state.selectedId = item.id;
      rebuild();
      _updateEditHistoryUI();
    });
  });
  fileInput.addEventListener('change', e => {
    const fl = e.target.files && e.target.files[0];
    if (!fl) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const im = new Image();
      im.onload = () => {
        _editPushUndo();
        const item = _txNewImageItem(state, dataUrl, im.naturalWidth, im.naturalHeight);
        state.items.push(item);
        imgCache[item.id] = im;
        state.selectedId = item.id;
        rebuild();
        _updateEditHistoryUI();
      };
      im.onerror = () => alert('Could not load logo image.');
      im.src = dataUrl;
    };
    reader.readAsDataURL(fl);
    fileInput.value = '';
  });

  /* pointer-based hit-test + drag */
  let dragging = null; /* { id, startX, startY, origX, origY, moved } */
  const DRAG_THRESHOLD = 6;
  const SNAP_PX = 8;
  function ptFromEv(ev){
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left),
      y: (ev.clientY - rect.top)
    };
  }
  function hitItem(p){
    for (let i = state.items.length - 1; i >= 0; i--){
      const it = state.items[i];
      const b = it._bbox; if (!b) continue;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return it;
    }
    return null;
  }
  canvas.addEventListener('pointermove', ev => {
    if (dragging) return;
    const p = ptFromEv(ev);
    canvas.classList.toggle('tx-grab', !!hitItem(p));
  });
  canvas.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const p = ptFromEv(ev);
    const hit = hitItem(p);
    if (!hit){
      if (state.selectedId){ state.selectedId = null; rebuild(); }
      return;
    }
    if (state.selectedId !== hit.id){ state.selectedId = hit.id; rebuild(); }
    dragging = { id: hit.id, startX: p.x, startY: p.y, origX: hit.x, origY: hit.y, moved: false };
    try { canvas.setPointerCapture(ev.pointerId); } catch(_){}
  });
  canvas.addEventListener('pointermove', ev => {
    if (!dragging) return;
    const p = ptFromEv(ev);
    const dx = p.x - dragging.startX;
    const dy = p.y - dragging.startY;
    if (!dragging.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!dragging.moved){
      dragging.moved = true;
      _editPushUndo();
      canvas.classList.add('tx-dragging');
    }
    const sel = state.items.find(it => it.id === dragging.id);
    if (!sel) return;
    let nx = dragging.origX + dx / dw;
    let ny = dragging.origY + dy / dh;
    /* snap to center */
    const cx = sel.x * dw, cy = sel.y * dh;
    snapGuides.x = false; snapGuides.y = false;
    if (Math.abs(nx * dw - dw/2) < SNAP_PX){ nx = 0.5; sel.ax = 0.5; snapGuides.x = true; }
    if (Math.abs(ny * dh - dh/2) < SNAP_PX){ ny = 0.5; sel.ay = 0.5; snapGuides.y = true; }
    nx = Math.max(-0.05, Math.min(1.05, nx));
    ny = Math.max(-0.05, Math.min(1.05, ny));
    sel.x = nx; sel.y = ny;
    renderAll();
  });
  function endDrag(ev){
    if (!dragging) return;
    if (dragging.moved){ _updateEditHistoryUI(); }
    dragging = null;
    canvas.classList.remove('tx-dragging');
    snapGuides.x = false; snapGuides.y = false;
    renderAll();
    try { if (ev && ev.pointerId != null) canvas.releasePointerCapture(ev.pointerId); } catch(_){}
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  rebuild();
}

async function _applyTextOverlays(file, state){
  if (!state || !state.items || !state.items.length) return file;
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  /* preload image items */
  const imgCache = {};
  await Promise.all(state.items.filter(it => it.type === 'image').map(it => new Promise(res => {
    const im = new Image();
    im.onload = () => { imgCache[it.id] = im; res(); };
    im.onerror = () => res();
    im.src = it.imgDataUrl;
  })));
  state.items.forEach(it => { _txDrawItem(ctx, it, W, H, 1, 1, imgCache); });
  try { bmp.close && bmp.close(); } catch(_){}
  /* preserve transparency if there is image-logo or shadow */
  const hasAlphaContent = state.items.some(it => it.type === 'image' || it.shadow);
  const mime = (file.type === 'image/jpeg' && !hasAlphaContent) ? 'image/jpeg' : ((file.type === 'image/jpeg') ? 'image/png' : (file.type || 'image/png'));
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('text overlay encode failed')), mime, 0.95);
  });
}

function piDelete(){
  const idx = CFLOW.selected;
  const f = FILES[idx];
  if (!f) return;
  try { URL.revokeObjectURL(f.url); } catch(_){}
  /* Drop encoded + multi-output bundles for this idx, then reindex
     remaining entries below. allEncoded is a parallel sidecar that also
     needs reindexing (was missed before this fix). */
  const e = ENCODE.encoded.get(idx);
  if (e) { try { URL.revokeObjectURL(e.url); } catch(_){} }
  ENCODE.encoded.delete(idx);
  const bundle = ENCODE.allEncoded.get(idx);
  if (bundle) { bundle.forEach(b => { try { URL.revokeObjectURL(b.url); } catch(_){} }); }
  ENCODE.allEncoded.delete(idx);
  /* shift down indices > idx */
  const newMap = new Map();
  ENCODE.encoded.forEach((v, k) => { if (k > idx) newMap.set(k - 1, v); else newMap.set(k, v); });
  ENCODE.encoded = newMap;
  FILES.splice(idx, 1);
  buildThumbs();
  if (FILES.length === 0) { setState('empty'); return; }
  if (CFLOW.selected >= FILES.length) CFLOW.selected = FILES.length - 1;
  if (CFLOW.selected < 0) CFLOW.selected = 0;
  /* If we deleted the last file, transition to empty state instead of
     leaving the workspace stuck with a stale CFLOW.selected. */
  if (FILES.length === 0) {
    setState('empty');
    return;
  }
  document.body.dataset.piActions = 'closed';
  /* Always use multi state when files exist. The solo state's legacy
     UI (pills + slider, no Multi toggle, no format/quality dropdowns)
     was a parallel-implementation branch that lost user config on
     state transition. Cover-flow handles a single thumb just fine. */
  document.body.dataset.state = 'multi';
  /* wireZoom is idempotent (data-zoomWired guard) so calling on every drop is safe */
  if (typeof wireZoom === 'function') wireZoom();
  layoutCoverFlow();
  CFLOW.prevSelected = -1;
  syncMainImage();
}

/* ===== Clear all (with confirm) ===== */
function _setConfirmText(title, body, btnLabel){
  var t = document.getElementById('confirmTitle');
  var p = document.getElementById('confirmBody');
  var b = document.getElementById('confirmPrimaryBtn');
  if (t) t.textContent = title;
  if (p) p.textContent = body;
  if (b) b.textContent = btnLabel;
}
function askClear(){
  /* Intentional clear: user reached for the Clear button, so they know
     what's about to happen. Concise warning, "Clear all" label. */
  window._confirmAction = doClear;
  _setConfirmText(
    'Clear all images?',
    "This removes every image in this batch. You can't undo it.",
    'Clear all');
  document.body.dataset.confirm = 'open';
}
function askLeaveHome(){
  /* Accidental-leave guard: user clicked the logo. Often this is a
     reflex (browsers train people that the wordmark goes home). Use
     warmer language than the Clear warning since they likely didn't
     mean to lose their batch — and remind them why we can't recover
     it (privacy-first, never uploaded). */
  window._confirmAction = function(){ try { doClear(); } catch(_){} window.location.href = '/'; };
  _setConfirmText(
    'Heading home?',
    "Going back clears your current batch. Your images stayed on your device the whole time — nothing's uploaded — so once you leave, they're gone for good.",
    'Leave anyway');
  document.body.dataset.confirm = 'open';
}
function cancelConfirm(){ document.body.dataset.confirm = 'closed'; }

/* ===== before/after slider drag handler ===== */
(function wireSlider(){
  /* Click-and-drag slider. Mousemove-follows was discarded because at
     zoom>1 every cursor move during pan would also drag the divider —
     two gestures fighting for the same pointer. The drag pattern keeps
     the divider where the user puts it and frees pointer movement for
     panning when zoomed.

     Behaviour:
       pointerdown on canvas (zoom=1, has-after, not on a deadzone)
         → snap divider to click X, latch dragging
       pointermove (only when latched)
         → divider follows cursor X
       pointerup / pointercancel
         → unlatch
     When zoom>1, this handler bails immediately so the existing zoom-pan
     handler (in wireZoom) takes over the pointer. */
  function setSplit(canvas, localPct, screenPct){
    localPct = Math.max(0, Math.min(100, localPct));
    if (screenPct == null) screenPct = localPct;
    else screenPct = Math.max(0, Math.min(100, screenPct));
    const after = canvas.querySelector('.compare-after');
    const divider = canvas.querySelector('.compare-divider');
    const handle = canvas.querySelector('.compare-handle');
    /* clip-path + divider use LOCAL coords — both live inside the
       compare-zoom wrapper that's scaled+translated by the zoom. */
    if (after) after.style.clipPath = `inset(0 0 0 ${localPct}%)`;
    /* Divider position + counter-scale in one atomic transform so
       it's a single composite-layer update, paired with the wrap's
       transform on the same paint frame. Eliminates the line-wobble
       that came from style.left (layout) racing the wrap's transform
       (composite). transform-origin is 0 0 (set in CSS) so the math
       is straightforward: place the divider so its visual center
       lands at leftPx in LOCAL coords. */
    if (divider) {
      const cw = (typeof _canvasWidth === 'function' && _canvasWidth())
                  || canvas.getBoundingClientRect().width;
      const z = (typeof ZOOM !== 'undefined' && ZOOM.scale) || 1;
      const inv = 1 / z;
      const leftPx = (cw * localPct / 100) - inv;
      divider.style.transform = `translate3d(${leftPx}px, 0, 0) scaleX(${inv})`;
    }
    /* Handle uses SCREEN coords — it lives outside compare-zoom so it
       isn't affected by the wrapper's transform, and vertical position
       stays at canvas's top:50% (viewport vertical center). */
    if (handle) handle.style.left = screenPct + '%';
  }
  /* The slider's canonical position is its on-SCREEN x percent. Pan/zoom
     changes recompute the LOCAL pct (what setSplit needs) so the divider
     stays anchored to the same SCREEN x while the user pans. Lets the
     user pan the image to find an area of interest and use the slider as
     a fixed gauge — pan and slider are independent gestures. */
  window.SLIDER = window.SLIDER || { screenPct: 50 };
  /* R68 — expose setSplit so setHasAfter (outside this IIFE) can call it. */
  window.setSplit = setSplit;
  window.refreshSliderFromZoom = function(){
    const canvas = document.querySelector('body[data-state="multi"] .stage.multi .image-canvas');
    if (!canvas || !canvas.classList.contains('has-after')) return;
    /* Use cached canvas width to avoid the layout-flush jitter that
       hits when applyZoom is fired 60+ times/sec during pan/zoom.
       Falls back to a live read if the cache isn't populated yet. */
    const w = (typeof _canvasWidth === 'function' && _canvasWidth()) || canvas.getBoundingClientRect().width;
    if (!w) return;
    const z = (typeof ZOOM !== 'undefined' && ZOOM.scale) || 1;
    const panPct = (typeof ZOOM !== 'undefined' && ZOOM.x)
      ? (ZOOM.x / w) * 100 : 0;
    /* Inverse of: screenPct = 50 + (localPct - 50) * z + panPct */
    const localPct = (window.SLIDER.screenPct - 50 - panPct) / z + 50;
    setSplit(canvas, localPct, window.SLIDER.screenPct);
  };
  let dragging = null;
  function inDeadzone(t){
    if (!t || !t.closest) return false;
    return !!(t.closest('.compare-meta') ||
              t.closest('.menu-card') ||
              t.closest('.cover-flow') ||
              t.closest('.brand-bar') ||
              t.closest('.center-status') ||
              t.closest('.zoom-chip') ||
              t.closest('.pi-actions') ||
              t.closest('button'));
  }
  document.addEventListener('pointerdown', e => {
    /* Find the candidate canvas. */
    const handle = e.target.closest && e.target.closest('.compare-handle');
    const ic = e.target.closest && e.target.closest('.image-canvas');
    const canvas = handle ? handle.closest('.image-canvas') : ic;
    if (!canvas) return;
    const stage = canvas.closest('.stage');
    if (!stage || getComputedStyle(stage).display === 'none') return;
    if (!canvas.classList.contains('has-after')) return;
    /* HANDLE-grab works at any zoom level. The handle is the dedicated
       slider thumb — grabbing it always means "drag the slider", never
       "start zoom pan". Body-grab only works at zoom=1; at zoom>1 the
       surrounding canvas belongs to zoom-pan. */
    if (canvas.classList.contains('zoomed') && !handle) return;
    /* Deadzones — only matter for body-grab; the handle is its own thing. */
    if (!handle && inDeadzone(e.target)) return;
    dragging = canvas;
    canvas.classList.add('slider-dragging');
    e.preventDefault();
    moveFrom(e);
    try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch(_){}
  });
  function moveFrom(e){
    if (!dragging) return;
    const rect = dragging.getBoundingClientRect();
    const cx = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
    /* Screen-space pct is the canonical slider position. Stored on
       window.SLIDER so applyZoom() can recompute local pct without
       touching the slider's screen anchor. */
    let screenPctNew = (cx - rect.left) / rect.width * 100;
    if (screenPctNew < 0) screenPctNew = 0;
    if (screenPctNew > 100) screenPctNew = 100;
    window.SLIDER.screenPct = screenPctNew;
    window.refreshSliderFromZoom();
    return;
    /* (Legacy direct-set path below, kept commented for reference) */
    const screenPct = (cx - rect.left) / rect.width * 100;
    /* The compare-zoom wrapper has transform: translate(panX,panY) scale(z)
       with transform-origin:center. So a LOCAL point at percent p maps to
       SCREEN percent: 50 + (p - 50) * z + (panX / canvasW * 100).
       Inverting that gives the local pct from the pointer's screen pct.
       The clip-path / divider / handle all live inside compare-zoom and
       use LOCAL pct, so we must feed setSplit the local value — not the
       raw screen pct that my old code used. */
    const z = (typeof ZOOM !== 'undefined' && ZOOM.scale) || 1;
    const panPct = (typeof ZOOM !== 'undefined' && ZOOM.x)
      ? (ZOOM.x / rect.width) * 100
      : 0;
    let localPct = (screenPct - 50 - panPct) / z + 50;
    if (localPct < 0) localPct = 0;
    if (localPct > 100) localPct = 100;
    setSplit(dragging, localPct);
  }
  document.addEventListener('pointermove', e => { if (dragging) moveFrom(e); });
  function endDrag(){
    if (dragging) dragging.classList.remove('slider-dragging');
    dragging = null;
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
})();

/* Keyboard shortcut popover toggle. Esc closes it. '/' focuses dropzone.
   'D' triggers download-all when in multi state. */
function toggleKbdHelp(){
  const pop = document.getElementById('kbdPopover');
  if (!pop) return;
  pop.classList.toggle('show');
}
window.toggleKbdHelp = toggleKbdHelp;
document.addEventListener('keydown', e => {
  /* Skip when the user is typing in an input/textarea or content-editable. */
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'Escape') {
    const pop = document.getElementById('kbdPopover');
    if (pop && pop.classList.contains('show')) { pop.classList.remove('show'); e.preventDefault(); return; }
    /* Also close confirm modal if open */
    if (document.body.dataset.confirm === 'open' && typeof cancelConfirm === 'function') {
      cancelConfirm(); e.preventDefault(); return;
    }
    /* Also close big-batch modal */
    if (document.body.dataset.bigbatch === 'open' && typeof cancelBigBatch === 'function') {
      cancelBigBatch(); e.preventDefault(); return;
    }
  }
  if (e.key === '/') {
    const dz = document.getElementById('dropzone');
    if (dz) { dz.focus(); e.preventDefault(); }
  }
  if ((e.key === 'd' || e.key === 'D') && document.body.dataset.state === 'multi') {
    if (typeof downloadAll === 'function') { downloadAll(); e.preventDefault(); }
  }
});
/* Footer link stubs: stable's app.js provides toggleTheme + openCmpSettings.
   Beta doesn't load app.js, so wire minimal versions so the footer links
   don't error out on click. Theme-toggle flips a class on body that the
   landing CSS can use to swap to dark; CMP settings shows a brief notice. */
window.toggleTheme = window.toggleTheme || function(){
  document.body.classList.toggle('dark-mode');
  const btn = document.getElementById('themeBtn');
  if (btn) btn.textContent = document.body.classList.contains('dark-mode') ? 'Day mode' : 'Night mode';
};
window.openCmpSettings = window.openCmpSettings || function(){};

/* Homepage before/after demo. Uses two REAL committed files and reports
   their real byte sizes — no runtime re-encoding (R117):
     before = /demo-panda.png  (lossless PNG original of the panda)
     after  = /demo.webp       (the imgready-compressed panda; same file
                                 used for the social/OG cards site-wide)
   Same panda on both sides; the saving is the real PNG->WebP size drop.
   Lives in the empty state only. Lightweight (no worker, no JSZip). */
(function initPandaDemo(){
  function start(){
    const slider = document.getElementById('demoSlider');
    const stats  = document.getElementById('demoStats');
    const loading= document.getElementById('demoLoading');
    const before = document.getElementById('demoBefore');
    const after  = document.getElementById('demoAfter');
    const clip   = document.getElementById('demoClip');
    const divider= document.getElementById('demoDivider');
    const handle = slider && slider.querySelector('.demo-handle');
    if (!slider || !before || !after) return;
    [divider, handle].forEach(el => { if (el) el.style.display = 'none'; });
    slider.querySelectorAll('.demo-lbl').forEach(el => el.style.display = 'none');
    function fmtSizeDemo(n){ return n < 1024 ? n + ' B' : n < 1024*1024 ? (n/1024).toFixed(1)+' KB' : (n/1024/1024).toFixed(2)+' MB'; }
    function setSplit(pct){
      pct = Math.max(0, Math.min(100, pct));
      if (clip) clip.style.clipPath = `inset(0 0 0 ${pct}%)`;
      if (divider) divider.style.left = pct + '%';
      if (handle) handle.style.left = pct + '%';
    }
    function wireDrag(){
      let dragging = false;
      const updatePos = e => {
        const r = slider.getBoundingClientRect();
        const x = (e.clientX != null ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0)) - r.left;
        setSplit(x / r.width * 100);
      };
      slider.addEventListener('pointerdown', e => {
        dragging = true; updatePos(e); e.preventDefault();
        try { slider.setPointerCapture && slider.setPointerCapture(e.pointerId); } catch(_){}
      });
      slider.addEventListener('pointermove', e => { if (dragging) updatePos(e); });
      slider.addEventListener('pointerup', () => dragging = false);
      slider.addEventListener('pointercancel', () => dragging = false);
    }
    /* Fetch the two real committed files and use their real byte sizes. */
    Promise.all([ fetch('/demo-panda.png'), fetch('/demo.webp') ])
      .then(rs => {
        if (!rs[0].ok || !rs[1].ok) throw new Error('demo assets missing');
        return Promise.all([ rs[0].blob(), rs[1].blob() ]);
      })
      .then(blobs => {
        const pngBlob = blobs[0], webpBlob = blobs[1];
        const origSize = pngBlob.size, afterSize = webpBlob.size;
        before.src = URL.createObjectURL(pngBlob);
        after.src  = URL.createObjectURL(webpBlob);
        const pct = origSize ? Math.round((1 - afterSize / origSize) * 100) : 0;
        if (stats) {
          stats.innerHTML =
            `<span class="demo-stat"><span class="label">Original PNG:</span><span class="value">${fmtSizeDemo(origSize)}</span></span>` +
            `<span class="demo-stat"><span class="label">imgready WebP:</span><span class="value">${fmtSizeDemo(afterSize)}</span></span>` +
            `<span class="demo-stat"><span class="saving">${pct}% smaller</span></span>`;
        }
        if (loading) loading.style.display = 'none';
        [divider, handle].forEach(el => { if (el) el.style.display = ''; });
        slider.querySelectorAll('.demo-lbl').forEach(el => el.style.display = '');
        setSplit(50);
        wireDrag();
      })
      .catch(() => { if (loading) loading.innerHTML = 'Demo unavailable'; });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

/* ============================================================
   EMPTY-STATE OUTPUT PRE-SELECTOR + QUERYSTRING + MICROCOPY +
   FORMAT DROPDOWN
   ============================================================
   1. Query string (?out=jpg) pre-selects an output format on load.
   2. Clicking a pill in the empty state stores the choice and
      activates the matching format pill in the workspace.
   3. Microcopy rotates between 3 use-case lines under the dropzone.
   4. Workspace format dropdown wires trigger / menu / mutex.
*/
window.PREFS = window.PREFS || { outFormat: null, outFormats: [] };  /* empty default — presetFormatFromInput sets on first drop */

/* Hamburger toggle for the legacy top-nav (mobile only — /app.css
   keeps the menu inline on desktop via display:contents). Closes on
   outside-click. Bound once globally. */
window.toggleNavMenu = function(){
  const menu = document.getElementById('navMenu');
  const btn  = document.getElementById('navHamburger');
  if (!menu || !btn) return;
  const open = menu.classList.toggle('open');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
};
if (!window._navMenuOutsideClick) {
  window._navMenuOutsideClick = true;
  document.addEventListener('click', e => {
    const menu = document.getElementById('navMenu');
    const btn  = document.getElementById('navHamburger');
    if (!menu || !btn || !menu.classList.contains('open')) return;
    if (e.target === btn || btn.contains(e.target)) return;
    if (menu.contains(e.target)) return;
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  });
}
(function initOutputPreselect(){
  /* Normalize: dedupe, ensure at least one format is active. Original
     ('auto') mutex applies only in single mode (handled by caller). */
  function normalize(formats){
    if (!Array.isArray(formats)) formats = [formats];
    formats = formats.filter(Boolean);
    if (!formats.length) return ['auto'];
    const seen = new Set();
    return formats.filter(f => seen.has(f) ? false : seen.add(f));
  }
  /* Multi state is user-controlled — only changes when the user
     explicitly toggles. setOutFormats() does NOT change Multi. */
  function setMultiOutMode(enabled){
    enabled = !!enabled;
    if (typeof MULTI_OUT !== 'undefined') MULTI_OUT.enabled = enabled;
    document.body.dataset.multiout = enabled ? 'on' : 'off';
    const cb = document.getElementById('multiOutToggle');
    if (cb && cb.checked !== enabled) cb.checked = enabled;
    /* Multi-output and "By size" can't coexist (single quality →
       multiple file sizes), so flipping multi ON snaps us back to
       "By quality" if the user was on By size. The CSS rule above
       prevents re-selecting By size while multi is on. */
    if (enabled && document.body.dataset.qualityBy === 'size') {
      if (typeof _setQualityByTab === 'function') _setQualityByTab('quality');
      if (typeof setQuality === 'function') setQuality(null, 'smart');
    }
  }
  window._setMultiOutMode = setMultiOutMode;
  /* setOutFormats — array-based source of truth. */
  function setOutFormats(formats, opts){
    formats = normalize(formats);
    window.PREFS.outFormats = formats;
    window.PREFS.outFormat = formats[0]; /* back-compat */
    /* Sync empty-state pills (multi-active possible) */
    document.querySelectorAll('#dzPills button').forEach(b => {
      b.classList.toggle('active', formats.includes(b.dataset.outFmt));
    });
    /* Sync workspace dropdown menu items */
    const wpills = document.querySelectorAll('#formatPills button[data-fmt]');
    wpills.forEach(b => b.classList.toggle('active', formats.includes(b.dataset.fmt)));
    /* Workspace trigger: single format -> show that label;
       multi -> show 'Multi' badge with count */
    const dd = document.querySelector('.format-dropdown');
    if (dd) dd.dataset.formatCurrent = formats[0]; /* always primary, never the literal 'multi' (broke encoder MIME lookup + inflight dedup) */
    const label = document.querySelector('.format-current-label');
    if (label) {
      if (formats.length === 1) {
        const matched = [...wpills].find(b => b.dataset.fmt === formats[0]);
        label.textContent = matched ? matched.textContent : formats[0].toUpperCase();
      } else {
        label.textContent = 'Multi (' + formats.length + ')';
      }
    }
    /* Note: Multi state is NOT touched here. Multi is user-controlled
       via setMultiOutMode(). Callers that should auto-enable Multi
       (empty-state pill click, querystring with >1 format) call
       setMultiOutMode(true) themselves. */
    if (!opts || !opts.silent) {
      if (typeof invalidateEncoded === 'function') invalidateEncoded();
    }
    if (typeof window._setQualityFormatSupport === 'function') {
      window._setQualityFormatSupport();
    }
  }
  /* Single-format wrapper for back-compat */
  function setOutFormat(fmt, opts){ setOutFormats([fmt], opts); }
  window._setOutFormat = setOutFormat;
  window._setOutFormats = setOutFormats;

  /* Auto-select format based on the dropped file's input MIME.
     - Single mode: replaces current selection with the matched format
     - Multi mode: adds the matched format if not already selected
     Called from addFilesFromList on every drop. */
  function presetFormatFromInput(file){
    if (!file) return;
    const matched = pickAutoFormat(file);  /* resolves heic/svg/etc */
    if (!matched) return;
    const current = (window.PREFS.outFormats || ['webp']).slice();
    const multi = (typeof MULTI_OUT !== 'undefined' && MULTI_OUT.enabled);
    if (multi) {
      if (current.includes(matched)) return;
      setOutFormats([...current, matched]);
    } else {
      if (current.length === 1 && current[0] === matched) return;
      setOutFormats([matched]);
    }
  }
  window._presetFormatFromInput = presetFormatFromInput;

  /* Smart quality heuristic — per-file. Returns 55..95.
     Inputs that are already heavily compressed get an aggressive
     quality drop so output is meaningfully smaller. Inputs that
     benefit from format conversion (JPG -> WebP/AVIF) get a bump
     since the format itself saves bytes. */
  const FMT_EFFICIENCY = { jpg: 0.5, png: 1.0, webp: 0.35, avif: 0.25, gif: 0.5, ico: 1.0 };
  /* Empirical bpp curves at quality Q for typical natural photos.
     Each entry maps q∈[50,95] → bpp (bytes/pixel) of the encoded
     output. Calibrated against jsquash/oxipng test runs across a
     small benchmark of mixed content (skin, sky, foliage, text). The
     numbers are within ~15% of measured output for q≥60 — close
     enough to drive a quality-vs-size tradeoff without doing real
     encode probes (which would be too slow for live preview). */
  /* Inverse of _predictBpp: given a desired KB ceiling, solve for the
     quality that hits it. Returns 50..95 floor/ceiling. Uses the same
     bpp curves as _predictBpp so target mode and Smart agree. */
  function _qualityFromTarget(file, fmt, targetKb, w, h){
    if (!w || !h || !file) return 75;
    const targetBpp = (targetKb * 1024) / (w * h);
    /* Format constants — must mirror _predictBpp below. */
    const K = { webp:0.55, avif:0.40, jpg:0.85, gif:1.20, png:0, ico:0 };
    const k = K[fmt] || 0.85;
    if (!k) return 95;  /* lossless format, quality is symbolic */
    /* _predictBpp = k * (q/100)^1.7  →  q = (bpp/k)^(1/1.7) * 100 */
    const ratio = Math.max(0, targetBpp / k);
    if (ratio <= 0) return 50;
    const q = Math.pow(ratio, 1/1.7) * 100;
    return Math.max(10, Math.min( /* R47: floor 50→10 */95, Math.round(q)));
  }
  function _predictBpp(quality, fmt){
    const qf = Math.pow(Math.max(0.4, quality / 100), 1.7);
    if (fmt === 'webp') return 0.55 * qf;
    if (fmt === 'avif') return 0.40 * qf;
    if (fmt === 'jpg')  return 0.85 * qf;
    if (fmt === 'gif')  return 1.20 * qf;
    if (fmt === 'png' || fmt === 'ico') return 0;  /* lossless, no bpp curve */
    return 0.85 * qf;
  }
  function suggestQuality(file, outFmt){
    if (!file) return 85;
    const inputFmt = pickAutoFormat(file);
    /* Find dims if known (set by syncMainImage's createImageBitmap call /
       libheif decode for HEIC inputs). */
    let w = 0, h = 0;
    if (typeof FILES !== 'undefined') {
      const entry = FILES.find(f => f && f.file === file);
      if (entry && entry.dims) { w = entry.dims.w; h = entry.dims.h; }
    }
    /* Baseline from bytes-per-pixel (or file size fallback). Higher
       bpp source = more headroom = can afford higher output quality. */
    let baseline;
    if (w && h) {
      const bpp = file.size / (w * h);
      if (bpp > 0.7)       baseline = 82;  /* fresh capture, lots of headroom */
      else if (bpp > 0.25) baseline = 75;  /* standard web JPG */
      else                 baseline = 62;  /* already-optimized, push harder */
    } else {
      if (file.size > 2 * 1024 * 1024) baseline = 82;
      else if (file.size > 500 * 1024) baseline = 75;
      else                              baseline = 62;
    }
    /* Format-conversion bonus: switching to a denser codec earns +Q.
       log scale: 2x efficiency = +6 quality. */
    const inEff = FMT_EFFICIENCY[inputFmt] || 0.5;
    const outFmtNorm = outFmt || 'webp';
    const outEff = FMT_EFFICIENCY[outFmtNorm] || 0.5;
    const bonus = inEff / outEff;
    const bump = bonus > 0 ? Math.round(Math.log2(bonus) * 6) : 0;
    let q = Math.max(50, Math.min(95, baseline + bump));
    /* ---------- Size-target tightening (2026-05) ----------
       Goal: ≥40% size reduction whenever possible while preserving
       max quality. If the bpp-baseline predicts output above 60% of
       input, ratchet quality down until predicted hits the target.
       Caps quality at a floor of 50 so visual loss stays bounded.
       Skipped for lossless formats (png/ico) where the slider is
       only meaningful as a switch-to-WebP preview. */
    if (w && h && outFmtNorm !== 'png' && outFmtNorm !== 'ico') {
      const targetBytes = file.size * 0.60;  /* 40% reduction */
      const px = w * h;
      for (let iter = 0; iter < 6; iter++) {
        const predicted = _predictBpp(q, outFmtNorm) * px;
        if (predicted <= targetBytes) break;
        const overshoot = predicted / targetBytes;
        /* Move ~25 units per 100% overshoot — converges in 2-3 iters
           on typical inputs. */
        const drop = Math.max(2, Math.round((overshoot - 1) * 25));
        const next = q - drop;
        if (next <= 50) { q = 50; break; }
        q = next;
      }
    }
    return q;
  }
  window._suggestQuality = suggestQuality;
  window._qualityFromTarget = _qualityFromTarget;
  window._predictBpp = _predictBpp;

  /* 1. Query string parse — comma-separated for multi: ?out=webp,avif
     R106: also accept ?fmt= as an alias, since landing-page hero CTAs
     use that name (e.g., /tiff-to-jpg/ links to /?fmt=jpg#dropzone).
     Previously the hint was silently dropped — users landed on WebP. */
  const VALID = ['auto','webp','avif','jpg','png','gif','ico'];
  const qs = new URLSearchParams(location.search);
  const qsOut = qs.get('out') || qs.get('fmt');
  if (qsOut) {
    const fmts = qsOut.toLowerCase().split(',')
      .map(f => f === 'jpeg' ? 'jpg' : f)
      .filter(f => VALID.includes(f));
    if (fmts.length) setOutFormats(fmts, { silent: true });
  }

  /* 2. Empty-state pill clicks — plain toggle behavior:
     - Click any format: toggle in the array
     - Keep at least one active (can't deselect the last)
     - Auto-enable Multi when result has 2+ formats (one-way; we never
       auto-DISABLE Multi based on count — that's a user decision) */
  /* Sample-image button handler — fetch the bundled image, wrap as
     a File, and feed through the normal addFilesFromList path. Gives
     users a no-friction way to see results without finding a file. */
  /* Load a sample by URL → File → addFilesFromList. Same flow as a
     real user drop — match-input format on output, Smart quality.
     The new sample sources are Unsplash raw (q=85) instead of picsum's
     pre-compressed versions, so there's enough headroom that even
     JPG→JPG re-encode shows meaningful savings. */
  async function loadSample(url, name, type){
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('fetch failed: ' + resp.status);
      const blob = await resp.blob();
      const file = new File([blob], name, { type });
      if (typeof addFilesFromList === 'function') addFilesFromList([file]);
    } catch (err) {
      console.warn('[samples] failed to load', url, err);
    }
  }
  /* Click → load. Selector matches floating cards. */
  document.addEventListener('click', async e => {
    const sampleBtn = e.target.closest && e.target.closest('.dz-float-card[data-sample]');
    if (sampleBtn) {
      e.preventDefault();
      loadSample(sampleBtn.dataset.sample,
                 sampleBtn.dataset.sampleName || 'sample.jpg',
                 sampleBtn.dataset.sampleType || 'image/jpeg');
    }
  });
  /* Drag-and-drop: card sets a custom MIME ("application/imgready-sample")
     that the dropzone\'s drop handler intercepts. Real File objects can\'t
     be put on a synthetic dragstart, so we pass the URL and load on drop. */
  document.addEventListener('dragstart', e => {
    const card = e.target.closest && e.target.closest('.dz-float-card[data-sample]');
    if (!card) return;
    card.classList.add('dragging');
    /* Light up the main dropzone so the user sees the drop target glow
       while dragging a sample card. Same .drag class the dropzone uses
       for real file drags. */
    const dz = document.getElementById('dropzone');
    if (dz) dz.classList.add('drag');
    try {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/imgready-sample',
        JSON.stringify({
          url: card.dataset.sample,
          name: card.dataset.sampleName,
          type: card.dataset.sampleType
        }));
    } catch(_){}
  });
  document.addEventListener('dragend', e => {
    const card = e.target.closest && e.target.closest('.dz-float-card');
    if (card) card.classList.remove('dragging');
    /* Clear the dropzone highlight whether the drop succeeded or not. */
    const dz = document.getElementById('dropzone');
    if (dz) dz.classList.remove('drag');
  });
  /* Dropzone listens for the custom MIME and routes to loadSample.
     Scoped to drops INSIDE the dropzone — if the user drags a card
     and releases anywhere else on the page, nothing happens. */
  function isInsideDropzone(target){
    const dz = document.getElementById('dropzone') ||
               document.querySelector('.dropzone, .image-canvas, body[data-state="multi"] .stage');
    return dz && target && dz.contains(target);
  }
  document.addEventListener('drop', e => {
    if (!e.dataTransfer) return;
    const payload = e.dataTransfer.getData('application/imgready-sample');
    if (!payload) return;
    /* CRITICAL: only fire when the drop target is within the dropzone.
       Without this, releasing the drag anywhere else still loaded the
       sample, which is the bug the user flagged. */
    if (!isInsideDropzone(e.target)) return;
    e.preventDefault();
    try {
      const { url, name, type } = JSON.parse(payload);
      loadSample(url, name, type);
    } catch(_){}
  }, true);
  /* dragover preventDefault on dropzone only — lets the browser show
     the "copy" cursor inside the zone, "no-drop" outside. */
  document.addEventListener('dragover', e => {
    if (!e.dataTransfer || !e.dataTransfer.types ||
        !e.dataTransfer.types.includes('application/imgready-sample')) return;
    if (isInsideDropzone(e.target)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, true);
  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('#dzPills button[data-out-fmt]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const clicked = btn.dataset.outFmt;
    const current = (window.PREFS.outFormats || ['auto']).slice();
    let next;
    if (current.includes(clicked)) {
      /* Allow unpicking ALL — empty array reverts to "match input on
         drop" via presetFormatFromInput. Previous version forbade the
         last unpick (legacy from when PREFS defaulted to ['webp']). */
      next = current.filter(f => f !== clicked);
    } else {
      next = [...current, clicked];
    }
    setOutFormats(next);
    /* Sync multi mode with selection count: 2+ → on, ≤1 → off.
       Previously only set ON, leaving multi stuck after user
       deselected back to a single format. */
    setMultiOutMode(next.length >= 2);
  });

  /* 3. Headline verb rotation — Bionic Julia pattern verbatim
     (https://bionicjulia.com/blog/creating-react-component-fades-changing-words),
     adapted to vanilla JS + per-word dwell.

     State machine:
       visible (.is-in) -> fade out -> swap text (invisible) -> fade in (.is-in) -> ...

     Toggle uses classList.replace so the new class brings its own
     transition rule (vs. single-class toggle which can fail to fire). */
  const loopWords = ['compressed.', 'converted.', 'resized.', 'optimized.', 'ready.'];
  /* Per-word dwell — visible time before the next fade-out. */
  const dwell = [1600, 1600, 1600, 1600, 3200];
  /* Must match the CSS .5s opacity transition. */
  const FADE_MS = 500;
  const loopEl = document.getElementById('dzLoop');
  if (loopEl) {
    let lIdx = 0;
    function fadeOut(){
      loopEl.classList.replace('is-in', 'is-out');
      setTimeout(fadeIn, FADE_MS);
    }
    function fadeIn(){
      /* Swap text while opacity is 0 — invisible to the user. */
      lIdx = (lIdx + 1) % loopWords.length;
      loopEl.textContent = loopWords[lIdx];
      loopEl.classList.replace('is-out', 'is-in');
      /* Wait the dwell for this word, then start the next fade-out. */
      setTimeout(fadeOut, dwell[lIdx]);
    }
    /* Start: word 0 is already visible (HTML has .is-in). After its
       dwell, begin the first fade-out. */
    setTimeout(fadeOut, dwell[0]);
  }

  /* 4. Workspace format dropdown — open/close + click options.
     Critical: must portal the menu to document.body on open. The menu
     lives inside .bb-drawer which has overflow:hidden for the slide
     animation, and even position:fixed gets clipped because something
     up the tree creates a containing block. Resize + crop dropdowns
     both do this; the format dropdown was the only one that didn't. */
  function portalFormatMenu(menu){
    if (menu.parentNode !== document.body) document.body.appendChild(menu);
  }
  function wireFormatDropdown(){
    const dd = document.querySelector('.format-dropdown');
    if (!dd || dd.dataset.fmtWired) return;
    dd.dataset.fmtWired = '1';
    const trig = dd.querySelector('[data-format-trigger]');
    const menu = dd.querySelector('.format-menu');
    if (!trig || !menu) return;
    trig.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = !dd.classList.contains('open');
      /* Mutex with resize / crop dropdowns */
      if (willOpen && typeof closeOtherPresetDropdowns === 'function') {
        closeOtherPresetDropdowns(dd);
      } else if (willOpen) {
        document.querySelectorAll('.resize-presets.open').forEach(p => {
          if (p !== dd) p.classList.remove('open');
        });
        document.querySelectorAll('.resize-presets-menu.open').forEach(m => {
          if (m !== menu) m.classList.remove('open');
        });
      }
      dd.classList.toggle('open');
      menu.classList.toggle('open', willOpen);
      if (willOpen) {
        portalFormatMenu(menu);
        const r = trig.getBoundingClientRect();
        const menuW = menu.offsetWidth || 120;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
        menu.style.left = left + 'px';
        menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        menu.style.top = 'auto';
      }
    });
    /* Click-anywhere-to-close: menu is portalled so outside-click logic
       must account for menu NOT being a descendant of dd. */
    menu.querySelectorAll('button[data-fmt]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const fmt = b.dataset.fmt;
        if (typeof MULTI_OUT !== 'undefined' && MULTI_OUT.enabled) {
          /* Multi mode: simple toggle in the outFormats array. No
             Original mutex — Original (auto) composes coherently with
             other formats. Keep at least one active. Menu stays open
             so user can pick more. */
          const current = (window.PREFS.outFormats || ['auto']).slice();
          let next;
          if (current.includes(fmt)) {
            next = current.filter(f => f !== fmt);
            if (!next.length) next = current;
          } else {
            next = [...current, fmt];
          }
          if (window._setOutFormats) window._setOutFormats(next);
          /* DON'T close the menu — let user keep selecting */
        } else {
          /* Single mode: replace selection and close menu */
          setOutFormat(fmt);
          dd.classList.remove('open');
          menu.classList.remove('open');
        }
      });
    });
    /* Multi-toggle row inside the menu — the row IS a <label>, so
       clicking anywhere on it natively toggles the contained
       checkbox (and fires the change event that
       attachSettingsListeners listens on). All we need is to stop
       propagation so the dropdown's outside-click handler doesn't
       close the menu when the user toggles Multi. */
    const multiRow = menu.querySelector('[data-multi-row]');
    if (multiRow) {
      multiRow.addEventListener('click', e => {
        e.stopPropagation();
      });
    }
  }
  /* 5. Quality dropdown — preset buttons + slider inside the menu. */
  function portalQualityMenu(menu){
    if (menu.parentNode !== document.body) document.body.appendChild(menu);
  }
  function setQualityFormatSupport(){
    /* Two responsibilities:
       a) Lossless preset visibility per current format (PNG always,
          WebP/AVIF/GIF can be lossless; JPG/ICO cannot).
       b) Whole-dropdown disable when NO active format reads quality
          (i.e. every selected format is in {png, ico}). Lets us
          show users why a quality slider change doesn't affect output.
       Quality-USING formats: jpg, webp, avif, gif.
         (gif: quality drives palette size + frame skip in the
         animated-gif pipeline. Static GIF input still passes through
         canvas.toBlob and quality is a no-op there — acceptable.)
       Quality-IGNORING: png (lossless), ico (PNG wrap). */
    const dd = document.querySelector('.quality-dropdown');
    if (!dd) return;
    const losslessBtn = document.querySelector('.quality-menu button[data-quality-preset="lossless"]'); /* R47: menu is portalled */
    const fmts = (window.PREFS && window.PREFS.outFormats) || ['webp'];
    /* (a) lossless-button visibility — uses primary format only */
    if (losslessBtn) {
      const primary = fmts[0];
      const trueLossless = ['png','webp','avif','gif'].includes(primary);
      losslessBtn.setAttribute('aria-disabled', trueLossless ? 'false' : 'true');
    }
    /* (b) whole-dropdown disable when no selected format uses quality */
    /* PNG was excluded because its compression is lossless and ignores
       the quality slider. But disabling the dropdown is more confusing
       than helpful — users hit a wall, not an explanation. Including
       'png' keeps the slider interactive for visibility (smart-quality
       still computes a meaningful target for format-conversion preview
       e.g. if the user switches output to WebP). */
    const QUALITY_USING = ['jpg', 'webp', 'avif', 'gif', 'png'];
    const anyUsesQuality = fmts.some(f => QUALITY_USING.includes(f));
    dd.dataset.qualityApplicable = anyUsesQuality ? 'on' : 'off';
    const trig = dd.querySelector('.resize-presets-trigger');
    if (trig) {
      trig.title = anyUsesQuality
        ? ''
        : 'Quality doesn\u2019t apply to this format (it\u2019s lossless)';
    }
  }
  function setQualityTarget(targetKb, opts){
    /* Target-size mode: stash KB target on data-quality-target; flip
       the wrapper into the size body via data-quality-by; toggle the
       header switch ON. getActiveSettings reads quality-target back
       on every encode. */
    const dd = document.querySelector('.quality-dropdown');
    if (!dd) return;
    const tkb = Math.max(1, parseInt(targetKb, 10) || 0);
    if (!tkb) return;
    dd.dataset.qualityMode = 'target';
    dd.dataset.qualityTarget = String(tkb);
    /* Sync the tabs (in case setQualityTarget was called programmatically). */
    if (typeof _setQualityByTab === 'function') _setQualityByTab('size');
    /* Deactivate quality-preset buttons (they live in the other body). */
    document.querySelectorAll('.quality-menu button[data-quality-preset]').forEach(b => b.classList.remove('active'));
    const label = dd.querySelector('.quality-current-label');
    if (label) {
      const display = tkb >= 1024 ? `${(tkb/1024).toFixed(tkb % 1024 ? 1 : 0)} MB` : `${tkb} KB`;
      label.innerHTML = `Target &middot; ${display}`;
    }
    if (!opts || !opts.silent) {
      if (typeof invalidateEncoded === 'function') {
        document.body.dataset.qualityEncoding = 'on';
        invalidateEncoded();
      }
    }
  }
  window._setQualityTarget = setQualityTarget;
  function setQuality(value, presetKey, opts){
    const dd = document.querySelector('.quality-dropdown');
    if (!dd) return;
    /* Smart preset: no fixed value — flip mode + label, leave the
       dropdown's data-quality-current alone (acts as cached numeric
       for the fall-through if Smart can't compute). */
    /* If user picked any quality preset, reflect "By quality" tab. */
    if (presetKey && presetKey !== 'target') {
      if (typeof _setQualityByTab === 'function') _setQualityByTab('quality');
    }
    if (presetKey === 'smart') {
      dd.dataset.qualityMode = 'smart';
      const label = dd.querySelector('.quality-current-label');
      if (label) label.textContent = 'Smart';
      document.querySelectorAll('.quality-menu button[data-quality-preset]').forEach(b => {
        b.classList.toggle('active', b.dataset.qualityPreset === 'smart');
      });
      if (!opts || !opts.silent) {
        if (typeof invalidateEncoded === 'function') {
          document.body.dataset.qualityEncoding = 'on';
          invalidateEncoded();
        }
      }
      if (typeof window._setQualityFormatSupport === 'function') {
        window._setQualityFormatSupport();
      }
      return;
    }
    const v = parseInt(value, 10);
    if (!isFinite(v)) return;
    dd.dataset.qualityCurrent = String(v);
    if (presetKey) dd.dataset.qualityMode = presetKey;
    /* Trigger label: preset name only (drop · NN per user — the actual
       value is exposed via the slider position inside the menu). Custom
       mode keeps · NN since the name doesn't carry information. */
    const label = dd.querySelector('.quality-current-label');
    if (label) {
      const presetMap = { lossless: 'Lossless', best: 'Best', high: 'High', medium: 'Standard', low: 'Compact' };
      if (presetKey && presetMap[presetKey]) {
        label.textContent = presetMap[presetKey];
      } else {
        label.innerHTML = `Custom &middot; ${v}`;
      }
    }
    /* Preset-button active states. After portaling the menu lives at
       document.body, so query by class rather than via dd. */
    document.querySelectorAll('.quality-menu button[data-quality-preset]').forEach(b => {
      b.classList.toggle('active', presetKey ? b.dataset.qualityPreset === presetKey : false);
    });
    /* Sync the slider + readout. Critical: the menu is portalled to body
       on open, so dd.querySelector returns null here. Query the portalled
       menu directly. The slider also drives the .q-val readout next to it
       and the --p CSS var that paints the track gradient. */
    const menuEl = document.querySelector('.quality-menu');
    const slider = menuEl && menuEl.querySelector('input[type=range]');
    const valSpan = menuEl && menuEl.querySelector('.q-val');
    if (slider) {
      slider.value = String(v);
      slider.style.setProperty('--p', String(v));
    }
    if (valSpan) valSpan.textContent = String(v);
    if (!opts || !opts.silent) {
      if (typeof invalidateEncoded === 'function') {
        document.body.dataset.qualityEncoding = 'on';
        invalidateEncoded();
      }
    }
  }
  window._setQuality = setQuality;
  window._setQualityFormatSupport = setQualityFormatSupport;
  function _setQualityByTab(which){
    /* Reflect axis state on body[data-quality-by] so the portalled
       menu's body-swap CSS works, plus the tab active class for
       the visible UI. Also kept on the dropdown wrapper for any
       legacy reader that still queries it. */
    document.body.dataset.qualityBy = which;
    document.querySelectorAll('.quality-by-tab').forEach(t => {
      const on = t.dataset.qualityByPick === which;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const dd = document.querySelector('.quality-dropdown');
    if (dd) dd.dataset.qualityBy = which;
  }
  function wireQualityByToggle(){
    /* Idempotent. Owns: tab clicks, size-preset clicks, custom-KB
       Apply button, Enter-in-input. One delegated click + one
       keydown listener. */
    if (window._qbToggleWired) return;
    window._qbToggleWired = true;
    document.addEventListener('click', (e) => {
      /* Tab click — radio-style axis selection. */
      const tab = e.target && e.target.closest && e.target.closest('.quality-by-tab');
      if (tab) {
        const which = tab.dataset.qualityByPick;
        /* Block By size selection while multi-output is on. The CSS
           already does pointer-events:none, but a defensive guard
           here covers programmatic / keyboard / AT-driven clicks. */
        if (which === 'size' && document.body.dataset.multiout === 'on') {
          return;
        }
        _setQualityByTab(which);
        if (which === 'size') {
          const dd = document.querySelector('.quality-dropdown');
          const last = (dd && parseInt(dd.dataset.qualityTarget, 10)) || 100;
          const inp = document.getElementById('qualityTargetInput');
          if (inp && !inp.value) inp.value = String(last);
          document.querySelectorAll('.quality-menu button[data-size-target]').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.sizeTarget,10) === last);
          });
          if (typeof setQualityTarget === 'function') setQualityTarget(last);
        } else {
          /* Back to By quality — fall to Smart. */
          if (typeof setQuality === 'function') setQuality(null, 'smart');
        }
        return;
      }
      /* Size-preset clicks: 100 KB / 500 KB / 1 MB / 2 MB.
         Match the quality-preset behavior: commit + close. */
      const sizeBtn = e.target && e.target.closest && e.target.closest('.quality-menu button[data-size-target]');
      if (sizeBtn) {
        const kb = parseInt(sizeBtn.dataset.sizeTarget, 10);
        if (kb > 0) {
          document.querySelectorAll('.quality-menu button[data-size-target]').forEach(b => {
            b.classList.toggle('active', b === sizeBtn);
          });
          const inp = document.getElementById('qualityTargetInput');
          if (inp) inp.value = String(kb);
          setQualityTarget(kb);
          _closeQualityMenu();
        }
        return;
      }
      /* Custom-KB Apply button — same commit-and-close pattern. */
      const applyBtn = e.target && e.target.closest && e.target.closest('#qualityTargetApply');
      if (applyBtn) {
        const inp = document.getElementById('qualityTargetInput');
        const kb = inp ? parseInt(inp.value, 10) : 0;
        if (kb > 0) {
          document.querySelectorAll('.quality-menu button[data-size-target]').forEach(b => b.classList.remove('active'));
          setQualityTarget(kb);
          _closeQualityMenu();
        }
        return;
      }
    });
    /* Enter inside the custom KB input applies it AND closes the menu,
       matching the click-Apply behavior. */
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (!e.target || e.target.id !== 'qualityTargetInput') return;
      const kb = parseInt(e.target.value, 10);
      if (kb > 0) {
        document.querySelectorAll('.quality-menu button[data-size-target]').forEach(b => {
          b.classList.toggle('active', parseInt(b.dataset.sizeTarget,10) === kb);
        });
        setQualityTarget(kb);
        _closeQualityMenu();
      }
    });
  }
  function _closeQualityMenu(){
    /* Helper because the menu's portalled to body — both the wrapper's
       and the menu's own .open class need clearing. */
    const dd = document.querySelector('.quality-dropdown');
    const menu = document.querySelector('.quality-menu');
    if (dd) dd.classList.remove('open');
    if (menu) menu.classList.remove('open');
  }
  wireQualityByToggle();
  function wireQualityDropdown(){
    const dd = document.querySelector('.quality-dropdown');
    if (!dd || dd.dataset.qdWired) return;
    dd.dataset.qdWired = '1';
    const trig = dd.querySelector('[data-quality-trigger]');
    const menu = dd.querySelector('.quality-menu');
    if (!trig || !menu) return;
    trig.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = !dd.classList.contains('open');
      if (willOpen && typeof closeOtherPresetDropdowns === 'function') {
        closeOtherPresetDropdowns(dd);
      } else if (willOpen) {
        document.querySelectorAll('.resize-presets.open').forEach(p => {
          if (p !== dd) p.classList.remove('open');
        });
        document.querySelectorAll('.resize-presets-menu.open').forEach(m => {
          if (m !== menu) m.classList.remove('open');
        });
      }
      dd.classList.toggle('open');
      menu.classList.toggle('open', willOpen);
      if (willOpen) {
        portalQualityMenu(menu);
        const r = trig.getBoundingClientRect();
        const menuW = menu.offsetWidth || 180;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
        menu.style.left = left + 'px';
        menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        menu.style.top = 'auto';
        setQualityFormatSupport();
      }
    });
    /* Preset clicks */
    menu.querySelectorAll('button[data-quality-preset]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (b.getAttribute('aria-disabled') === 'true') return;
        const preset = b.dataset.qualityPreset;
        const q = parseInt(b.dataset.q, 10);
        setQuality(q, preset);
        dd.classList.remove('open');
        menu.classList.remove('open');
      });
    });
    /* Slider — live label update on input, commit (re-encode) on change.
       Clicking inside the slider row should NOT close the menu. */
    const sliderRow = menu.querySelector('.quality-custom-row');
    const slider = sliderRow && sliderRow.querySelector('input[type=range]');
    const valSpan = sliderRow && sliderRow.querySelector('.q-val');
    if (sliderRow) sliderRow.addEventListener('click', e => e.stopPropagation());
    if (slider) {
      slider.style.setProperty('--p', slider.value);
      slider.addEventListener('input', e => {
        e.stopPropagation();
        const v = parseInt(slider.value, 10);
        slider.style.setProperty('--p', String(v));
        if (valSpan) valSpan.textContent = String(v);
        /* Update the trigger label live to "Custom · NN" so the user
           sees feedback before they release the slider. */
        const label = dd.querySelector('.quality-current-label');
        if (label) label.innerHTML = `Custom &middot; ${v}`;
        dd.dataset.qualityCurrent = String(v);
        dd.dataset.qualityMode = 'custom';
        /* Deactivate preset buttons since we're in custom mode now. */
        dd.querySelectorAll('button[data-quality-preset]').forEach(b => b.classList.remove('active'));
      });
      slider.addEventListener('change', e => {
        e.stopPropagation();
        if (typeof invalidateEncoded === 'function') {
          document.body.dataset.qualityEncoding = 'on';
          invalidateEncoded();
        }
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wireFormatDropdown(); wireQualityDropdown(); });
  } else {
    wireFormatDropdown();
    wireQualityDropdown();
  }
})();

/* Mobile info-card tap-to-expand. compare-meta's pointer-events are
   `none` on desktop so they don't intercept slider drags. On mobile we
   override to `auto` (in CSS) and toggle .expanded on tap. The handler
   no-ops above 767px so desktop is unaffected. */
(function wireMobileMetaToggle(){
  document.addEventListener('click', e => {
    if (window.innerWidth > 767) return;
    const card = e.target.closest && e.target.closest('.compare-meta');
    if (!card) return;
    const stage = card.closest('.stage');
    if (!stage || getComputedStyle(stage).display === 'none') return;
    card.classList.toggle('expanded');
    e.stopPropagation();
  }, true);
})();
async function ensureAllEncoded(){
  /* In Multi mode, ensure every active format is encoded for every
     file (populates ENCODE.allEncoded which the zip builder reads).
     In single mode, just ensure the primary blob exists. */
  const multi = (typeof MULTI_OUT !== 'undefined' && MULTI_OUT.enabled);
  const activeFmts = multi ? getActiveFormats() : null;
  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i];
    if (!f) continue;
    if (multi) {
      /* Ensure every active format has been encoded for this file. */
      const existing = ENCODE.allEncoded.get(i) || new Map();
      for (const fmt of activeFmts) {
        /* Real fmt accounts for 'auto' which the encoder resolves to
           the input MIME via pickAutoFormat. Use that resolved key
           when checking the bundle so we don't double-encode. */
        const realFmt = fmt === 'auto' ? pickAutoFormat(f.file) : fmt;
        if (existing.has(realFmt)) continue;
        try {
          const blob = await encodeFile(i, fmt);
          const url = URL.createObjectURL(blob);
          const fmtFromMime = mimeToFmt(blob.type);
          existing.set(fmtFromMime, { blob, url, size: blob.size, format: fmtFromMime });
        } catch(e){ console.warn('multi encode failed for', i, fmt, e); }
      }
      ENCODE.allEncoded.set(i, existing);
      /* Mirror the primary into ENCODE.encoded if not already set so
         single-format callers (the per-file download fallback) still
         work. Pick the first active format as primary. */
      if (!ENCODE.encoded.has(i) && existing.size) {
        const primaryFmt = activeFmts[0] === 'auto' ? pickAutoFormat(f.file) : activeFmts[0];
        const primary = existing.get(primaryFmt) || existing.values().next().value;
        if (primary) ENCODE.encoded.set(i, primary);
      }
    } else {
      /* Single mode: ensure primary exists. */
      if (ENCODE.encoded.has(i)) continue;
      try {
        const blob = await encodeFile(i);
        const url = URL.createObjectURL(blob);
        ENCODE.encoded.set(i, { blob, url, size: blob.size, format: mimeToFmt(blob.type) });
      } catch(e){ console.warn('encode failed for', i, e); }
    }
  }
}
async function downloadAll(){
  await ensureAllEncoded();
  /* Multi-output: bundle every (file × format) combination into a single
     zip via JSZip. Without this, users with multi-output enabled would
     only get the PRIMARY format per file — the other formats they
     selected would be invisible at the global download. */
  if (MULTI_OUT.enabled) {
    const JSZipMod = window.JSZip || (await loadJSZip());
    if (JSZipMod) {
      const zip = new JSZipMod();
      let added = 0;
      for (let i = 0; i < FILES.length; i++) {
        const f = FILES[i];
        const bundle = ENCODE.allEncoded.get(i);
        if (!f || !bundle || !bundle.size) continue;
        const base = f.file.name.replace(/\.[^.]+$/, '');
        bundle.forEach(e => {
          if (e && e.blob) { zip.file(`${base}_imgready.${e.format}`, e.blob); added++; }
        });
      }
      if (added > 0) {
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0,10);
        triggerDownload(url, `imgready-${stamp}.zip`);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return;
      }
    }
    /* JSZip unavailable — fall through to per-file individual downloads. */
  }
  /* Single-format path: when batch has 2+ files, zip everything into
     one download so the browser doesn't stagger N save dialogs. Single
     file keeps the legacy direct-download UX. */
  let realCount = 0;
  for (let i = 0; i < FILES.length; i++) {
    if (FILES[i] && ENCODE.encoded.get(i)) realCount++;
  }
  if (realCount > 1) {
    const JSZipMod = window.JSZip || (await loadJSZip());
    if (JSZipMod) {
      const zip = new JSZipMod();
      let added = 0;
      for (let i = 0; i < FILES.length; i++) {
        const f = FILES[i]; const enc = ENCODE.encoded.get(i);
        if (!f || !enc) continue;
        const base = f.file.name.replace(/\.[^.]+$/, '');
        zip.file(`${base}_imgready.${enc.format}`, enc.blob);
        added++;
      }
      if (added > 0) {
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().slice(0,10);
        triggerDownload(url, `imgready-${stamp}.zip`);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        return;
      }
    }
    /* JSZip unavailable — fall through to per-file individual downloads. */
  }
  /* Single file (or zip path unavailable): individual download(s). */
  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i]; const enc = ENCODE.encoded.get(i);
    if (!f || !enc) continue;
    const base = f.file.name.replace(/\.[^.]+$/, '');
    triggerDownload(enc.url, `${base}_imgready.${enc.format}`);
    /* Stagger so browsers don't throttle simultaneous downloads */
    await new Promise(r => setTimeout(r, 80));
  }
}
async function shareAll(){
  await ensureAllEncoded();
  const files = [];
  for (let i = 0; i < FILES.length; i++) {
    const f = FILES[i]; const enc = ENCODE.encoded.get(i);
    if (!f || !enc) continue;
    const base = f.file.name.replace(/\.[^.]+$/, '');
    files.push(new File([enc.blob], `${base}_imgready.${enc.format}`, { type: enc.blob.type }));
  }
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title: 'imgready' }); } catch(_){}
  } else {
    /* Fallback: trigger downloads (Web Share unavailable) */
    for (const f of files) triggerDownload(URL.createObjectURL(f), f.name);
  }
}

/* Wire settings changes so the focused image re-encodes when user adjusts */
function attachSettingsListeners(){
  const root = document.querySelector('.stage.multi .menu-card');
  if (!root) return;
  /* Pill click handlers — single vs multi behavior depends on context:
     - .crop-pills: always single-select
     - #formatPills + multi-output OFF: single-select (same as before)
     - #formatPills + multi-output ON: toggle (multi-active) */
  root.querySelectorAll('.adjust-pills button').forEach(btn => {
    btn.addEventListener('click', () => {
      const parent = btn.parentElement;
      const isFormatPills = parent.id === 'formatPills';
      if (isFormatPills && MULTI_OUT.enabled) {
        /* Multi-output: toggle THIS button only, but make sure at least
           one stays active (a no-formats state would mean "encode nothing"). */
        const wasActive = btn.classList.contains('active');
        if (wasActive) {
          const remaining = parent.querySelectorAll('button.active').length;
          if (remaining > 1) btn.classList.remove('active');
        } else {
          /* Auto pill is hidden in multi-mode but if user clicks it via
             keyboard, treat as "deselect all + activate Auto" (= single
             mode). Simpler: just no-op the auto pill in multi-mode. */
          if (btn.dataset.fmt === 'auto') return;
          btn.classList.add('active');
        }
      } else {
        /* Single-select (default for crop and for format-without-multi) */
        parent.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
      invalidateEncoded();
    });
  });
  /* Multi-output toggle. Preserves the current format selection on
     toggle ON (including Original); on OFF, reduces to the first
     active format (single mode). */
  const multiToggle = root.querySelector('#multiOutToggle');
  if (multiToggle) {
    multiToggle.addEventListener('change', () => {
      const enabled = multiToggle.checked;
      MULTI_OUT.enabled = enabled;
      document.body.dataset.multiout = enabled ? 'on' : 'off';
      if (!enabled) {
        /* Turning OFF: reduce outFormats to the first active format
           so single mode has one and only one active pill. */
        const current = window.PREFS.outFormats || ['auto'];
        if (current.length > 1 && window._setOutFormats) {
          window._setOutFormats([current[0]], { silent: true });
        }
      }
      /* Turning ON: keep the current selection as-is. Empty-state
         users who pre-selected one format see it stay active as the
         single checked item, and can add more from there. */
      invalidateEncoded();
    });
  }
  /* Quality slider — re-encode on release (input is too chatty) */
  const qSlider = root.querySelector('.quality-row input[type=range]');
  if (qSlider) {
    /* Sync the --p custom property with the slider's current value so
       the hand-styled track gradient knows where to stop. Initialize
       once on attach, then update on every input event. */
    qSlider.style.setProperty('--p', qSlider.value);
    qSlider.addEventListener('input', () => {
      const v = parseInt(qSlider.value);
      qSlider.style.setProperty('--p', v);
      const lbl = root.querySelector('.quality-row + .adjust-hint, .adjust-section .adjust-label');
      const valSpan = root.querySelector('.q-val'); if (valSpan) valSpan.textContent = String(v);
      const labelEl = root.querySelector('.adjust-section .adjust-label');
      /* Update label from "Quality · 82" → "Quality · NN" */
      root.querySelectorAll('.adjust-label').forEach(el => {
        if (el.textContent.startsWith('Quality')) el.textContent = `Quality · ${v}`;
      });
    });
    qSlider.addEventListener('change', () => {
      /* Mark this re-encode as quality-driven so the qr-spinner shows
         next to the slider (and only here, not on format/resize). */
      document.body.dataset.qualityEncoding = 'on';
      invalidateEncoded();
    });
  }
  /* Mutex helper for the resize/crop preset dropdowns. Called from each
     trigger's click handler before opening, so only one popover is ever
     visible at a time. Handles portalled menus by class-matching:
       - keep is the dropdown we're about to open
       - any OTHER .resize-presets.open gets .open removed
       - any portalled menu whose flavor (crop vs resize) doesn't match
         keep also gets .open removed. */
  function closeOtherPresetDropdowns(keep){
    document.querySelectorAll('.resize-presets.open').forEach(p => {
      if (p !== keep) p.classList.remove('open');
    });
    /* Map each dropdown class to the class of the menu it owns. Portalled
       menus aren't descendants of their dropdown wrapper anymore, so DOM
       containment can't be used — match by class instead. The old code
       only distinguished crop-vs-non-crop, so opening Format/Quality/
       Resize while another non-crop dropdown was open left the other one
       visible. */
    const DD_TO_MENU = {
      'format-dropdown':  'format-menu',
      'quality-dropdown': 'quality-menu',
      'resize-dropdown':  'resize-menu',
      'crop-dropdown':    'crop-menu',
    };
    let keepMenuClass = null;
    if (keep) {
      for (const ddCls in DD_TO_MENU) {
        if (keep.classList.contains(ddCls)) { keepMenuClass = DD_TO_MENU[ddCls]; break; }
      }
    }
    document.querySelectorAll('.resize-presets-menu.open').forEach(m => {
      if (!keep) { m.classList.remove('open'); return; }
      if (!keepMenuClass || !m.classList.contains(keepMenuClass)) {
        m.classList.remove('open');
      }
    });
  }
  /* Resize dropdown — single control with presets + inline custom input.
     Pattern: trigger button shows current value (or "None"), menu opens
     upward with preset rows + a custom-input row at the bottom.
     Selecting None / 1080 / 1920 / 4096 sets data-resize-current and
     re-encodes immediately. Custom row commits on Enter or Set click.
     Replaces the old "input + presets dropdown" two-control pattern. */
  const resizeDropdown = root.querySelector('.resize-dropdown');
  if (resizeDropdown) {
    const trig = resizeDropdown.querySelector('.resize-presets-trigger');
    const menu = resizeDropdown.querySelector('.resize-menu');
    const labelEl = resizeDropdown.querySelector('.resize-current-label');
    const customInp = resizeDropdown.querySelector('.resize-custom-input');
    const customSetBtn = resizeDropdown.querySelector('.resize-custom-set');

    function commitResize(value, label){
      resizeDropdown.dataset.resizeCurrent = String(value || 0);
      if (labelEl) labelEl.textContent = label;
      menu.querySelectorAll('button[data-resize]').forEach(b => {
        b.classList.toggle('active', String(b.dataset.resize) === String(value));
      });
      resizeDropdown.classList.remove('open');
      menu.classList.remove('open');
      invalidateEncoded();
    }

    function portalResizeMenu(){
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
    }

    trig.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = !resizeDropdown.classList.contains('open');
      /* Mutex: only one preset dropdown open at a time. Close any open
         crop dropdown (and its portalled menu) before opening resize. */
      if (willOpen) closeOtherPresetDropdowns(resizeDropdown);
      resizeDropdown.classList.toggle('open');
      menu.classList.toggle('open', willOpen);
      if (willOpen) {
        portalResizeMenu();
        const r = trig.getBoundingClientRect();
        /* Left-align menu's left edge with the trigger's left edge,
           then right-clamp so a near-right-edge trigger doesn't push
           the menu off-screen. 8px viewport gutter on either side. */
        const menuW = menu.offsetWidth || 100;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
        menu.style.left = left + 'px';
        menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        menu.style.top = 'auto';
      }
    });

    /* Preset row clicks */
    menu.querySelectorAll('button[data-resize]').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const v = parseInt(b.dataset.resize, 10) || 0;
        commitResize(v, b.textContent);
      });
    });

    /* Custom-input row — clicks inside don't close the menu; commit on
       Enter or Set click. */
    if (customInp) {
      [customInp, customSetBtn].forEach(el => {
        if (el) el.addEventListener('click', e => e.stopPropagation());
      });
      customInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = parseInt(customInp.value, 10);
          if (v > 0) commitResize(v, v + ' px');
        }
      });
      if (customSetBtn) {
        customSetBtn.addEventListener('click', e => {
          e.stopPropagation();
          const v = parseInt(customInp.value, 10);
          if (v > 0) commitResize(v, v + ' px');
        });
      }
    }
  }
  /* Crop dropdown — same open/close pattern as resize-presets. Portals
     the menu to document.body on open because .menu-card has
     backdrop-filter:blur, which creates a containing block + stacking
     context for position:fixed descendants. Without portalling, the menu
     gets anchored to .menu-card (not the viewport) and stacks below
     siblings like .cover-flow (z:6), making it invisible. */
  const cropDropdown = root.querySelector('.crop-dropdown');
  if (cropDropdown) {
    const trig = cropDropdown.querySelector('.resize-presets-trigger');
    const menu = cropDropdown.querySelector('.crop-menu');
    const labelEl = cropDropdown.querySelector('.crop-current-label');
    function portalCropMenu(){
      if (menu.parentNode !== document.body) document.body.appendChild(menu);
    }
    trig.addEventListener('click', e => {
      e.stopPropagation();
      const willOpen = !cropDropdown.classList.contains('open');
      /* Mutex: only one preset dropdown open at a time. Close any open
         resize dropdown (and its portalled menu) before opening crop. */
      if (willOpen) closeOtherPresetDropdowns(cropDropdown);
      cropDropdown.classList.toggle('open');
      menu.classList.toggle('open', willOpen);
      if (willOpen) {
        portalCropMenu();
        const r = trig.getBoundingClientRect();
        /* Left-align menu's left edge with the trigger's left edge,
           then right-clamp so a near-right-edge trigger doesn't push
           the menu off-screen. 8px viewport gutter on either side. */
        const menuW = menu.offsetWidth || 100;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
        menu.style.left = left + 'px';
        menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
        menu.style.top = 'auto';
      }
    });
    menu.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation();
        const val = b.dataset.crop;
        cropDropdown.dataset.cropCurrent = val;
        if (labelEl) labelEl.textContent = b.textContent;
        menu.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        cropDropdown.classList.remove('open');
        menu.classList.remove('open');
        invalidateEncoded();
      });
    });
  }
  /* Close presets/crop dropdowns when clicking outside. Bound once globally. */
  if (!window._presetsOutsideClick) {
    window._presetsOutsideClick = true;
    document.addEventListener('click', e => {
      document.querySelectorAll('.resize-presets.open').forEach(p => {
        if (!p.contains(e.target)) {
          p.classList.remove('open');
          const m = document.querySelector('.resize-presets-menu.open');
          if (m && !m.contains(e.target)) m.classList.remove('open');
        }
      });
    });
    /* Esc closes any open preset dropdown (Format / Quality / Resize /
       Crop). Mirrors the navMenu/kbShortcuts pattern. */
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const anyOpen = document.querySelector('.resize-presets.open, .resize-presets-menu.open');
      if (!anyOpen) return;
      document.querySelectorAll('.resize-presets.open').forEach(p => p.classList.remove('open'));
      document.querySelectorAll('.resize-presets-menu.open').forEach(m => m.classList.remove('open'));
      e.preventDefault();
    });
  }
  /* (Old mode-toggle + initial sync removed — single dropdown handles state) */
  /* Privacy switch (was checkbox) */
  const stripCb = root.querySelector('.switch input[type=checkbox]');
  if (stripCb) stripCb.addEventListener('change', invalidateEncoded);
}
window.addEventListener('DOMContentLoaded', attachSettingsListeners);

/* ============================================================
   PROD: Big-batch confirm modal — wraps addFilesFromList for >200 file drops
   ============================================================ */
let _pendingBigBatch = null;
function maybeBigBatchConfirm(files){
  if (!files || files.length <= 200) return Promise.resolve(files);
  return new Promise(resolve => {
    _pendingBigBatch = { files, resolve };
    document.getElementById('bigBatchCount').textContent = files.length;
    document.body.dataset.bigbatch = 'open';
  });
}
window.acceptBigBatch = function(){
  document.body.dataset.bigbatch = 'closed';
  if (_pendingBigBatch) { _pendingBigBatch.resolve(_pendingBigBatch.files); _pendingBigBatch = null; }
};
window.cancelBigBatch = function(){
  document.body.dataset.bigbatch = 'closed';
  if (_pendingBigBatch) { _pendingBigBatch.resolve([]); _pendingBigBatch = null; }
};

/* ============================================================
   PROD: Ctrl+V paste from clipboard
   ============================================================ */
document.addEventListener('paste', async e => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== 'file') continue;
    const f = items[i].getAsFile();
    if (f && f.type.startsWith('image/')) files.push(f);
  }
  if (files.length && typeof addFilesFromList === 'function') {
    e.preventDefault();
    const accepted = await maybeBigBatchConfirm(files);
    if (accepted.length) addFilesFromList(accepted);
  }
});

/* ============================================================
   PROD: Full-window drop overlay — drop ANYWHERE on the page
   ============================================================ */
let _wdo = null, _wddepth = 0;
function _ensureWDO(){
  if (_wdo) return _wdo;
  _wdo = document.createElement('div');
  _wdo.className = 'window-drop-overlay';
  _wdo.setAttribute('aria-hidden', 'true');
  _wdo.innerHTML = '<div class="wd-card">' +
    '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
    '<div class="wd-title">Drop anywhere</div>' +
    '<div class="wd-sub">Stays on your device — never uploaded</div>' +
  '</div>';
  document.body.appendChild(_wdo);
  return _wdo;
}
function _hideWDO(){
  _wddepth = 0;
  if (_wdo) _wdo.classList.remove('show');
  document.body.classList.remove('window-dragging');
}
document.addEventListener('dragenter', e => {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return;
  const hasFiles = (typeof types.indexOf === 'function')
    ? types.indexOf('Files') !== -1
    : types.contains && types.contains('Files');
  if (!hasFiles) return;
  _wddepth++;
  if (_wddepth === 1) {
    document.body.classList.add('window-dragging');
    _ensureWDO().classList.add('show');
  }
});
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('dragleave', () => {
  if (_wddepth > 0) {
    _wddepth--;
    if (_wddepth === 0) _hideWDO();
  }
});
document.addEventListener('drop', async e => {
  e.preventDefault();
  _hideWDO();
  const dt = e.dataTransfer;
  const list = dt && dt.files;
  if (!list || !list.length) return;
  const accepted = await maybeBigBatchConfirm(Array.from(list));
  if (accepted.length && typeof addFilesFromList === 'function') {
    addFilesFromList(accepted);
  }
});

/* ============================================================
   PROD: Web Share Target pickup — when a mobile user shares files INTO
   imgready, the SW intercepts and queues them, redirecting with
   ?share-pending=1. We dequeue via MessageChannel.
   ============================================================ */
(function pickupSharedFiles(){
  try {
    const params = new URLSearchParams(location.search);
    if (!params.get('share-pending')) return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(reg => {
      const sw = reg.active || navigator.serviceWorker.controller;
      if (!sw) return;
      const ch = new MessageChannel();
      ch.port1.onmessage = ev => {
        const files = (ev.data && ev.data.files) || [];
        if (files.length && typeof addFilesFromList === 'function') {
          addFilesFromList(files);
        }
        try {
          const u = new URL(location.href);
          u.searchParams.delete('share-pending');
          history.replaceState(null, '', u.pathname + (u.search || '') + (u.hash || ''));
        } catch(_) {}
      };
      sw.postMessage({ type: 'pickup-share' }, [ch.port2]);
    });
  } catch(_) {}
})();

function doClear(){
  document.body.dataset.confirm = 'closed';
  /* Revoke all blob URLs across BOTH the primary encoded map and the
     multi-output sidecar. Without the sidecar revoke, Clear-All in
     multi-output mode leaked encoded blobs across cycles. Also flush
     the queue + inflight maps so a stale encode can't repopulate
     ENCODE.encoded after the user has cleared. */
  FILES.forEach(f => { try { URL.revokeObjectURL(f.url); } catch(_){} });
  ENCODE.encoded.forEach(e => { try { URL.revokeObjectURL(e.url); } catch(_){} });
  ENCODE.allEncoded.forEach(m => m.forEach(e => { try { URL.revokeObjectURL(e.url); } catch(_){} }));
  ENCODE.encoded.clear();
  ENCODE.allEncoded.clear();
  ENCODE.queue.length = 0;
  ENCODE.inflight.clear();
  FILES.length = 0;
  CFLOW.thumbs = [];
  CFLOW.selected = 0; CFLOW.drift = 0;
  document.getElementById('cflowTrack').querySelectorAll('.cflow-thumb:not(.clear-all)').forEach(t => t.remove()); /* keep static clear-all tile */
  /* Stay in workspace state ('multi'), just flag the body so CSS shows
     an empty-batch dropzone overlayacross BOTH the primary encoded map and the
     multi-output sidecar. Without the sidecar revoke, Clear-All in
     multi-output mode leaked encoded blobs across cycles. Also flush
     the queue + inflight maps so a stale encode can't repopulate
     ENCODE.encoded after the user has cleared. */
  FILES.forEach(f => { try { URL.revokeObjectURL(f.url); } catch(_){} });
  ENCODE.encoded.forEach(e => { try { URL.revokeObjectURL(e.url); } catch(_){} });
  ENCODE.allEncoded.forEach(m => m.forEach(e => { try { URL.revokeObjectURL(e.url); } catch(_){} }));
  ENCODE.encoded.clear();
  ENCODE.allEncoded.clear();
  ENCODE.queue.length = 0;
  ENCODE.inflight.clear();
  FILES.length = 0;
  CFLOW.thumbs = [];
  CFLOW.selected = 0; CFLOW.drift = 0;
  document.getElementById('cflowTrack').querySelectorAll('.cflow-thumb:not(.clear-all)').forEach(t => t.remove()); /* keep static clear-all tile */
  /* Stay in workspace state ('multi'), just flag the body so CSS shows
     an empty-batch dropzone overlay over the compare-slider area.
     Workspace chrome (top stats bar + bottom toolbar) keeps rendering,
     so user feels they're still in the same tool — just waiting for
     the next batch. No state transition = no flash. */
  document.body.dataset.emptyBatch = 'true';
  /* The /-link in the brand-bar (logo click) still exits to '/' which
     is the empty state — preserves the landing-page-as-exit pattern. */
}

/* HOME_APP_EOF */
