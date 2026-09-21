/* Favicon package generator.
 *
 * favicon.io and RealFaviconGenerator both upload your image to a server
 * to do work a browser can do unaided. This does the same job locally.
 *
 * Self-contained on purpose. The main app has an ICO path, but it is
 * wired into the worker pipeline and the process modal; a standalone tool
 * page should not reach into that. A PNG-in-ICO writer is forty lines.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* Sizes chosen from what actually gets requested in 2026.
     16/32/48 go inside the .ico because Windows and older browsers ask for
     them; everything else is a standalone PNG referenced from the HTML. */
  var ICO_SIZES = [16, 32, 48];
  var PNG_SIZES = [
    { n: 'favicon-96x96.png', s: 96, why: 'Google search results and some Android surfaces' },
    { n: 'apple-touch-icon.png', s: 180, why: 'iOS home screen' },
    { n: 'icon-192.png', s: 192, why: 'Android home screen, PWA manifest' },
    { n: 'icon-512.png', s: 512, why: 'PWA splash screen' },
    { n: 'icon-512-maskable.png', s: 512, maskable: true, why: 'Android adaptive icon' }
  ];

  var state = { img: null, name: 'icon', bg: '#ffffff', pad: 0, radius: 0, transparent: true };

  /* ---------- drawing ---------- */
  function draw(size, opts) {
    opts = opts || {};
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var x = c.getContext('2d');

    /* A maskable icon is cropped to a circle of 80% of the canvas by
       Android, so the artwork has to sit inside that safe zone or the
       corners get eaten. Shrinking to 80% is the whole trick. */
    var scale = opts.maskable ? 0.8 : 1 - (state.pad / 100) * 2;
    if (!state.transparent || opts.maskable || opts.forceBg) {
      x.fillStyle = state.bg;
      if (state.radius && !opts.maskable) {
        roundRect(x, 0, 0, size, size, size * (state.radius / 100));
        x.fill();
      } else {
        x.fillRect(0, 0, size, size);
      }
    }
    var img = state.img;
    if (img) {
      var d = size * scale;
      var r = Math.min(d / img.width, d / img.height);
      var w = img.width * r, h = img.height * r;
      x.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    }
    return c;
  }

  function roundRect(x, l, t, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    x.beginPath();
    x.moveTo(l + r, t);
    x.arcTo(l + w, t, l + w, t + h, r);
    x.arcTo(l + w, t + h, l, t + h, r);
    x.arcTo(l, t + h, l, t, r);
    x.arcTo(l, t, l + w, t, r);
    x.closePath();
  }

  /* Every failure path rejects, including the one where toBlob simply
     never calls back. Without the timeout a single stalled encode leaves
     the button dead and the status frozen, which is exactly what it did. */
  function toPngBytes(canvas) {
    return new Promise(function (res, rej) {
      var t = setTimeout(function () {
        rej(new Error('the ' + canvas.width + 'px render did not come back'));
      }, 10000);
      canvas.toBlob(function (b) {
        clearTimeout(t);
        if (!b) { rej(new Error('PNG encode failed at ' + canvas.width + 'px')); return; }
        b.arrayBuffer().then(function (ab) { res(new Uint8Array(ab)); }, rej);
      }, 'image/png');
    });
  }

  /* ---------- ICO container ----------
     ICONDIR, then one ICONDIRENTRY per image, then the image payloads.
     PNG payloads inside an ICO are valid and understood by every browser
     in use; the older BMP-with-AND-mask form is not worth the code. */
  function buildIco(pngs, sizes) {
    var count = pngs.length;
    var headerLen = 6 + count * 16;
    var total = headerLen + pngs.reduce(function (a, p) { return a + p.length; }, 0);
    var buf = new ArrayBuffer(total);
    var dv = new DataView(buf);
    var out = new Uint8Array(buf);
    dv.setUint16(0, 0, true);          /* reserved */
    dv.setUint16(2, 1, true);          /* type 1 = icon */
    dv.setUint16(4, count, true);
    var off = headerLen;
    for (var i = 0; i < count; i++) {
      var e = 6 + i * 16, s = sizes[i];
      out[e] = s >= 256 ? 0 : s;       /* 0 means 256 */
      out[e + 1] = s >= 256 ? 0 : s;
      out[e + 2] = 0;                  /* palette count */
      out[e + 3] = 0;                  /* reserved */
      dv.setUint16(e + 4, 1, true);    /* colour planes */
      dv.setUint16(e + 6, 32, true);   /* bits per pixel */
      dv.setUint32(e + 8, pngs[i].length, true);
      dv.setUint32(e + 12, off, true);
      out.set(pngs[i], off);
      off += pngs[i].length;
    }
    return out;
  }

  /* ---------- snippets ---------- */
  function htmlSnippet() {
    return [
      '<link rel="icon" href="/favicon.ico" sizes="any">',
      '<link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
      '<link rel="manifest" href="/site.webmanifest">'
    ].join('\n');
  }
  function manifest() {
    return JSON.stringify({
      name: state.name, short_name: state.name,
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ],
      theme_color: state.bg, background_color: state.bg, display: 'standalone'
    }, null, 2);
  }

  /* ---------- preview ---------- */
  function preview() {
    var wrap = $('fvPreview');
    if (!state.img) { wrap.innerHTML = '<p class="fv-idle">Drop a square image, ideally 512px or larger. SVG works best.</p>'; return; }
    wrap.innerHTML = '';
    [16, 32, 48, 180].forEach(function (s) {
      var c = draw(s, { forceBg: s >= 180 });
      var box = document.createElement('div');
      box.className = 'fv-chip';
      c.className = 'fv-chip-img';
      c.style.width = Math.min(s, 64) + 'px';
      c.style.height = Math.min(s, 64) + 'px';
      box.appendChild(c);
      var lab = document.createElement('span');
      lab.textContent = s + 'px';
      box.appendChild(lab);
      wrap.appendChild(box);
    });
    /* The 16px cell is where most designs die, so show it at 1:1 in a
       fake browser tab rather than scaled up into flattery. */
    var tab = document.createElement('div');
    tab.className = 'fv-tab';
    var t16 = draw(16, { forceBg: true });
    t16.className = 'fv-tab-ico';
    tab.appendChild(t16);
    var span = document.createElement('span');
    span.textContent = state.name || 'Your site';
    tab.appendChild(span);
    wrap.appendChild(tab);
    $('fvGo').disabled = false;
  }

  function loadFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      state.img = img;
      state.name = file.name.replace(/\.[^.]+$/, '') || 'icon';
      $('fvName').value = state.name;
      $('fvStatus').textContent = img.width + ' x ' + img.height + ' loaded.' +
        (img.width < 512 ? ' Under 512px, so the large icons will be upscaled.' : '');
      preview();
    };
    img.onerror = function () { $('fvStatus').textContent = 'Could not read that image.'; };
    img.src = url;
  }

  /* ---------- build the pack ---------- */
  /* Wrapped, because an async click handler that throws leaves the button
     dead and the status stuck on "Rendering..." with nothing in the
     console for the user to act on. */
  async function generate() {
    try { await generateInner(); }
    catch (err) {
      $('fvStatus').textContent = 'Could not build the pack: ' + (err && err.message ? err.message : err);
    }
  }

  async function generateInner() {
    if (!state.img) return;
    $('fvStatus').textContent = 'Rendering...';
    var zip = new JSZip();

    var total = ICO_SIZES.length + PNG_SIZES.length, done = 0;
    var step = function (what) {
      done++;
      $('fvStatus').textContent = 'Rendering ' + done + ' of ' + total + ': ' + what;
    };

    var icoPngs = [];
    for (var i = 0; i < ICO_SIZES.length; i++) {
      step(ICO_SIZES[i] + 'px for the .ico');
      icoPngs.push(await toPngBytes(draw(ICO_SIZES[i], { forceBg: true })));
    }
    zip.file('favicon.ico', buildIco(icoPngs, ICO_SIZES));

    for (var j = 0; j < PNG_SIZES.length; j++) {
      var spec = PNG_SIZES[j];
      step(spec.n);
      var bytes = await toPngBytes(draw(spec.s, { maskable: spec.maskable, forceBg: true }));
      zip.file(spec.n, bytes);
    }
    $('fvStatus').textContent = 'Packing the ZIP...';

    zip.file('site.webmanifest', manifest());
    zip.file('head-snippet.html', htmlSnippet() + '\n');
    zip.file('README.txt',
      'imgready favicon pack\n' +
      '=====================\n\n' +
      'Drop every file except this one and head-snippet.html into the root\n' +
      'of your site, then paste the contents of head-snippet.html into the\n' +
      '<head> of every page.\n\n' +
      'What each file is for:\n' +
      '  favicon.ico              browser tabs, bookmarks, Windows. Holds\n' +
      '                           16, 32 and 48px in one file.\n' +
      PNG_SIZES.map(function (p) {
        return '  ' + (p.n + '                    ').slice(0, 25) + p.why + '\n';
      }).join('') +
      '  site.webmanifest         PWA metadata. Edit the name if you like.\n\n' +
      'Generated in your browser. The source image was never uploaded.\n');

    var blob = await zip.generateAsync({ type: 'blob' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (state.name || 'favicon') + '-favicons.zip';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    $('fvStatus').textContent = 'Saved ' + a.download + ', ' +
      Math.round(blob.size / 1024) + ' KB, ' + (ICO_SIZES.length + PNG_SIZES.length) +
      ' images plus the manifest and the HTML.';
    $('fvSnippet').textContent = htmlSnippet();
    $('fvSnippetBox').hidden = false;
  }

  function init() {
    var dz = $('fvDrop'), input = $('fvInput');
    if (!dz) return;
    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      if (this.files && this.files[0]) loadFile(this.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove('is-drag'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
    });

    $('fvBg').addEventListener('input', function () { state.bg = this.value; preview(); });
    $('fvPad').addEventListener('input', function () {
      state.pad = +this.value; $('fvPadV').textContent = this.value; preview();
    });
    $('fvRadius').addEventListener('input', function () {
      state.radius = +this.value; $('fvRadiusV').textContent = this.value; preview();
    });
    $('fvTransparent').addEventListener('change', function () {
      state.transparent = this.checked; preview();
    });
    $('fvName').addEventListener('input', function () { state.name = this.value; preview(); });
    $('fvGo').addEventListener('click', generate);
    $('fvCopy').addEventListener('click', function () {
      navigator.clipboard.writeText(htmlSnippet()).then(function () {
        $('fvStatus').textContent = 'HTML copied.';
      }, function () { $('fvStatus').textContent = 'Clipboard blocked by the browser.'; });
    });
    preview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
