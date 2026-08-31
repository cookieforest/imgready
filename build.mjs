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
/* Tail sentinel map — see https://github.com/anthropics/claude-code/issues/53940
   for the byte-conservation truncation bug this defends against. Every source
   file has a known, immutable trailing comment. If the comment is missing
   (or not in the last 200 bytes of the file), the build fails fast with a
   precise error before producing an unsalvageable dist/. */
const TAIL_SENTINELS = {
  'src/01-state-helpers.js':     '/* CHUNK_END:01-state-helpers v1 */',
  'src/02-decoders.js':          '/* CHUNK_END:02-decoders v1 */',
  'src/03-drop-addfiles.js':     '/* CHUNK_END:03-drop-addfiles v1 */',
  'src/04-actionbar-render.js':  '/* CHUNK_END:04-actionbar-render v1 */',
  'src/05-process-modal.js':     '/* CHUNK_END:05-process-modal v1 */',
  'src/06-fullscreen-init.js':   '/* CHUNK_END:06-fullscreen-init v1 */',
  'src/app.css':                 '/* CSS_EOF_MARKER */',
  'imgready-worker.js':          '/* WORKER_EOF */',
  'sw.js':                       '/* SW_EOF */',
  'src/home-app.js':             '/* HOME_APP_EOF */',
  'src/home-editor.js':          '/* HOME_EDITOR_EOF */',
};

function validateTailSentinels() {
  const missing = [];
  for (const [path, sentinel] of Object.entries(TAIL_SENTINELS)) {
    if (!existsSync(path)) {
      missing.push(`  ${path}: file does not exist`);
      continue;
    }
    const content = readFileSync(path, 'utf8');
    if (!content.includes(sentinel)) {
      missing.push(`  ${path}: missing tail sentinel "${sentinel}" — file likely truncated`);
      continue;
    }
    /* Sentinel must be in the last 200 bytes — protects against the case where
       Edit appends past the sentinel without removing it. */
    const tail = content.slice(-200);
    if (!tail.includes(sentinel)) {
      missing.push(`  ${path}: sentinel found but not in tail (truncation may have appended past it)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      '[imgready build] FATAL: tail sentinel check failed — file truncation detected.\n' +
      missing.join('\n') + '\n' +
      '\nRecover from canonical (raw.githubusercontent.com/cookieforest/imgready/main/<path>) ' +
      'and re-run. See https://github.com/anthropics/claude-code/issues/53940 for context.'
    );
  }
}

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
  'archive',                          /* R117: archived old versions + dev logs, not deployed */
  /* R132 — unreferenced legacy demo assets (~1.9 MB). Verified zero code
     references: demo-original.png is only named in a code comment.
     Kept in the repo, excluded from the deploy. */
  'demo-original.png', 'demo-original.jpg', 'demo-webp.webp', 'demo.jpg',
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

  /* Layer 1 defense — fails the build if any source file lost its trailing
     sentinel comment, which is the unambiguous signature of a Cowork-side
     truncation. See TAIL_SENTINELS above. */
  validateTailSentinels();

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

  /* R128 — Stage 1: the homepage app now lives in src/home-app.js (version
     controlled, no longer a hand-edited blob inside index.html). Re-inline it
     into dist/index.html so the deployed page is byte-identical (single
     request, no new render-blocking JS). */
  {
    const HOME_MARKER = '/*__HOME_APP_BUNDLE__*/';
    const distIndex = 'dist/index.html';
    if (existsSync(distIndex) && existsSync('src/home-app.js')) {
      const bundle = readFileSync('src/home-app.js', 'utf8').replace(/\n\/\* HOME_APP_EOF \*\/\s*$/, '');
      const html = readFileSync(distIndex, 'utf8');
      if (html.indexOf(HOME_MARKER) === -1) {
        console.warn('[imgready build] WARN: home-app marker not found in index.html');
      } else {
        writeFileSync(distIndex, html.replace(HOME_MARKER, () => bundle));
        console.log('[imgready build] inlined src/home-app.js into dist/index.html (' + bundle.length + 'B)');
      }
    }
  }

  /* R129 — Stage 2: ship the lazy editor as a standalone chunk (not inlined),
     fetched on first Edit click. */
  if (existsSync('src/home-editor.js')) {
    copyFileSync('src/home-editor.js', 'dist/home-editor.js');
    console.log('[imgready build] editor chunk -> dist/home-editor.js (' + statSync('dist/home-editor.js').size + 'B)');
  }

  /* Substitute the service worker's CACHE_VERSION with the current
     deployment SHA so users always pull a fresh worker on each deploy.
     CF_PAGES_COMMIT_SHA is auto-injected by Cloudflare Pages at build
     time (per CF docs). Locally we fall back to a timestamp so dev
     reloads still bust the cache. */
  const swPath = 'dist/sw.js';
  if (existsSync(swPath)) {
    /* Workers Builds: WORKERS_CI_COMMIT_SHA per official docs at
       https://developers.cloudflare.com/workers/ci-cd/builds/configuration
       Pages (legacy fallback): CF_PAGES_COMMIT_SHA. GitHub Actions:
       GITHUB_SHA. Local dev: timestamp so SW reloads each rebuild. */
    const sha = process.env.WORKERS_CI_COMMIT_SHA
             || process.env.CF_PAGES_COMMIT_SHA
             || process.env.GITHUB_SHA
             || `dev-${Date.now()}`;
    const tag = sha.slice(0, 12);
    const swSrc = readFileSync(swPath, 'utf8');
    const swOut = swSrc.replace(
      /const CACHE_VERSION = '[^']+';/,
      `const CACHE_VERSION = 'imgready-${tag}';`
    );
    if (swSrc === swOut) {
      console.warn('[imgready build] WARN: CACHE_VERSION pattern not found in sw.js — substitution skipped');
    } else {
      writeFileSync(swPath, swOut);
      console.log(`[imgready build] sw.js CACHE_VERSION → imgready-${tag}`);
    }
  }

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
