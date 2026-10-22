/* imgready AI upscaler worker (module worker).
 *
 * Runs a super-resolution ONNX model with ONNX Runtime Web, on WebGPU when
 * the browser has it and on WebAssembly when it does not. The image is cut
 * into fixed-size tiles with real neighbouring pixels as context (mirrored
 * only past the true image edge), each tile is upscaled, and only its
 * centre is kept, so tile borders never show.
 *
 * Models are fetched once with download progress and kept in a Cache
 * Storage bucket named outside the "imgready-" prefix, so a site deploy
 * (which clears every imgready-* cache) does not throw away 50 MB.
 *
 * In:  {type:'run', id, quality:'fast'|'best', scale:2|4, width, height, rgba}
 * Out: {type:'stage', id, text} {type:'progress', id, phase, done, total}
 *      {type:'done', id, width, height, rgba, backend, ms} {type:'error', id, message}
 */
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
const ORT_DIR = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const MODEL_CACHE = 'irmodels-v1';

const MODELS = {
  fast: { parts: ['/models/span2x-nomosuni-v1.onnx'], native: 2, tile: 256, pad: 16, bytes: 840043 },
  best: { parts: ['/models/dat2x4-realwebphoto-v1.part1', '/models/dat2x4-realwebphoto-v1.part2'],
          native: 4, tile: 192, pad: 16, bytes: 51322543 },
};

let ort = null, backend = null;
const sessions = {};

async function loadOrt() {
  if (ort) return ort;
  ort = await import(ORT_URL);
  ort.env.wasm.wasmPaths = ORT_DIR;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, (navigator.hardwareConcurrency || 2) >> 1) : 1;
  return ort;
}

async function hasWebGpu() {
  try {
    if (!('gpu' in navigator)) return false;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!a;
  } catch (e) { return false; }
}

async function fetchModel(key, id) {
  const m = MODELS[key];
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch (e) { cache = null; }
  const chunks = [];
  let done = 0;
  for (const url of m.parts) {
    let res = cache ? await cache.match(url) : null;
    if (res) {
      const b = await res.arrayBuffer(); chunks.push(new Uint8Array(b)); done += b.byteLength;
      postMessage({ type: 'progress', id, phase: 'download', done, total: m.bytes });
      continue;
    }
    res = await fetch(url);
    if (!res.ok) throw new Error('Could not download the model (' + res.status + ').');
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value); got += r.value.length;
      postMessage({ type: 'progress', id, phase: 'download', done: done + got, total: m.bytes });
    }
    const buf = new Uint8Array(got); let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    if (cache) { try { await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch (e) { /* storage full: run uncached */ } }
    chunks.push(buf); done += got;
  }
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const all = new Uint8Array(total); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return all;
}

async function getSession(key, id) {
  if (sessions[key]) return sessions[key];
  await loadOrt();
  if (backend === null) backend = (await hasWebGpu()) ? 'webgpu' : 'wasm';
  postMessage({ type: 'stage', id, text: 'Downloading the model (first time only)' });
  const bytes = await fetchModel(key, id);
  postMessage({ type: 'stage', id, text: 'Starting the model' });
  let s;
  try {
    s = await ort.InferenceSession.create(bytes, { executionProviders: [backend] });
  } catch (e) {
    if (backend !== 'webgpu') throw e;
    backend = 'wasm';
    s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  }
  sessions[key] = s;
  return s;
}

/* One model pass over planar RGB (Float32 0..1 or Uint8 0..255). Returns planar Uint8 RGB at native scale,
   which keeps a 4x result of a large photo at a quarter of the memory a float buffer would need. */
