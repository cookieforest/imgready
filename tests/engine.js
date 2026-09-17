/* imgready engine regression suite.
 *
 * Every case here is a behaviour that was once wrong. The engine has a
 * recurring failure mode — it produces a file of the WRONG KIND and reports
 * success — so almost every assertion checks the actual bytes rather than a
 * label: magic numbers, ICO directory entries, decoded frame counts.
 *
 * Runs against the real worker over HTTP. Fixtures are generated in-browser
 * so the suite has no binary dependencies.
 *
 * Open /tests/ and press Run, or drive it headlessly:
 *     await window.IMGREADY_TESTS.run()   ->  { passed, failed, results }
 */
(function () {
  const WORKER = '/imgready-worker.js';

  /* ---------- tiny assertion harness ---------- */
  const suite = [];
  const test = (name, fn, opts = {}) => suite.push({ name, fn, slow: !!opts.slow });
  function assert(cond, msg) { if (!cond) throw new Error(msg); }
  function eq(actual, expected, what) {
    if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
  }

  /* ---------- worker drivers ---------- */
  function runWorker(msg, transfer) {
    return new Promise((resolve, reject) => {
      const w = new Worker(WORKER);
      const t = setTimeout(() => { w.terminate(); reject(new Error('worker timed out after 60s')); }, 60000);
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'gif-diag' || d.type === 'progress') return;
        clearTimeout(t); w.terminate();
        if (d.type === 'error') reject(new Error(d.message));
        else resolve(d);
      };
      w.onerror = (ev) => { clearTimeout(t); w.terminate(); reject(new Error(String(ev.message || ev))); };
      w.postMessage(msg, transfer || []);
    });
  }
  const encode = (file, fmt, settings = {}) =>
    runWorker({ id: 1, action: 'process', file, fmt, settings });
  const encodeFrames = (frames, outW, outH, delaysUs, fmt, settings = {}) => {
    const copies = frames.map((b) => b.slice(0));
    return runWorker({ id: 1, action: 'process-frames', fmt, settings,
      frames: copies, outW, outH, delaysUs, loop: 0 }, copies);
  };

  /* ---------- byte inspection ---------- */
  async function magic(blob) {
    const u = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const hex = [...u].map((v) => v.toString(16).padStart(2, '0')).join(' ');
    if (hex.startsWith('89 50 4e 47')) return 'PNG';
    if (hex.startsWith('47 49 46 38')) return 'GIF';
    if (hex.startsWith('00 00 01 00')) return 'ICO';
    if (hex.startsWith('ff d8 ff')) return 'JPEG';
    if (hex.startsWith('52 49 46 46')) return 'WEBP';
    if (u[4] === 0x66 && u[5] === 0x74 && u[6] === 0x79 && u[7] === 0x70) return 'AVIF';
    return 'UNKNOWN(' + hex + ')';
  }
  async function frameCount(blob, type) {
    if (typeof ImageDecoder !== 'function') return null;
    const d = new ImageDecoder({ data: new Uint8Array(await blob.arrayBuffer()), type });
    await d.completed;
    await new Promise((r) => setTimeout(r, 120));
    return d.tracks[0] ? d.tracks[0].frameCount : null;
  }
  /* Parse an ICO directory. The old encoder wrote a header claiming
     256x256 in front of a 2400x1600 payload, so both halves are checked. */
  async function icoEntries(blob) {
    const u = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(u.buffer);
    const n = dv.getUint16(4, true);
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = 6 + i * 16;
      const off = dv.getUint32(o + 12, true), len = dv.getUint32(o + 8, true);
      const p = u.slice(off, off + len);
      const pd = new DataView(p.buffer, p.byteOffset);
      out.push({
        declared: u[o] === 0 ? 256 : u[o],
        payload: p[0] === 0x89 ? pd.getUint32(16, false) : null,
        payloadH: p[0] === 0x89 ? pd.getUint32(20, false) : null,
      });
    }
    return out;
  }

  /* ---------- fixtures ---------- */
  async function solid(w, h, colour, type = 'image/png') {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.fillStyle = colour; x.fillRect(0, 0, w, h);
    const ext = type.split('/')[1].replace('jpeg', 'jpg');
    return new File([await c.convertToBlob({ type })], `s.${ext}`, { type });
  }
  async function photo(w, h, type = 'image/jpeg') {
    const img = await createImageBitmap(await (await fetch('/samples/demo_2.jpg')).blob());
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.drawImage(img, 0, 0, w, h);
    const ext = type.split('/')[1].replace('jpeg', 'jpg');
    return new File([await c.convertToBlob({ type, quality: 0.92 })], `p.${ext}`, { type });
  }
  let _gifenc = null;
  async function gifenc() {
    if (!_gifenc) _gifenc = await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm');
    return _gifenc;
  }
  async function animatedGif(frames, w, h, photographic) {
    const m = await gifenc();
    const e = m.GIFEncoder();
    const img = photographic
      ? await createImageBitmap(await (await fetch('/samples/demo_2.jpg')).blob()) : null;
    for (let i = 0; i < frames; i++) {
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
      if (img) x.drawImage(img, i * 40, i * 20, 900, 675, 0, 0, w, h);
      else { x.fillStyle = `hsl(${(i * 40) % 360} 70% 50%)`; x.fillRect(0, 0, w, h); }
      const d = x.getImageData(0, 0, w, h).data;
      const pal = m.quantize(d, 256);
      e.writeFrame(m.applyPalette(d, pal), w, h, { palette: pal, delay: 100 });
    }
    e.finish();
    return new File([e.bytes()], 'anim.gif', { type: 'image/gif' });
  }
  /* A JPEG carrying EXIF Orientation=6 (rotate 90 CW). */
  async function exifRotatedJpeg(w, h) {
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.fillStyle = '#e33'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#33e'; x.fillRect(0, 0, w >> 1, h);
    const base = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    const tiff = [0x49,0x49,0x2a,0x00, 0x08,0,0,0, 0x01,0x00,
                  0x12,0x01, 0x03,0x00, 0x01,0,0,0, 6,0,0,0, 0,0,0,0];
    const payload = [0x45,0x78,0x69,0x66,0x00,0x00, ...tiff];
    const len = payload.length + 2;
    const app1 = [0xff,0xe1,(len>>8)&0xff,len&0xff, ...payload];
    const out = new Uint8Array(2 + app1.length + base.length - 2);
    out.set(base.slice(0,2),0); out.set(app1,2); out.set(base.slice(2), 2+app1.length);
    return new File([out], 'rot.jpg', { type: 'image/jpeg' });
  }
  async function videoFrames(seconds, w, h) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    const mime = ['video/mp4','video/webm;codecs=vp9','video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) throw new Error('MediaRecorder cannot produce a test clip here');
    const rec = new MediaRecorder(cv.captureStream(30), { mimeType: mime, videoBitsPerSecond: 1_500_000 });
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start();
    let t = 0;
    const timer = setInterval(() => {
      t += 1/30;
      cx.fillStyle = `hsl(${(t*90)%360} 70% 45%)`; cx.fillRect(0,0,w,h);
      cx.fillStyle = '#fff'; cx.font = 'bold 48px sans-serif'; cx.fillText(t.toFixed(2)+'s', 20, h/2);
    }, 1000/30);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(timer); rec.stop(); await stopped;
    const file = new File([new Blob(chunks, { type: mime })], 'clip.mp4', { type: mime.split(';')[0] });

    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('fixture video unreadable')); });
    const step = 0.1, n = Math.min(40, Math.max(1, Math.floor(v.duration / step)));
    const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
    const x2 = c2.getContext('2d', { willReadFrequently: true });
    const bufs = [], delaysUs = [];
    for (let i = 0; i < n; i++) {
      await new Promise((r) => { const on = () => { v.removeEventListener('seeked', on); r(); };
        v.addEventListener('seeked', on); v.currentTime = Math.min(v.duration - 0.001, i * step); });
      x2.drawImage(v, 0, 0, w, h);
      bufs.push(x2.getImageData(0, 0, w, h).data.buffer);
      delaysUs.push(100000);
    }
    URL.revokeObjectURL(url);
    return { file, bufs, delaysUs, w, h };
  }

  /* =====================================================================
     CASES — each one is a bug that shipped once
     ===================================================================== */

  test('every output format returns that format, not a lookalike', async () => {
    /* canvas.toBlob silently falls back to PNG for image/gif and
       image/x-icon, so a label is not evidence. */
    const src = await photo(300, 200);
    const want = { webp:'WEBP', avif:'AVIF', jpg:'JPEG', png:'PNG', gif:'GIF', ico:'ICO' };
    for (const [fmt, expected] of Object.entries(want)) {
      const { blob } = await encode(src, fmt);
      eq(await magic(blob), expected, `${fmt} output`);
    }
  });

  test('ICO is multi-size and its directory matches its payloads', async () => {
    /* Shipped broken: one entry, header claiming 256x256 in front of a
       2400x1600 non-square PNG, 3.86 MB. */
    const { blob } = await encode(await photo(1200, 800), 'ico');
    const entries = await icoEntries(blob);
    assert(entries.length >= 2, `expected a multi-size icon, got ${entries.length} entry`);
    assert(blob.size < 100 * 1024, `icon should be small, got ${Math.round(blob.size/1024)} KB`);
    for (const e of entries) {
      eq(e.payload, e.declared, 'ICO directory width vs payload width');
      eq(e.payloadH, e.declared, 'ICO directory height vs payload height');
      assert(e.declared <= 256, `ICO entry ${e.declared}px exceeds the 256 the format allows`);
    }
  });

  test('ICO never upscales past the source', async () => {
    const entries = await icoEntries((await encode(await solid(20, 20, '#3a7'), 'ico')).blob);
    for (const e of entries) assert(e.declared <= 20, `upscaled to ${e.declared}px from a 20px source`);
  });

  test('animated GIF keeps its frames as GIF', async () => {
    const src = await animatedGif(6, 120, 80);
    const { blob } = await encode(src, 'gif');
    eq(await frameCount(blob, 'image/gif'), 6, 'GIF frame count');
  });

  test('animated GIF becomes an animated WebP', async () => {
    /* Was a single still while the page claimed otherwise. */
    const { blob } = await encode(await animatedGif(6, 120, 80), 'webp');
    eq(await magic(blob), 'WEBP', 'format');
    eq(await frameCount(blob, 'image/webp'), 6, 'WebP frame count');
  });

  test('animated WebP input keeps its frames (webp and gif out)', async () => {
    /* Re-compressing an animated WebP used to flatten it to one frame. */
    const gif = await animatedGif(5, 120, 80);
    const animWebp = new File([(await encode(gif, 'webp')).blob], 'a.webp', { type: 'image/webp' });
    eq(await frameCount((await encode(animWebp, 'webp')).blob, 'image/webp'), 5, 'webp -> webp frames');
    eq(await frameCount((await encode(animWebp, 'gif')).blob, 'image/gif'), 5, 'webp -> gif frames');
  });

  test('animation is dropped only for formats that cannot hold it', async () => {
    const src = await animatedGif(6, 120, 80);
    for (const [fmt, type] of [['png','image/png'], ['jpg','image/jpeg']]) {
      const { blob } = await encode(src, fmt);
      eq(await frameCount(blob, type), 1, `${fmt} should be a still`);
    }
  });

  test('target size is respected for jpg, webp and avif', async () => {
    const src = await photo(1600, 1200);
    for (const fmt of ['jpg', 'webp', 'avif']) {
      for (const kb of [50, 150]) {
        const { blob } = await encode(src, fmt, { targetKb: kb });
        assert(blob.size <= kb * 1024,
          `${fmt} @${kb}KB came back ${(blob.size/1024).toFixed(1)}KB — over budget`);
      }
    }
  });

  test('target size is respected for animated GIF', async () => {
    const src = await animatedGif(12, 400, 300, true);
    for (const kb of [300, 150]) {
      const { blob } = await encode(src, 'gif', { targetKb: kb });
      assert(blob.size <= kb * 1024,
        `GIF @${kb}KB came back ${(blob.size/1024).toFixed(1)}KB — over budget`);
      assert(await frameCount(blob, 'image/gif') >= 2, 'should still be animated');
    }
  });

  test('an unreachable GIF target returns the floor, not a failure', async () => {
    const { blob } = await encode(await animatedGif(12, 400, 300, true), 'gif', { targetKb: 5 });
    eq(await magic(blob), 'GIF', 'still a GIF');
    assert(blob.size > 0, 'should return the smallest achievable result');
  });

  test('WebP past 16383px explains itself', async () => {
    /* Used to surface libwebp's bare "Encoding error." */
    let msg = '';
    try { await encode(await solid(16384, 4, '#c33'), 'webp'); }
    catch (e) { msg = e.message; }
    assert(/16383/.test(msg), `message should name the limit, got: ${msg}`);
    assert(/AVIF|PNG|JPG/i.test(msg), `message should suggest a format that works, got: ${msg}`);
  });

  test('WebP at exactly 16383px still encodes', async () => {
    const { blob } = await encode(await solid(16383, 4, '#c33'), 'webp');
    eq(await magic(blob), 'WEBP', 'boundary case');
  });

  test('a resize below the limit lets oversized WebP through', async () => {
    const { blob } = await encode(await solid(17000, 40, '#c33'), 'webp', { maxDim: 1920 });
    eq(await magic(blob), 'WEBP', 'resized output');
  });

  test('transparency composites white into JPG, not black', async () => {
    const c = new OffscreenCanvas(40, 40), x = c.getContext('2d');
    x.clearRect(0, 0, 40, 40); x.fillStyle = 'rgb(0,0,255)'; x.fillRect(0, 0, 20, 40);
    const src = new File([await c.convertToBlob({ type: 'image/png' })], 'a.png', { type: 'image/png' });
    const { blob } = await encode(src, 'jpg');
    const bmp = await createImageBitmap(blob);
    const cc = new OffscreenCanvas(40, 40), xx = cc.getContext('2d');
    xx.drawImage(bmp, 0, 0);
    const p = xx.getImageData(30, 20, 1, 1).data;
    assert(p[0] > 200 && p[1] > 200 && p[2] > 200,
      `transparent area became rgb(${p[0]},${p[1]},${p[2]}), expected near-white`);
  });

  test('EXIF orientation is baked into every output', async () => {
    const src = await exifRotatedJpeg(80, 40);   /* displays as 40x80 */
    for (const fmt of ['jpg', 'png', 'webp']) {
      const { blob } = await encode(src, fmt);
      const bmp = await createImageBitmap(blob);
      eq(`${bmp.width}x${bmp.height}`, '40x80', `${fmt} orientation`);
    }
  });

  test('undecodable input fails with a readable message', async () => {
    const junk = [
      new File([new Uint8Array(0)], 'empty.jpg', { type: 'image/jpeg' }),
      new File([new TextEncoder().encode('not an image')], 'fake.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([0x89,0x50,0x4e,0x47,0,0,0,0])], 'trunc.png', { type: 'image/png' }),
    ];
    for (const f of junk) {
      let msg = null;
      try { await encode(f, 'webp'); } catch (e) { msg = e.message; }
      assert(msg, `${f.name} should have failed`);
      assert(!/undefined|\[object|null/i.test(msg), `unhelpful message for ${f.name}: ${msg}`);
    }
  });

  test('extreme geometry survives', async () => {
    for (const [w, h] of [[1,1], [1,2000], [2000,1]]) {
      const { blob } = await encode(await solid(w, h, '#37a'), 'webp');
      eq(await magic(blob), 'WEBP', `${w}x${h}`);
    }
  });

  test('video frames animate as GIF and WebP', async () => {
    const v = await videoFrames(2, 240, 180);
    for (const [fmt, type] of [['gif','image/gif'], ['webp','image/webp']]) {
      const { blob } = await encodeFrames(v.bufs, v.w, v.h, v.delaysUs, fmt);
      eq(await magic(blob), fmt === 'gif' ? 'GIF' : 'WEBP', `${fmt} format`);
      assert(await frameCount(blob, type) > 1, `${fmt} should be animated`);
    }
  }, { slow: true });

  test('video to a still format gives that format, not a GIF', async () => {
    /* The first cut returned GIF for anything that was not WebP. */
    const v = await videoFrames(1.5, 200, 150);
    for (const [fmt, expected] of [['png','PNG'], ['jpg','JPEG'], ['avif','AVIF']]) {
      const { blob } = await encodeFrames(v.bufs, v.w, v.h, v.delaysUs, fmt);
      eq(await magic(blob), expected, `video -> ${fmt}`);
    }
  }, { slow: true });

  /* ---------- runner ---------- */
  async function run(opts = {}) {
    const includeSlow = opts.slow !== false;
    const results = [];
    for (const t of suite) {
      if (t.slow && !includeSlow) { results.push({ name: t.name, status: 'skipped' }); continue; }
      const started = performance.now();
      try {
        await t.fn();
        results.push({ name: t.name, status: 'pass', ms: Math.round(performance.now() - started) });
      } catch (e) {
        results.push({ name: t.name, status: 'FAIL', ms: Math.round(performance.now() - started),
                       error: e && e.message ? e.message : String(e) });
      }
      if (opts.onResult) opts.onResult(results[results.length - 1]);
    }
    const passed = results.filter((r) => r.status === 'pass').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    return { passed, failed, skipped: results.length - passed - failed, results };
  }

  window.IMGREADY_TESTS = { run, count: suite.length, names: suite.map((t) => t.name) };
})();
