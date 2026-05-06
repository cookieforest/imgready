/**
 * imgready build pipeline.
 *
 * Goal: take src/index.js (or, in the bootstrap phase before the module split,
 * just app.js) and emit dist/app.js as a single classic IIFE bundle. Same
 * shape the existing index.html <script src="/app.js"> tag expects, so no
 * HTML changes are required when we swap origin from /app.js to /dist/app.js.
 *
 * Bootstrap mode: until src/index.js exists, treat the legacy app.js as the
 * entry point. Once src/index.js shows up, switch to that automatically.
 */
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');

const SRC_ENTRY = 'src/index.js';
const LEGACY_ENTRY = 'app.js';
const entryPoint = existsSync(SRC_ENTRY) ? SRC_ENTRY : LEGACY_ENTRY;

if (!existsSync('dist')) mkdirSync('dist');

/** Common esbuild options shared between JS bundle + CSS copy. */
const jsOptions = {
  entryPoints: [entryPoint],
  bundle: true,
  format: 'iife',
  target: 'es2018',
  minify: true,
  sourcemap: true,
  outfile: 'dist/app.js',
  legalComments: 'none',
  /* Keep variable names for grepping in production reports — minified output
     is fine but stack traces stay legible. */
  keepNames: true,
};

async function buildOnce() {
  const start = Date.now();
  await esbuild.build(jsOptions);
  /* Pass-through copy for app.css. esbuild can bundle CSS but our css is
     authored without imports — simpler to copy verbatim. */
  if (existsSync('app.css')) copyFileSync('app.css', 'dist/app.css');
  console.log(`[imgready build] entry=${entryPoint} → dist/app.js in ${Date.now() - start}ms`);
}

if (watch) {
  const ctx = await esbuild.context(jsOptions);
  await ctx.watch();
  console.log(`[imgready build] watching ${entryPoint}…`);
} else {
  await buildOnce();
}
