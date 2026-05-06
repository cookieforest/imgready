/**
 * imgready build pipeline.
 *
 * Phase 2 layout:
 *   src/app.js   → canonical JS source (will become src/index.js + modules in Phase 3)
 *   src/app.css  → stylesheet
 *
 * Outputs (Phase 2):
 *   1. dist/        — full servable site (Phase 3 will switch Cloudflare to serve this)
 *      dist/app.js     minified bundle (single classic IIFE)
 *      dist/app.css    verbatim
 *      dist/app.js.map source map
 *      dist/<all static files mirrored from root>
 *   2. app.js, app.css at root — direct (unminified) copies of src/* so the
 *      existing Cloudflare static-asset pipeline (which still serves "./")
 *      keeps working without any deploy config change. Phase 3 deletes
 *      these once CF is pointed at ./dist.
 *
 * Workflow:
 *   - Edit src/app.js
 *   - npm run build   (regenerates root copies + dist/ in <100ms)
 *   - git commit src/app.js + the regenerated root files
 *   - CI validates the build round-trips
 */
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

const JS_ENTRY = existsSync('src/index.js') ? 'src/index.js'
              : existsSync('src/app.js')   ? 'src/app.js'
              : 'app.js';                /* legacy fallback only */
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

const jsBundleOptions = {
  entryPoints: [JS_ENTRY],
  bundle: true,
  format: 'iife',
  target: 'es2018',
  minify: true,
  sourcemap: true,
  outfile: 'dist/app.js',
  legalComments: 'none',
  keepNames: true,
};

async function buildOnce() {
  const start = Date.now();
  /* Clean dist/ on full builds so deleted files don't linger. */
  if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });
  mkdirSync('dist');
  await esbuild.build(jsBundleOptions);
  copyFileSync(CSS_ENTRY, 'dist/app.css');
  mirrorDir('.', 'dist');
  /* Phase 2 compatibility: also write src/* directly to root so the
     existing Cloudflare deploy (still serving "./") keeps working. */
  const srcJs = readFileSync(JS_ENTRY, 'utf8');
  writeFileSync('app.js', srcJs);
  copyFileSync(CSS_ENTRY, 'app.css');
  console.log(`[imgready build] ${JS_ENTRY} → dist/app.js (${(jsBundleOptions.minify ? 'minified' : 'verbose')}) + root/app.js (verbatim) + ${readdirSync('dist').length} static entries in ${Date.now() - start}ms`);
}

if (watch) {
  copyFileSync(CSS_ENTRY, 'dist/app.css');
  mirrorDir('.', 'dist');
  const ctx = await esbuild.context(jsBundleOptions);
  await ctx.watch();
  console.log(`[imgready build] watching ${JS_ENTRY}…`);
} else {
  await buildOnce();
}
