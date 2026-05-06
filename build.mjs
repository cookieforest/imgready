/**
 * imgready build pipeline.
 *
 * Phase 4 layout:
 *   src/01-state-helpers.js        ┐
 *   src/02-decoders.js             │
 *   src/03-drop-addfiles.js        │  ordered chunks of one big IIFE.
 *   src/04-actionbar-render.js     │  Concatenated in alphabetical order
 *   src/05-process-modal.js        │  to reproduce the canonical app.js
 *   src/06-fullscreen-init.js      ┘  byte-for-byte.
 *   src/app.css                       stylesheet
 *
 * Why six numbered files instead of N ES modules: this is what unblocks
 * stability NOW. The closure-scoped IIFE the existing code uses can't
 * become real ES modules without semantic refactoring (closure-shared
 * `var images = []`, `var selectedFormat`, etc. all need export plumbing).
 * That refactor is real work — Phase 5+. Meanwhile, splitting the source
 * into ordered chunks under the file-system truncation threshold solves
 * the recurring "app.js comes back smaller" issue without changing one
 * byte of behaviour.
 *
 * Each chunk is well under any plausible threshold (largest ≈49 KB; the
 * thing that's been truncating us hits at ~188 KB).
 *
 * Outputs:
 *   1. dist/        — full servable site (what Phase 3 will switch CF to)
 *      dist/app.js     minified bundle (single classic IIFE)
 *      dist/app.css    verbatim
 *      dist/app.js.map source map
 *      dist/<all static files mirrored from root>
 *   2. app.js, app.css at root — concatenated (unminified) source, what
 *      the current CF deploy serves. Phase 3 deletes these once CF is
 *      pointed at ./dist.
 *
 * Workflow:
 *   - Edit src/0N-*.js (each <50 KB, safe)
 *   - npm run build    (concatenates → root/app.js, bundles → dist/app.js)
 *   - git commit src/* + the regenerated root/app.js
 *   - CI re-runs the build and verifies round-trip
 */
import * as esbuild from 'esbuild';
import {
  existsSync, mkdirSync, copyFileSync, readdirSync, statSync,
  rmSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

/* Discover ordered source chunks. Sort alphabetically — naming convention
   01-, 02-, … guarantees correct load order without a manifest. */
function findChunks() {
  const chunks = readdirSync('src')
    .filter(f => /^\d{2}-.+\.js$/.test(f))
    .sort();
  if (chunks.length === 0) {
    /* Phase 2 fallback: legacy single-file source. */
    if (existsSync('src/index.js')) return ['index.js'];
    if (existsSync('src/app.js')) return ['app.js'];
    throw new Error('No source files found in src/');
  }
  return chunks;
}

function concatenateChunks(chunks) {
  return chunks
    .map(name => readFileSync(join('src', name), 'utf8'))
    .join('');
}

const CSS_ENTRY = existsSync('src/app.css') ? 'src/app.css' : 'app.css';

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

async function buildOnce() {
  const start = Date.now();

  const chunks = findChunks();
  const concatenated = concatenateChunks(chunks);

  /* 1. Write the concatenated source to root/app.js — current CF deploy
        serves this. Identical bytes to the historical hand-edited file
        when chunks 01..06 are concatenated in order. */
  writeFileSync('app.js', concatenated);
  copyFileSync(CSS_ENTRY, 'app.css');

  /* 2. Wipe dist/ and rebuild it. Used by Phase 3 once CF is repointed. */
  if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });
  mkdirSync('dist');

  /* esbuild bundles + minifies the concatenated source for dist/. We feed
     it root/app.js (just written above) so we don't need a temp file. */
  await esbuild.build({
    entryPoints: ['app.js'],
    bundle: true,
    format: 'iife',
    target: 'es2018',
    minify: true,
    sourcemap: true,
    outfile: 'dist/app.js',
    legalComments: 'none',
    keepNames: true,
  });
  copyFileSync(CSS_ENTRY, 'dist/app.css');
  mirrorDir('.', 'dist');

  console.log(
    `[imgready build] ${chunks.length} chunks → root/app.js (${concatenated.length}B) + dist/app.js (${statSync('dist/app.js').size}B minified) in ${Date.now() - start}ms`
  );
}

if (watch) {
  /* Watch mode: rebuild on any src change. Re-run buildOnce — fast enough. */
  const fs = await import('node:fs');
  console.log('[imgready build] watching src/…');
  await buildOnce();
  fs.watch('src', { recursive: true }, async (event, filename) => {
    if (!filename) return;
    try {
      await buildOnce();
    } catch (e) {
      console.error('[imgready build] error:', e.message);
    }
  });
} else {
  await buildOnce();
}
