/**
 * imgready build pipeline.
 *
 * Phase 3 — Cloudflare serves ./dist exclusively. Source lives in src/
 * (six ordered chunks, see Phase 4 commit), build concatenates +
 * bundles + mirrors static files into ./dist.
 *
 * Source layout:
 *   src/01-state-helpers.js        ┐
 *   src/02-decoders.js             │  Concatenated in alphabetical
 *   src/03-drop-addfiles.js        │  order to reproduce one big IIFE.
 *   src/04-actionbar-render.js     │  Each chunk is well under the
 *   src/05-process-modal.js        │  ~188 KB truncation threshold.
 *   src/06-fullscreen-init.js      ┘
 *   src/app.css                       stylesheet
 *
 * Output (everything Cloudflare serves):
 *   dist/app.js       minified bundle (single classic IIFE)
 *   dist/app.css      verbatim
 *   dist/app.js.map   source map
 *   dist/<all static files mirrored from root>
 *
 * Why six numbered files instead of N ES modules: the closure-scoped IIFE
 * the existing code uses can't become real ES modules without semantic
 * refactoring (closure-shared `var images = []`, `var selectedFormat`,
 * etc. all need export plumbing). That refactor is real work — Phase 5.
 * Meanwhile, splitting source into ordered chunks under the truncation
 * threshold solves the "app.js comes back smaller" issue without
 * changing one byte of behaviour.
 *
 * Local workflow:
 *   - Edit src/0N-*.js (each <50 KB, safe)
 *   - npm run build       (regenerates dist/ in <100ms)
 *   - npm run dev         (watch mode, alias of build:watch)
 *   - git commit src/* + the regenerated dist/
 *
 * CI workflow:
 *   GitHub Actions (.github/workflows/check.yml) runs npm ci + npm run
 *   build on every push, validates the bundle compiles cleanly,
 *   diff-checks src/* against the committed dist/. Cloudflare's deploy
 *   independently runs npm ci + npm run build per wrangler.toml's
 *   [build].command, so the served bundle is always fresh from src/.
 */
import * as esbuild from 'esbuild';
import {
  existsSync, mkdirSync, copyFileSync, readdirSync, statSync,
  rmSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

/* Discover ordered source chunks. Sort alphabetically — the 01-, 02-, …
   prefix guarantees correct load order without an explicit manifest. */
function findChunks() {
  const chunks = readdirSync('src')
    .filter(f => /^\d{2}-.+\.js$/.test(f))
    .sort();
  if (chunks.length === 0) throw new Error('No source chunks found in src/');
  return chunks;
}

function concatenateChunks(chunks) {
  return chunks
    .map(name => readFileSync(join('src', name), 'utf8'))
    .join('');
}

const CSS_ENTRY = 'src/app.css';

const COPY_EXCLUDE = new Set([
  'node_modules', '.git', '.github', 'src', 'dist',
  'package.json', 'package-lock.json', 'build.mjs', '.gitignore',
  'wrangler.toml',
  'app.js', 'app.css',                /* Phase 3: removed; mirrorDir won't see them */
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

  /* Wipe dist/ on full builds so deleted files don't linger. */
  if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });
  mkdirSync('dist');

  /* Write the concatenated source to a temp path, then bundle from it.
     We don't keep the temp on disk — only dist/app.js (minified) is the
     served artifact. */
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

  /* Remove the temp concat now that bundling is done. */
  rmSync(tmpEntry);

  copyFileSync(CSS_ENTRY, 'dist/app.css');
  mirrorDir('.', 'dist');

  console.log(
    `[imgready build] ${chunks.length} chunks (${concatenated.length}B src) → dist/app.js (${statSync('dist/app.js').size}B minified) + ${readdirSync('dist').length} static entries in ${Date.now() - start}ms`
  );
}

if (watch) {
  /* Watch mode: rebuild on any src change. fs.watch with recursive is
     macOS/Windows-only; on Linux we'd need a workaround, but the repo's
     primary author works on macOS so this is fine. */
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
