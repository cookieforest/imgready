/* Static site invariants — no browser, so CI can run them.
 *
 * Companion to tests/engine.js, which needs a real browser. Everything here
 * is a regression that shipped: pages promising things the code does not do,
 * links that 404, structured data Google rejects, crawl files that drifted
 * out of sync with the sitemap.
 *
 *     node tests/site-checks.mjs            (run from the repo root)
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] || '.';
const fails = [];
const notes = [];
const fail = (check, detail) => fails.push({ check, detail });

/* ---------- gather ---------- */
const SKIP_DIRS = new Set(['dist', 'node_modules', 'archive', 'beta', 'src', 'vendor',
                           'fonts', 'og', 'samples', 'sdk', 'tests', '.git', '.github']);
const pages = [];
if (existsSync(join(ROOT, 'index.html'))) pages.push(['/', join(ROOT, 'index.html')]);
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
  const f = join(ROOT, e.name, 'index.html');
  if (existsSync(f)) pages.push(['/' + e.name + '/', f]);
}
const read = (f) => readFileSync(f, 'utf8');
const sitemap = existsSync(join(ROOT, 'sitemap.xml')) ? read(join(ROOT, 'sitemap.xml')) : '';
const llms = existsSync(join(ROOT, 'llms.txt')) ? read(join(ROOT, 'llms.txt')) : '';

const sitemapPaths = [...sitemap.matchAll(/<loc>https:\/\/imgready\.app([^<]*)<\/loc>/g)].map((m) => m[1]);

/* ---------- 1. internal links resolve ---------- */
{
  const targets = new Set(pages.map(([slug]) => slug));
  /* build.mjs writes these into dist/ — they are real at deploy time but
     absent from the source tree, so a plain existsSync would flag them. */
  const GENERATED = new Set([
    '/app.js', '/app.css', '/app.js.map', '/home-editor.js', '/decoders-exotic.js',
  ]);
  const assetExists = (p) => GENERATED.has(p) || existsSync(join(ROOT, p.replace(/^\//, '')));
  let broken = 0;
  for (const [slug, file] of pages) {
    const html = read(file);
    for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
      const href = m[1];
      if (/\.[a-z0-9]{2,5}$/i.test(href)) { if (!assetExists(href)) { fail('internal links', `${slug} -> ${href} (missing asset)`); broken++; } continue; }
      const norm = href.endsWith('/') ? href : href + '/';
      if (!targets.has(norm) && !assetExists(href)) { fail('internal links', `${slug} -> ${href}`); broken++; }
    }
  }
  if (!broken) notes.push(`internal links: all resolve across ${pages.length} pages`);
}

/* ---------- 2. canonicals point at themselves ---------- */
for (const [slug, file] of pages) {
  const html = read(file);
  const m = html.match(/<link rel="canonical"\s+href="([^"]*)"/);
  if (!m) { fail('canonical', `${slug} has none`); continue; }
  const want = 'https://imgready.app' + slug;
  /* /beta/ deliberately canonicalises to the homepage. */
  if (m[1] !== want && slug !== '/beta/') fail('canonical', `${slug} -> ${m[1]}`);
}

/* ---------- 3. sitemap matches reality ---------- */
{
  const pageSet = new Set(pages.map(([s]) => s));
  for (const p of sitemapPaths) if (!pageSet.has(p)) fail('sitemap', `lists ${p}, which has no index.html`);
  for (const [slug] of pages) {
    if (slug === '/tests/' ) continue;
    if (!sitemapPaths.includes(slug)) fail('sitemap', `${slug} exists but is not listed`);
  }
  if (!sitemapPaths.length) fail('sitemap', 'no <loc> entries found');
}

/* ---------- 4. llms.txt covers the sitemap ---------- */
for (const p of sitemapPaths) {
  if (p === '/') continue;
  if (!llms.includes(p)) fail('llms.txt', `does not mention ${p}`);
}

/* ---------- 5. JSON-LD parses, and uses no SVG images ---------- */
{
  let blocks = 0;
  for (const [slug, file] of pages) {
    const html = read(file);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      blocks++;
      let obj;
      try { obj = JSON.parse(m[1]); }
      catch (e) { fail('JSON-LD', `${slug}: ${String(e.message).slice(0, 80)}`); continue; }
      /* Google does not accept SVG for structured-data images. */
      const asText = JSON.stringify(obj);
      if (/"image"\s*:\s*"[^"]*\.svg"/.test(asText)) fail('JSON-LD', `${slug} uses an SVG image`);
    }
  }
  notes.push(`JSON-LD: ${blocks} blocks parsed`);
}

