import * as esbuild from 'esbuild';
import {
  existsSync, mkdirSync, copyFileSync, readdirSync, statSync,
  rmSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

function findChunks() {
  const chunks = readdirSync('src')
    .filter(f => /^\d{2}-.+\.js$/.test(f))
    .sort();
  if (chunks.length === 0) throw new Error('No source chunks found in src/');
  return chunks;
}

function concatenateChunks(chunks) {
  return chunks.map(name => readFileSync(join('src', name), 'utf8')).join('');
}

const CSS_ENTRY = 'src/app.css';

const COPY_EXCLUDE = new Set([
  'node_modules', '.git', '.github', 'src', 'dist',
  'package.json', 'package-lock.json', 'build.mjs', '.gitignore',
  'wrangler.toml',
  'app.js', 'app.css',
  'index.html.bak', 'index.html.broken_truncated',
]);

function shouldCopy(entry) {
  if (COPY_EXCLUDE.has(entry)) return false;
  if (entry.startsWith('.')) return false;
  if (entry.endsWith('.bak') || entry.endsWith('.broken_truncated') || entry.endsWith('.patch')) return false;
  return true;
}

function mirrorDir(src, dst) {
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (src === '.' && !shouldCopy(entry)) continue;
    const sp = join(src, entry);
    const dp = join(dst, entry);
    const st = statSync(sp);
    if (st.isDirectory()) mirrorDir(sp, dp);
    else copyFileSync(sp, dp);
  }
}

async function bundleMainApp() {
  const chunks = findChunks();
  const concatenated = concatenateChunks(chunks);
  const tmpEntry = 'dist/_concat.js';
  writeFileSync(tmpEntry, concatenated);
  await esbuild.build({
    entryPoints: [tmpEntry],
    bundle: true,
    format: 'iife',
    target: 'es2018',
    minify: true,
    sourcemap: true,
    outfile: 'dist/app.js',
    legalComments: 'none',
    keepNames: true,
  });
  rmSync(tmpEntry);
  return { chunks, sourceBytes: concatenated.length };
}

async function bundleJsquash() {
  /* Bundle each jsquash entry as an ES module; copy WASM sidecars
     into the same directory. Bundled .mjs uses `new URL('xyz.wasm',
     import.meta.url)` which resolves to /vendor/jsquash/xyz.wasm
     when the .mjs is served from /vendor/jsquash/. */
  await esbuild.build({
    entryPoints: {
      'webp':   'src/jsquash-entries/webp.js',
      'avif':   'src/jsquash-entries/avif.js',
      'jpeg':   'src/jsquash-entries/jpeg.js',
      'oxipng': 'src/jsquash-entries/oxipng.js',
    },
    bundle: true,
    format: 'esm',
    target: 'es2018',
    minify: true,
    outdir: 'dist/vendor/jsquash',
    outExtension: { '.js': '.mjs' },
    legalComments: 'none',
  });
  const wasmFiles = [
    ['node_modules/@jsquash/webp/codec/enc/webp_enc.wasm',         'webp_enc.wasm'],
    ['node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm',    'webp_enc_simd.wasm'],
    ['node_modules/@jsquash/avif/codec/enc/avif_enc.wasm',         'avif_enc.wasm'],
    ['node_modules/@jsquash/avif/codec/enc/avif_enc_mt.wasm',      'avif_enc_mt.wasm'],
    ['node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm',      'mozjpeg_enc.wasm'],
    ['node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm', 'squoosh_oxipng_bg.wasm'],
  ];
  for (const [from, to] of wasmFiles) {
    if (!existsSync(from)) continue;
    copyFileSync(from, join('dist/vendor/jsquash', to));
  }
}

async function buildOnce() {
  const start = Date.now();
  if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });
  mkdirSync('dist');

  const main = await bundleMainApp();
  await bundleJsquash();
  copyFileSync(CSS_ENTRY, 'dist/app.css');
  mirrorDir('.', 'dist');

  const jsquashFiles = readdirSync('dist/vendor/jsquash');
  console.log(
    `[imgready build] ${main.chunks.length} chunks (${main.sourceBytes}B src) → dist/app.js (${statSync('dist/app.js').size}B minified)`+
    ` + ${jsquashFiles.length} jsquash assets + ${readdirSync('dist').length} static entries in ${Date.now() - start}ms`
  );
}

if (watch) {
  const fs = await import('node:fs');
  console.log('[imgready build] watching src/…');
  await buildOnce();
  fs.watch('src', { recursive: true }, async () => {
    try { await buildOnce(); } catch (e) { console.error('[imgready build] error:', e.message); }
  });
} else {
  await buildOnce();
}
