/* /ai-image-upscaler/ page engine. Decodes the picked image, hands the
   pixels to /upscale-worker.js, shows progress, and encodes the result
   locally for download. Nothing is uploaded. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var drop = $('upDrop'), input = $('upInput'), go = $('upGo'), save = $('upSave');
  var statusEl = $('upStatus'), bar = $('upBar'), barFill = $('upBarFill');
  var view = $('upView'), viewImg = $('upViewImg'), meta = $('upMeta'), hold = $('upHold');
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var MAX_OUT_MP = IOS ? 16 : 48;           // canvas and memory ceilings
  var MAX_SIDE = IOS ? 4096 : 16384;
  var file = null, srcBitmap = null, srcUrl = null, outBlob = null, outUrl = null, worker = null, jobId = 0, busy = false;

  function opt(name) { var el = document.querySelector('input[name="' + name + '"]:checked'); return el ? el.value : null; }
  function say(t) { statusEl.textContent = t; }
  function setBar(f) { bar.hidden = f == null; if (f != null) barFill.style.width = Math.round(f * 100) + '%'; }
  function mb(n) { return (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB'; }

  function limits() {
    if (!srcBitmap) return null;
    var s = +opt('upScale'), w = srcBitmap.width * s, h = srcBitmap.height * s;
    if (w * h > MAX_OUT_MP * 1e6 || Math.max(w, h) > MAX_SIDE) return { w: w, h: h, ok: false };
    return { w: w, h: h, ok: true };
  }
  function refresh() {
    var L = limits();
    if (!L) { go.disabled = true; return; }
    meta.textContent = srcBitmap.width + ' × ' + srcBitmap.height + ' px  →  ' + L.w + ' × ' + L.h + ' px';
    if (!L.ok) {
      go.disabled = true;
      say('That output would be ' + (L.w * L.h / 1e6).toFixed(0) + ' megapixels, past what this browser can hold. Pick 2x, or start from a smaller image.');
    } else if (!busy) {
      go.disabled = false;
      say(opt('upQuality') === 'best'
        ? 'Best quality downloads a 49 MB model once, then takes about a minute per megapixel on a good graphics card.'
        : 'Fast downloads a 1 MB model once and takes a few seconds.');
    }
  }

  function pick(f) {
    if (!f || !/^image\//.test(f.type)) { say('That file is not an image this browser can open.'); return; }
    file = f;
    createImageBitmap(f, { imageOrientation: 'from-image' }).then(function (bm) {
      srcBitmap = bm;
      if (srcUrl) URL.revokeObjectURL(srcUrl);
      srcUrl = URL.createObjectURL(f);
      if (outUrl) { URL.revokeObjectURL(outUrl); outUrl = null; }
      outBlob = null; save.disabled = true; hold.hidden = true;
      viewImg.src = srcUrl; viewImg.alt = 'Your image, before upscaling';
      view.hidden = false; drop.classList.add('has-file');
      $('upDropTitle').textContent = f.name;
      refresh();
    }, function () { say('This browser could not decode that file. Try a JPG, PNG or WebP.'); });
  }

  drop.addEventListener('click', function () { if (!busy) input.click(); });
  drop.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); input.click(); } });
  input.addEventListener('change', function () { pick(input.files[0]); input.value = ''; });
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-drag'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-drag'); }); });
  drop.addEventListener('drop', function (e) { if (!busy && e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]); });
  document.querySelectorAll('input[name="upScale"],input[name="upQuality"]').forEach(function (el) { el.addEventListener('change', refresh); });

  function outType() {
    var f = opt('upFormat');
    if (f === 'auto') return file && /png|gif|webp|avif/.test(file.type) ? (file.type === 'image/webp' ? 'image/webp' : 'image/png') : 'image/jpeg';
    return f;
  }

  go.addEventListener('click', function () {
    var L = limits(); if (!L || !L.ok || busy) return;
    busy = true; go.disabled = true; save.disabled = true; hold.hidden = true;
    var c = document.createElement('canvas'); c.width = srcBitmap.width; c.height = srcBitmap.height;
    var g = c.getContext('2d'); g.drawImage(srcBitmap, 0, 0);
    var px = g.getImageData(0, 0, c.width, c.height);
    if (!worker) worker = new Worker('/upscale-worker.js', { type: 'module' });
    var id = ++jobId;
    say('Loading the engine'); setBar(0);
    worker.onmessage = function (e) {
      var m = e.data; if (m.id !== id) return;
      if (m.type === 'stage') say(m.text);
      else if (m.type === 'progress') {
        setBar(m.done / m.total);
        say(m.phase === 'download' ? 'Downloading the model, ' + mb(m.done) + ' of ' + mb(m.total) + ' (first time only)'
                                   : 'Upscaling, part ' + m.done + ' of ' + m.total);
      } else if (m.type === 'done') finish(m);
      else if (m.type === 'error') { busy = false; setBar(null); refresh(); say('Something went wrong: ' + m.message); }
    };
    worker.postMessage({ type: 'run', id: id, quality: opt('upQuality'), scale: +opt('upScale'),
      width: px.width, height: px.height, rgba: px.data.buffer }, [px.data.buffer]);
  });

  function finish(m) {
    say('Saving the file');
    var c = document.createElement('canvas'); c.width = m.width; c.height = m.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height), 0, 0);
    var type = outType();
    c.toBlob(function (b) {
      busy = false; setBar(null);
      if (!b) { refresh(); say('The browser could not encode an image this large. Try 2x.'); return; }
      outBlob = b;
      if (outUrl) URL.revokeObjectURL(outUrl);
      outUrl = URL.createObjectURL(b);
      viewImg.src = outUrl; viewImg.alt = 'Upscaled result';
      save.disabled = false; hold.hidden = false; go.disabled = false;
      say('Done in ' + (m.ms / 1000).toFixed(1) + ' s on ' + (m.backend === 'webgpu' ? 'your graphics card' : 'your processor')
        + '. ' + m.width + ' × ' + m.height + ' px, ' + mb(b.size) + '.');
    }, type, type === 'image/png' ? undefined : 0.92);
  }

  save.addEventListener('click', function () {
    if (!outBlob) return;
    var ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[outBlob.type] || 'png';
    var a = document.createElement('a');
    a.href = outUrl; a.download = file.name.replace(/\.[^.]+$/, '') + '_upscaled_' + opt('upScale') + 'x.' + ext;
    document.body.appendChild(a); a.click(); a.remove();
  });

  function showOrig(on) { if (outUrl) { viewImg.src = on ? srcUrl : outUrl; hold.setAttribute('aria-pressed', on ? 'true' : 'false'); } }
  hold.addEventListener('pointerdown', function () { showOrig(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (t) { hold.addEventListener(t, function () { showOrig(false); }); });
  hold.addEventListener('keydown', function (e) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); showOrig(true); } });
  hold.addEventListener('keyup', function () { showOrig(false); });

  if (!('gpu' in navigator)) {
    $('upNoGpu').hidden = false;
    var best = document.querySelector('input[name="upQuality"][value="best"]');
    if (best) { best.disabled = true; best.closest('label').classList.add('is-off'); }
  }
})();
