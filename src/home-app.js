
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
   EDIT MODE — lazy-loaded (Stage 2 / R129). The editor (~4,500 lines:
   rotate/crop/frames/adjust/auto-enhance/pixelate/background-removal) now
   lives in /home-editor.js and is fetched on first Edit click, so it no
   longer parses on every homepage load. piEdit() is invoked from markup
   (onclick), so it stays global here as a loader shim; the real open
   logic (_openEditFromPi) lives in the chunk.
   ============================================================ */
let _editorChunk = null;
function ensureEditor(){
  if (_editorChunk) return _editorChunk;
  _editorChunk = new Promise(function(resolve, reject){
    var s = document.createElement('script');
    s.src = '/home-editor.js';
    s.onload = function(){ resolve(); };
    s.onerror = function(){ _editorChunk = null; reject(new Error('editor chunk failed to load')); };
    document.head.appendChild(s);
  });
  return _editorChunk;
}
function piEdit(){
  ensureEditor().then(function(){
    if (typeof _openEditFromPi === 'function') _openEditFromPi();
  }).catch(function(){ try { alert('Could not load the editor — please retry.'); } catch(_){} });
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

  /* R133 — ?kb= (alias ?size=) presets By-size mode with a KB ceiling, so
     "compress to 100 KB" landing pages can deep-link straight into a
     configured tool: /?kb=100#dropzone. Pairs with the R118 guarantee that
     output lands at or under the target. Retried briefly because the
     quality dropdown lives in the workspace bar. */
  const qsKb = parseInt(qs.get('kb') || qs.get('size') || '', 10);
  if (qsKb > 0 && qsKb <= 99999) {
    let _kbTries = 0;
    const applyKb = () => {
      if (typeof setQualityTarget === 'function' &&
          document.querySelector('.quality-dropdown')) {
        setQualityTarget(qsKb, { silent: true });
        return;
      }
      if (++_kbTries < 20) setTimeout(applyKb, 100);
    };
    applyKb();
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
  /* R138 — warm the sample on INTENT rather than on page load. R132 removed
     the blanket prefetch because pulling all three samples (~9.3 MB; demo_1
     alone is 7.3 MB) on every visit starved real requests and burned mobile
     data. But that left the first click waiting on the full download.
     Hovering, focusing or pressing a card is a reliable intent signal, so we
     start the fetch then — the browser HTTP cache serves the subsequent
     loadSample() fetch, which makes the click feel instant while costing
     nothing to visitors who never touch a sample. Same idea as
     instant.page / Next.js Link prefetch-on-hover. */
  const _warmed = new Set();
  function warmSample(url){
    if (!url || _warmed.has(url)) return;
    _warmed.add(url);
    try {
      fetch(url, { cache: 'force-cache', priority: 'low' }).catch(() => {});
    } catch(_) {
      try { fetch(url).catch(() => {}); } catch(__){}
    }
  }
  ['pointerenter','focusin','touchstart'].forEach(function(evt){
    document.addEventListener(evt, function(e){
      const card = e.target && e.target.closest && e.target.closest('.dz-float-card[data-sample]');
      if (card) warmSample(card.dataset.sample);
    }, { capture: true, passive: true });
  });

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
  /* R131 — track the sample being dragged so dragend can load it even when
     the user releases OUTSIDE the dropzone (previously that gave no feedback). */
  let _draggedSample = null, _sampleDragLoaded = false;
  document.addEventListener('dragstart', e => {
    const card = e.target.closest && e.target.closest('.dz-float-card[data-sample]');
    if (!card) return;
    _draggedSample = { url: card.dataset.sample, name: card.dataset.sampleName || 'sample.jpg', type: card.dataset.sampleType || 'image/jpeg' };
    _sampleDragLoaded = false;
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
    /* R131 — if the drag didn't land in the dropzone, still honor the intent:
       load the sample (which switches to the tool view) rather than doing
       nothing. Guarded so an in-dropzone drop doesn't double-load. */
    if (_draggedSample && !_sampleDragLoaded) {
      loadSample(_draggedSample.url, _draggedSample.name, _draggedSample.type);
    }
    _draggedSample = null; _sampleDragLoaded = false;
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
      _sampleDragLoaded = true; /* R131 — tell dragend the drop already loaded it */
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