/* ---------- 6. claims the engine does not honour ---------- */
{
  /* Each of these shipped as a false promise. Keep them from coming back. */
  const banned = [
    [/converts animated GIFs to animated WebP,\s*preserving every frame/i,
     'old false claim about animated WebP'],
    [/Animated GIF frames preserved/i, 'old false claim in a meta description'],
    [/animated WebP preserves (?:it|the animation)/i,
     'tells the user to convert to WebP to keep motion, from a page that cannot'],
    [/WebAssembly modules served from the same origin/i,
     'false: the jsquash codecs come from esm.sh'],
  ];
  for (const [slug, file] of pages) {
    const html = read(file);
    for (const [re, why] of banned) if (re.test(html)) fail('false claim', `${slug}: ${why}`);
  }
  for (const [re, why] of banned) if (re.test(llms)) fail('false claim', `llms.txt: ${why}`);
}

/* ---------- 7. redirects have both slash forms ---------- */
{
  const f = join(ROOT, '_redirects');
  if (existsSync(f)) {
    const rules = read(f).split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/)[0]);
    const set = new Set(rules);
    for (const r of rules) {
      const other = r.endsWith('/') ? r.slice(0, -1) : r + '/';
      if (!set.has(other)) fail('_redirects', `${r} has no ${other} counterpart — the slash-less form 404s`);
    }
    notes.push(`_redirects: ${rules.length} rules, both slash forms present`);
  }
}

/* ---------- 8. the homepage shows its controls ---------- */
{
  const f = join(ROOT, 'index.html');
  if (existsSync(f)) {
    const html = read(f);
    /* Format, Quality, Resize and Crop all live in .bb-drawer. It used to
       start closed on every load, so the result view opened with nothing
       but a gear — the primary control of a format converter hidden
       behind an undiscoverable click. */
    if (!/<body[^>]*data-adjust="open"/.test(html)) {
      fail('homepage controls', 'body does not default data-adjust="open" — the tools start hidden again');
    }
    if (/class="bb-drawer"[^>]*aria-hidden="true"/.test(html)) {
      fail('homepage controls', '.bb-drawer is hardcoded aria-hidden="true" — invisible to screen readers when open');
    }
    const labels = [...html.matchAll(/bb-section-label">([^<]*)</g)].map((m) => m[1].trim());
    for (const want of ['Format', 'Quality']) {
      if (!labels.includes(want)) fail('homepage controls', `no ${want} control found in the action bar`);
    }
    notes.push(`homepage action bar: ${labels.join(', ')} — drawer defaults open`);
  }
}

/* ---------- 9. the result overlay can't strand a format ---------- */
{
  const f = join(ROOT, 'src', '05-process-modal.js');
  if (existsSync(f)) {
    const js = read(f);
    /* The overlay's pill row was a hardcoded FE_FMTS = webp/avif/jpg/png.
       On /png-to-ico/ the encode was a correct ICO, but the row offered no
       ICO pill and marked none active — so on the page named after the
       format, one click on any pill lost it with no way back. The pill
       list must append the result's own format when it isn't one of the
       four. */
    if (!/fmts\.indexOf\(startFmt\)===-1/.test(js.replace(/\s+/g, ''))) {
      fail('result overlay', 'pill row does not append the current format — ICO/GIF results get no pill of their own');
    }
    /* Worse: feReEncode builds the output with canvas.toBlob and a mimeMap
       that has no ico or gif, falling through to image/jpeg. Without an
       explicit branch, adding an ICO pill hands back JPEG bytes named
       .ico, and the quality slider does the same thing on its own. */
    const re = js.slice(js.indexOf('async function feReEncode'));
    const branch = /feLiveFmt==='ico'\|\|feLiveFmt==='gif'/.test(re.replace(/\s+/g, ''));
    const fallback = re.includes("mimeMap[feLiveFmt]||'image/jpeg'");
    if (fallback && !branch) {
      fail('result overlay', 'feReEncode falls back to image/jpeg for ico/gif — silent format substitution');
    }
    if (branch) notes.push('result overlay: current format always gets a pill; ico/gif re-encode via their real encoders');
  }
}

/* ---------- 10. no page is orphaned ---------- */
{
  const linked = new Set();
  for (const [, file] of pages) {
    for (const m of read(file).matchAll(/href="(\/[^"#?]*)"/g)) {
      const h = m[1];
      linked.add(h.endsWith('/') ? h : h + '/');
    }
  }
  for (const [slug] of pages) {
    if (slug === '/' || slug === '/tests/') continue;
    if (!linked.has(slug)) fail('orphan', `${slug} is in the sitemap but nothing links to it`);
  }
}

/* ---------- report ---------- */
console.log('imgready site checks\n');
notes.forEach((n) => console.log('  · ' + n));
if (!fails.length) {
  console.log(`\n  all checks passed across ${pages.length} pages\n`);
  process.exit(0);
}
const byCheck = new Map();
for (const f of fails) { if (!byCheck.has(f.check)) byCheck.set(f.check, []); byCheck.get(f.check).push(f.detail); }
console.log('');
for (const [check, list] of byCheck) {
  console.log(`  ${check} — ${list.length} problem(s)`);
  list.slice(0, 12).forEach((d) => console.log('      ' + d));
  if (list.length > 12) console.log(`      …and ${list.length - 12} more`);
}
console.log(`\n  ${fails.length} problem(s) across ${pages.length} pages\n`);
process.exit(1);
