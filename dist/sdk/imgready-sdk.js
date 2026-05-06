/*!
 * imgready SDK v0.2.0
 * https://imgready.app/developers
 * MIT License — attribution required without a license key
 * Copyright (c) 2026 imgready
 *
 * v0.2.0 changelog:
 *   - SECURITY: license keys now validated via HMAC-SHA256 against a server secret.
 *     Keys must be issued by imgready (Stripe webhook → /api/issue-key). The previous
 *     client-side checksum validator is removed.
 *   - generateKey() removed from the public API. Key minting is server-side only.
 *   - Optional remote validation: pass {validateOnline: true} to imgready.init() to
 *     verify the key against /api/verify-key on first use (cached for 24h).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();           // CommonJS / Node
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);                  // AMD
  } else {
    root.imgready = factory();            // Browser global
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ============================================================
     CONSTANTS
  ============================================================ */
  var VERSION   = '0.2.0';
  var CDN_BASE  = 'https://cdnjs.cloudflare.com/ajax/libs';
  var ESM_BASE  = 'https://esm.sh';
  var LIBHEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.18.2/libheif/libheif.js';

  var DEFAULTS = {
    format:     'webp',   // webp | avif | png | jpg | gif
    quality:    82,       // 1-100
    maxDim:     0,        // 0 = no resize; otherwise longest-side px
    crop:       'none',   // none | 1:1 | 4:3 | 3:4 | 16:9 | 9:16
    stripExif:  true,
    licenseKey: null,
  };

  var CROP_RATIOS = {
    'none': null, '1:1': 1, '4:3': 4/3, '3:4': 3/4, '16:9': 16/9, '9:16': 9/16
  };

  var MIME = {
    webp: 'image/webp', avif: 'image/avif',
    png:  'image/png',  jpg:  'image/jpeg', gif: 'image/gif'
  };

  /* ============================================================
     INTERNAL STATE (per-SDK-instance via closure)
  ============================================================ */
  var _libheifModule  = null;
  var _upngReady      = false;
  var _pakoReady      = false;
  var _webpEncFn      = null;
  var _avifEncFn      = null;
  var _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /* ============================================================
     ATTRIBUTION
     Footer snippet injected unless valid licenseKey supplied.
     Console credit always printed (developer-facing only).
  ============================================================ */
  // Key format: IR-<TIER>-<16 hex (random)>-<8 hex (HMAC-SHA256 truncated)>
  // TIER: P (Personal $9) | D (Developer $29) | C (Commercial $99)
  // The HMAC is computed server-side over `${TIER}.${RANDOM}` using a secret
  // known only to the imgready key-issuance server. Browser-side validation
  // is OPTIONAL and shape-only; real validation requires a /api/verify-key
  // round-trip (use {validateOnline: true} in init).
  var TIER_MAP = { P: 'personal', D: 'developer', C: 'commercial' };
  var KEY_RE = /^IR-([PDC])-([0-9A-Fa-f]{16})-([0-9A-Fa-f]{8})$/;
  var VERIFY_ENDPOINT = 'https://imgready.app/api/verify-key';
  var VERIFY_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

  function _shapeOk(key) {
    return !!(key && typeof key === 'string' && KEY_RE.test(key));
  }

  function _getTier(key) {
    if (!_shapeOk(key)) return null;
    return TIER_MAP[key.match(KEY_RE)[1]] || null;
  }

  /* Optional online validation. Caches positive results for 24h in localStorage. */
  function _verifyOnline(key) {
    if (!_shapeOk(key)) return Promise.resolve(false);
    try {
      var raw = localStorage.getItem('imgready_keycache_' + key);
      if (raw) {
        var cached = JSON.parse(raw);
        if (cached && cached.ok && (Date.now() - cached.t) < VERIFY_CACHE_TTL) return Promise.resolve(true);
      }
    } catch (e) {}
    return fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, origin: location.origin })
    }).then(function (r) { return r.ok ? r.json() : { valid: false }; })
      .then(function (j) {
        var ok = !!(j && j.valid);
        try { localStorage.setItem('imgready_keycache_' + key, JSON.stringify({ ok: ok, t: Date.now() })); } catch (e) {}
        return ok;
      })
      .catch(function () { return false; }); // Fail-closed: bad network → keep badge
  }

  function _injectFooter() {
    if (typeof document === 'undefined') return; // Node / non-browser env
    if (document.getElementById('imgready-attr')) return; // already injected
    var el = document.createElement('div');
    el.id = 'imgready-attr';
    el.innerHTML =
      '<span style="font-size:11px;color:#8a8070;font-family:system-ui,sans-serif;">' +
      'Images optimized by <a href="https://imgready.app" target="_blank" ' +
      'rel="noopener" style="color:#5a7a5a;text-decoration:none;font-weight:600;">' +
      'imgready</a></span>';
    el.style.cssText =
      'position:fixed;bottom:10px;right:14px;z-index:9999;' +
      'background:rgba(255,255,255,0.85);backdrop-filter:blur(4px);' +
      '-webkit-backdrop-filter:blur(4px);' +
      'border:1px solid #d6cebb;border-radius:6px;padding:4px 10px;' +
      'box-shadow:0 1px 6px rgba(0,0,0,0.08);pointer-events:auto;';
    // Wait for DOM ready
    if (document.body) {
      document.body.appendChild(el);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(el);
      });
    }
  }

  function _removeFooter() {
    var el = document.getElementById('imgready-attr');
    if (el) el.parentNode.removeChild(el);
  }

  function _initAttribution(licenseKey, validateOnline) {
    var tier = _getTier(licenseKey);
    var tierLabel = tier ? ' · ' + tier + ' license (pending verification)' : '';
    if (typeof console !== 'undefined' && console.log) {
      console.log(
        '%c imgready SDK v' + VERSION + '%c https://imgready.app/developers' + tierLabel + ' ',
        'background:#5a7a5a;color:#fff;padding:2px 6px;border-radius:3px 0 0 3px;font-weight:700;',
        'background:#e8f0e8;color:#5a7a5a;padding:2px 6px;border-radius:0 3px 3px 0;'
      );
    }
    /* Shape check is the bare minimum — without online verification, badge stays. */
    if (!_shapeOk(licenseKey)) { _injectFooter(); return; }
    if (validateOnline === false) {
      /* Caller explicitly opted out of online verification — we cannot trust the key. */
      _injectFooter();
      return;
    }
    /* Default: verify against the server. */
    _verifyOnline(licenseKey).then(function (ok) {
      if (ok) _removeFooter(); else _injectFooter();
    });
    /* Show badge optimistically until verification completes (avoids flash if key is invalid). */
    _injectFooter();
  }

  /* ============================================================
     LAZY LOADER HELPERS
  ============================================================ */
  function _loadScript(url) {
    return new Promise(function (res, rej) {
      if (typeof document === 'undefined') return rej(new Error('No DOM'));
      var s = document.createElement('script');
      s.src = url; s.async = true;
      s.onload = res; s.onerror = function () { rej(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
  }

  function _ensureUPNG() {
    if (_upngReady && _pakoReady) return Promise.resolve();
    var jobs = [];
    if (!_pakoReady) {
      jobs.push(_loadScript(CDN_BASE + '/pako/2.1.0/pako.min.js').then(function () { _pakoReady = true; }));
    }
    return Promise.all(jobs).then(function () {
      if (_upngReady) return;
      return _loadScript(CDN_BASE + '/upng-js/2.1.0/UPNG.min.js').then(function () { _upngReady = true; });
    });
  }

  function _ensureWebp() {
    if (_webpEncFn) return Promise.resolve();
    return import(ESM_BASE + '/@jsquash/webp@1.4.0').then(function (m) {
      _webpEncFn = m.encode;
    });
  }

  function _ensureAvif() {
    if (_avifEncFn) return Promise.resolve();
    return import(ESM_BASE + '/@jsquash/avif@2.1.1').then(function (m) {
      _avifEncFn = m.encode;
    });
  }

  function _ensureLibheif() {
    if (_libheifModule) return Promise.resolve(_libheifModule);
    /* CSP-safe: load libheif as a normal <script src=> tag, no eval. */
    return _loadScript(LIBHEIF_URL)
      .then(function () {
        var lib = window.libheif;
        if (!lib) throw new Error('libheif not found after load');
        if (typeof lib === 'function') {
          return new Promise(function (res, rej) {
            var to = setTimeout(function () { rej(new Error('libheif init timeout')); }, 30000);
            lib({ onRuntimeInitialized: function () { clearTimeout(to); res(this); } });
          });
        }
        if (lib.then) return lib;
        return lib;
      })
      .then(function (lib) {
        if (!lib.HeifDecoder && window.HeifDecoder) lib.HeifDecoder = window.HeifDecoder;
        if (!lib.HeifDecoder) {
          return new Promise(function (r) { setTimeout(r, 500); }).then(function () {
            if (!lib.HeifDecoder && window.HeifDecoder) lib.HeifDecoder = window.HeifDecoder;
            if (!lib.HeifDecoder) throw new Error('HeifDecoder not found');
            _libheifModule = lib; return lib;
          });
        }
        _libheifModule = lib; return lib;
      });
  }

  /* ============================================================
     FILE TYPE DETECTION
  ============================================================ */
  function _ext(f) { return (f.name || '').split('.').pop().toLowerCase(); }
  function _isHeic(f) { var e=_ext(f); return e==='heic'||e==='heif'||f.type==='image/heic'||f.type==='image/heif'; }
  function _isTiff(f) { var e=_ext(f); return e==='tif'||e==='tiff'||f.type==='image/tiff'; }
  function _isSvg(f)  { var e=_ext(f); return e==='svg'||f.type==='image/svg+xml'; }

  /* ============================================================
     DECODERS
  ============================================================ */
  function _canvasToBlob(canvas, mime) {
    return new Promise(function (res, rej) {
      canvas.toBlob(function (b) { b ? res(b) : rej(new Error('Canvas toBlob failed')); }, mime);
    });
  }

  function _decodeHeic(file) {
    return _ensureLibheif().then(function (lib) {
      return file.arrayBuffer().then(function (buf) {
        var dec  = new lib.HeifDecoder();
        var data = dec.decode(new Uint8Array(buf));
        if (!data || !data.length) throw new Error('No images found in HEIC file');
        var img = data[0], w = img.get_width(), h = img.get_height();
        var c   = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d'), id = ctx.createImageData(w, h);
        return new Promise(function (res, rej) {
          img.display(id, function (d) {
            if (!d) return rej(new Error('HEIC display() failed'));
            ctx.putImageData(id, 0, 0);
            _canvasToBlob(c, 'image/png').then(res).catch(rej);
          });
        });
      });
    });
  }

  function _decodeTiff(file) {
    // Try native first (Chrome supports some TIFFs via createImageBitmap)
    return createImageBitmap(file).then(function (bmp) {
      var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
      return _canvasToBlob(c, 'image/png');
    }).catch(function () {
      // Fallback: manual TIFF parse (uncompressed + PackBits + LZW)
      return file.arrayBuffer().then(function (buf) {
        return _canvasToBlob(_parseTiff(buf), 'image/png');
      });
    });
  }

  function _decodeSvg(file, targetW) {
    return new Promise(function (res, rej) {
      var rd = new FileReader();
      rd.onload = function () {
        var blob = new Blob([rd.result], { type: 'image/svg+xml;charset=utf-8' });
        var url  = URL.createObjectURL(blob);
        var img  = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          var w = img.naturalWidth || targetW, h = img.naturalHeight || targetW;
          var sc = targetW / w, cw = Math.round(w*sc), ch = Math.round(h*sc);
          var c  = document.createElement('canvas'); c.width = cw; c.height = ch;
          c.getContext('2d').drawImage(img, 0, 0, cw, ch);
          _canvasToBlob(c, 'image/png').then(res).catch(rej);
        };
        img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('SVG render failed')); };
        img.src = url;
      };
      rd.onerror = rej;
      rd.readAsText(file);
    });
  }

  // LZW decoder for TIFF compression type 5 — mirrors imgready-worker.js decodeLZW
  function _decodeLZW(B,offs,cnts){
    var out=[];
    for(var s=0;s<offs.length;s++){
      var src=new Uint8Array(B,offs[s],cnts[s]);
      var bp=0,cs=9;
      var tbl=[];
      function rst(){tbl=[];for(var i=0;i<258;i++)tbl[i]=i<256?[i]:[];cs=9;}
      function rd(){var c=0;for(var i=0;i<cs;i++){var bi=(bp+i)>>3,bt=7-((bp+i)&7);if(bi<src.length)c=(c<<1)|((src[bi]>>bt)&1);}bp+=cs;return c;}
      rst();
      var code=rd();if(code!==256)continue;
      rst();
      var old=rd();if(old===257)continue;
      if(tbl[old])for(var b=0;b<tbl[old].length;b++)out.push(tbl[old][b]);
      while(true){
        code=rd();
        if(code===257||bp>src.length*8+16)break;
        if(code===256){rst();code=rd();if(code===257)break;if(tbl[code])for(var b2=0;b2<tbl[code].length;b2++)out.push(tbl[code][b2]);old=code;continue;}
        var entry;
        if(code<tbl.length&&tbl[code])entry=tbl[code];
        else if(code===tbl.length)entry=tbl[old]?tbl[old].concat([tbl[old][0]]):[0];
        else break;
        for(var b3=0;b3<entry.length;b3++)out.push(entry[b3]);
        if(tbl[old])tbl.push(tbl[old].concat([entry[0]]));
        if(tbl.length>=(1<<cs)&&cs<12)cs++;
        old=code;
      }
    }
    return new Uint8Array(out);
  }

  // Minimal TIFF parser (same logic as main tool) — kept inline to avoid extra deps
  function _parseTiff(B) {
    var dv=new DataView(B),le=dv.getUint16(0)===0x4949;
    function r16(o){return dv.getUint16(o,le);}function r32(o){return dv.getUint32(o,le);}
    if(r16(2)!==42)throw new Error('Invalid TIFF');
    var io=r32(4),n=r16(io),T={};
    for(var i=0;i<n;i++){var e=io+2+i*12,tag=r16(e),ty=r16(e+2),cnt=r32(e+4);var v;if(cnt*({1:1,2:1,3:2,4:4,5:8}[ty]||4)<=4){v=ty===3?r16(e+8):r32(e+8);if(cnt>1&&ty===3)v=[r16(e+8),r16(e+10)];}else{var o2=r32(e+8);v=[];for(var j=0;j<cnt;j++)v.push(ty===3?r16(o2+j*2):r32(o2+j*4));}T[tag]=v;}
    var w=T[256]||0,h=T[257]||0,comp=T[259]||1,ph=T[262]||2,spp=T[277]||1,bv=T[258],bps=Array.isArray(bv)?bv[0]:(bv||8);
    var offs=Array.isArray(T[273])?T[273]:[T[273]||0],cnts=Array.isArray(T[279])?T[279]:[T[279]||0];
    if(!w||!h)throw new Error('Invalid TIFF dimensions');
    if(comp!==1&&comp!==5&&comp!==32773)throw new Error('Unsupported TIFF compression: '+comp);
    var raw;
    if(comp===1){var t=0;for(var ci=0;ci<cnts.length;ci++)t+=cnts[ci];raw=new Uint8Array(t);var p=0;for(var si=0;si<offs.length;si++){raw.set(new Uint8Array(B,offs[si],cnts[si]),p);p+=cnts[si];}}
    else if(comp===32773){var oo=[];for(var s2=0;s2<offs.length;s2++){var src=new Int8Array(B,offs[s2],cnts[s2]);var ii=0;while(ii<src.length){var nn=src[ii++];if(nn>=0)for(var jj=0;jj<=nn&&ii<src.length;jj++)oo.push(src[ii++]&0xff);else if(nn!==-128){var vv=src[ii++]&0xff;for(var kk=0;kk<1-nn;kk++)oo.push(vv);}}}raw=new Uint8Array(oo);}
    else{/* LZW (comp===5) — ported from imgready-worker.js */raw=_decodeLZW(B,offs,cnts);}
    var c=document.createElement('canvas');c.width=w;c.height=h;var ctx=c.getContext('2d'),id=ctx.createImageData(w,h),px=id.data,bS=Math.ceil(bps/8);
    for(var y=0;y<h;y++)for(var x=0;x<w;x++){var di=(y*w+x)*4,sii=(y*w+x)*spp*bS;if(spp>=3){px[di]=raw[sii]||0;px[di+1]=raw[sii+1]||0;px[di+2]=raw[sii+2]||0;px[di+3]=spp>=4?(raw[sii+3]!==undefined?raw[sii+3]:255):255;}else{var val=raw[sii]||0,gg=ph===0?255-val:val;px[di]=px[di+1]=px[di+2]=gg;px[di+3]=255;}}
    ctx.putImageData(id,0,0);return c;
  }

  /* ============================================================
     QUALITY → COLOR COUNT (UPNG PNG-8)
  ============================================================ */
  function _qualityToColors(q) {
    // q = 0.0–1.0
    if (q >= 1.0)  return 0;   // lossless
    if (q >= 0.85) return 256;
    if (q >= 0.70) return 128;
    if (q >= 0.55) return 64;
    if (q >= 0.40) return 32;
    return 16;
  }

  /* ============================================================
     CORE ENCODE
     Returns Promise<Blob>
  ============================================================ */
  function _encode(canvas, fmt, quality) {
    var q   = quality / 100;   // normalise to 0–1
    var mime = MIME[fmt] || MIME.webp;

    // AVIF always via jsquash
    if (fmt === 'avif') {
      return _ensureAvif().then(function () {
        var ctx = canvas.getContext('2d');
        var id  = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return _avifEncFn(id, { quality: Math.round(q * 100) }).then(function (buf) {
          return new Blob([buf], { type: 'image/avif' });
        });
      });
    }

    // WebP on iOS via jsquash (Safari WebP encoding broken)
    if (fmt === 'webp' && _isIOS) {
      return _ensureWebp().then(function () {
        var ctx = canvas.getContext('2d');
        var id  = ctx.getImageData(0, 0, canvas.width, canvas.height);
        return _webpEncFn(id, { quality: Math.round(q * 100) }).then(function (buf) {
          return new Blob([buf], { type: 'image/webp' });
        });
      });
    }

    // PNG: lossy (UPNG) or lossless (canvas)
    if (fmt === 'png') {
      if (q < 1.0) {
        return _ensureUPNG().then(function () {
          var ctx  = canvas.getContext('2d');
          var id   = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var cnum = _qualityToColors(q);
          var buf  = UPNG.encode([id.data.buffer], canvas.width, canvas.height, cnum);
          return new Blob([buf], { type: 'image/png' });
        });
      }
      // lossless PNG
      return new Promise(function (res, rej) {
        canvas.toBlob(function (b) { b ? res(b) : rej(new Error('PNG encode failed')); }, 'image/png');
      });
    }

    // GIF, JPG, WebP (non-iOS) — native canvas
    return new Promise(function (res, rej) {
      canvas.toBlob(
        function (b) { b ? res(b) : rej(new Error(fmt + ' encode failed')); },
        mime,
        fmt === 'gif' ? undefined : q
      );
    });
  }

  /* ============================================================
     PRE-DECODE — normalise exotic formats to a loadable Blob
  ============================================================ */
  function _preDecode(file, opts) {
    if (_isHeic(file)) return _decodeHeic(file);
    if (_isTiff(file)) return _decodeTiff(file);
    if (_isSvg(file))  return _decodeSvg(file, opts.maxDim ? opts.maxDim * 2 : 2048);
    return Promise.resolve(file);
  }

  /* ============================================================
     MAIN PIPELINE
  ============================================================ */
  function _process(file, opts) {
    return _preDecode(file, opts).then(function (src) {
      return new Promise(function (res, rej) {
        var url = URL.createObjectURL(src);
        var img = new Image();
        img.onload = function () {
          URL.revokeObjectURL(url);
          try {
            // Dimensions
            var w = img.naturalWidth, h = img.naturalHeight;
            var sx = 0, sy = 0, sw = w, sh = h;

            // Crop
            var ratio = CROP_RATIOS[opts.crop] || null;
            if (ratio) {
              if (w / h > ratio) { sw = Math.round(h * ratio); sx = Math.round((w - sw) / 2); }
              else               { sh = Math.round(w / ratio); sy = Math.round((h - sh) / 2); }
              w = sw; h = sh;
            }

            // Resize (longest side)
            if (opts.maxDim && Math.max(w, h) > opts.maxDim) {
              var scale = opts.maxDim / Math.max(w, h);
              w = Math.round(w * scale); h = Math.round(h * scale);
            }

            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);

            _encode(canvas, opts.format, opts.quality).then(res).catch(rej);
          } catch (err) { rej(err); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('Image load failed: ' + file.name)); };
        img.src = url;
      });
    });
  }

  /* ============================================================
     PUBLIC API
  ============================================================ */

  /**
   * imgready.compress(file, options?) → Promise<Blob>
   *
   * @param {File|Blob} file   - Input image (any supported format)
   * @param {Object}    options
   *   format     {string}  'webp'|'avif'|'png'|'jpg'|'gif'  (default: 'webp')
   *   quality    {number}  1-100                              (default: 82)
   *   maxDim     {number}  Longest side in px, 0 = no resize  (default: 0)
   *   crop       {string}  'none'|'1:1'|'4:3'|'16:9'|'9:16'  (default: 'none')
   *   licenseKey {string}  Removes footer attribution         (default: null)
   * @returns {Promise<Blob>}
   */
  function compress(file, options) {
    if (!(file instanceof Blob)) return Promise.reject(new Error('imgready.compress: first argument must be a File or Blob'));
    var opts = {};
    for (var k in DEFAULTS) opts[k] = DEFAULTS[k];
    if (options) for (var k in options) if (k in DEFAULTS) opts[k] = options[k];

    // Clamp quality
    opts.quality = Math.max(1, Math.min(100, opts.quality || 82));

    return _process(file, opts);
  }

  /**
   * imgready.compressAll(files, options?) → Promise<Blob[]>
   * Processes an array (or FileList) of images with the same options.
   * Runs sequentially to avoid memory pressure on large batches.
   */
  function compressAll(files, options) {
    var list = Array.prototype.slice.call(files);
    var results = [];
    return list.reduce(function (chain, file) {
      return chain.then(function () {
        return compress(file, options).then(function (blob) { results.push(blob); });
      });
    }, Promise.resolve()).then(function () { return results; });
  }

  /**
   * imgready.init(options?)
   * Optional explicit initialisation. Useful for setting a licenseKey once
   * at app start rather than per-call. Also pre-loads encoders eagerly.
   *
   * @param {Object} options  Same shape as compress() options
   */
  function init(options) {
    var key = options && options.licenseKey ? options.licenseKey : null;
    var validateOnline = !options || options.validateOnline !== false; // default ON
    _initAttribution(key, validateOnline);

    // Merge into DEFAULTS so subsequent compress() calls inherit the key
    if (options) for (var k in options) if (k in DEFAULTS) DEFAULTS[k] = options[k];

    // Eager pre-load (optional — compress() lazy-loads anyway)
    if (typeof document !== 'undefined') {
      var fmt = DEFAULTS.format;
      if (fmt === 'avif') _ensureAvif().catch(function(){});
      else if (fmt === 'webp') _ensureWebp().catch(function(){});
    }

    return sdk; // chainable
  }

  /* generateKey() was removed in v0.2.0 for security. Keys are minted server-side
     by Stripe-webhook → /api/issue-key. Email hello@imgready.app for a key after
     purchase if you do not receive one automatically. */

  var sdk = { compress: compress, compressAll: compressAll, init: init, version: VERSION };

  // Auto-init attribution if script is loaded without calling init()
  // (lazy — runs after current call stack so DOM is more likely ready)
  if (typeof document !== 'undefined') {
    setTimeout(function () {
      if (!document.getElementById('imgready-attr')) _initAttribution(DEFAULTS.licenseKey);
    }, 0);
  }

  return sdk;
}));