async function pass(sess, m, W, H, src, id, stepBase, stepTotal) {
  const T = m.tile, P = m.pad, S = m.native, step = T - 2 * P;
  const OW = W * S, OH = H * S, plane = OW * OH;
  const out = new Uint8ClampedArray(3 * plane);
  const k8 = (src instanceof Uint8ClampedArray) ? 1 / 255 : 1;
  const inp = new Float32Array(3 * T * T), TT = T * T, ST = T * S;
  const tx = Math.ceil(W / step), ty = Math.ceil(H / step), n = tx * ty;
  const mir = (v, L) => { if (L === 1) return 0; while (v < 0 || v >= L) { if (v < 0) v = -v; if (v >= L) v = 2 * L - v - 2; } return v; };
  let k = 0;
  for (let gy = 0; gy < ty; gy++) {
    for (let gx = 0; gx < tx; gx++) {
      const x0 = gx * step - P, y0 = gy * step - P;
      for (let y = 0; y < T; y++) {
        const sy = mir(y0 + y, H) * W;
        for (let x = 0; x < T; x++) {
          const si = sy + mir(x0 + x, W), q = y * T + x;
          inp[q] = src[si] * k8; inp[TT + q] = src[W * H + si] * k8; inp[2 * TT + q] = src[2 * W * H + si] * k8;
        }
      }
      const r = await sess.run({ input: new ort.Tensor('float32', inp, [1, 3, T, T]) });
      const o = r.output.data;
      const ox = gx * step * S, oy = gy * step * S;
      const cw = Math.min(step * S, OW - ox), ch = Math.min(step * S, OH - oy);
      for (let y = 0; y < ch; y++) {
        const row = (P * S + y) * ST + P * S, dst = (oy + y) * OW + ox;
        for (let x = 0; x < cw; x++) {
          out[dst + x] = o[row + x] * 255 + 0.5; out[plane + dst + x] = o[ST * ST + row + x] * 255 + 0.5; out[2 * plane + dst + x] = o[2 * ST * ST + row + x] * 255 + 0.5;
        }
      }
      if (r.output.dispose) r.output.dispose();
      k++;
      postMessage({ type: 'progress', id, phase: 'upscale', done: stepBase + k, total: stepTotal });
    }
  }
  return { W: OW, H: OH, data: out };
}

function tilesFor(m, W, H) { const step = m.tile - 2 * m.pad; return Math.ceil(W / step) * Math.ceil(H / step); }

/* 2x2 box average: used to bring a 4x result down to 2x. Averaging four
   model pixels is exact for a factor of two and adds no ringing. */
function halve(img) {
  const W = img.W >> 1, H = img.H >> 1, p = W * H, sp = img.W * img.H, out = new Uint8ClampedArray(3 * p);
  for (let c = 0; c < 3; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = c * sp + 2 * y * img.W + 2 * x;
    out[c * p + y * W + x] = (img.data[a] + img.data[a + 1] + img.data[a + img.W] + img.data[a + img.W + 1] + 2) >> 2;
  }
  return { W, H, data: out };
}

/* Alpha is not sent through the model: it is resampled bilinearly. */
function scaleAlpha(a, W, H, OW, OH) {
  const out = new Uint8ClampedArray(OW * OH), sx = W / OW, sy = H / OH;
  for (let y = 0; y < OH; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.min(H - 1, fy | 0), y1 = Math.min(H - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < OW; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.min(W - 1, fx | 0), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
      out[y * OW + x] = (a[y0 * W + x0] * (1 - wx) + a[y0 * W + x1] * wx) * (1 - wy) + (a[y1 * W + x0] * (1 - wx) + a[y1 * W + x1] * wx) * wy;
    }
  }
  return out;
}

async function run(msg) {
  const { id, quality, scale, width: W, height: H } = msg;
  const rgba = new Uint8ClampedArray(msg.rgba);
  const m = MODELS[quality];
  const t0 = performance.now();
  const sess = await getSession(quality, id);
  const src = new Float32Array(3 * W * H), p = W * H;
  let hasAlpha = false;
  const alpha = new Uint8ClampedArray(p);
  for (let i = 0; i < p; i++) {
    src[i] = rgba[4 * i] / 255; src[p + i] = rgba[4 * i + 1] / 255; src[2 * p + i] = rgba[4 * i + 2] / 255;
    alpha[i] = rgba[4 * i + 3]; if (alpha[i] !== 255) hasAlpha = true;
  }
  postMessage({ type: 'stage', id, text: 'Upscaling' });
  let img;
  if (m.native === 2 && scale === 4) {
    const total = tilesFor(m, W, H) + tilesFor(m, W * 2, H * 2);
    const a = await pass(sess, m, W, H, src, id, 0, total);
    img = await pass(sess, m, a.W, a.H, a.data, id, tilesFor(m, W, H), total);
  } else {
    img = await pass(sess, m, W, H, src, id, 0, tilesFor(m, W, H));
    if (m.native === 4 && scale === 2) img = halve(img);
  }
  const OW = img.W, OH = img.H, q = OW * OH;
  const out = new Uint8ClampedArray(4 * q);
  const al = hasAlpha ? scaleAlpha(alpha, W, H, OW, OH) : null;
  for (let i = 0; i < q; i++) {
    out[4 * i] = img.data[i]; out[4 * i + 1] = img.data[q + i]; out[4 * i + 2] = img.data[2 * q + i];
    out[4 * i + 3] = al ? al[i] : 255;
  }
  postMessage({ type: 'done', id, width: OW, height: OH, rgba: out.buffer, backend, ms: Math.round(performance.now() - t0) }, [out.buffer]);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg && msg.type === 'run') {
    run(msg).catch((err) => postMessage({ type: 'error', id: msg.id, message: (err && err.message) || String(err) }));
  }
};
/* UPSCALE_WORKER_EOF */
