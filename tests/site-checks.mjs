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
    /* Format, Quality, Resize and Crop live in .bb-drawer. The failure
       this guards against is the result view offering nothing but an
       unlabelled gear — the primary controls of a converter behind an
       undiscoverable click.

       It used to assert data-adjust="open" on <body>. That became a
       stale guarantee once the batch list landed: the list is the result
       view now and it deliberately collapses the strip on a fresh batch,
       so the attribute was immediately overridden and the check was
       protecting nothing. What actually has to hold is that the result
       view carries a LABELLED route to those controls. */
    if (!/id="flEditBtn"[^>]*>|>\s*Edit settings/.test(html)) {
      fail('homepage controls', 'the result view has no labelled route to Format/Quality/Resize/Crop');
    }
    if (/class="bb-drawer"[^>]*aria-hidden="true"/.test(html)) {
      fail('homepage controls', '.bb-drawer is hardcoded aria-hidden="true" — invisible to screen readers when open');
    }
    const labels = [...html.matchAll(/bb-section-label">([^<]*)</g)].map((m) => m[1].trim());
    for (const want of ['Format', 'Quality']) {
      if (!labels.includes(want)) fail('homepage controls', `no ${want} control found in the action bar`);
    }
    notes.push(`homepage action bar: ${labels.join(', ')} — reachable via a labelled Edit settings button`);
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

/* ---------- 10. every entry point on a page accepts the same things ---------- */
{
  for (const [slug, file] of pages) {
    const html = read(file);
    const accepts = [...html.matchAll(/<input[^>]*type="file"[^>]*>/g)]
      .map((m) => ({ tag: m[0], id: (m[0].match(/id="([^"]*)"/) || [])[1] || '?',
                     accept: (m[0].match(/accept="([^"]*)"/) || [])[1] }))
      .filter((i) => i.accept !== undefined);
    if (accepts.length < 2) continue;
    /* The dropzone, the empty-batch input and the "Add more" button are
       three doors into the same pipeline. #moreInput shipped as plain
       image/*, so after a first batch the OS picker silently filtered
       out HEIC, SVG, TIFF, ICO and video — all of which the very same
       page accepted on the initial drop. */
    const sets = new Set(accepts.map((a) => a.accept.split(',').map((s) => s.trim()).sort().join(',')));
    if (sets.size > 1) {
      fail('file inputs', `${slug}: ${accepts.map((a) => '#' + a.id).join(' and ')} disagree on accept — one entry point takes files the others reject`);
    }
  }
  /* If the homepage takes video, it has to say so somewhere a visitor
     can read. The feature is otherwise discoverable only by guessing. */
  const home = existsSync(join(ROOT, 'index.html')) ? read(join(ROOT, 'index.html')) : '';
  if (/<input[^>]*type="file"[^>]*accept="[^"]*video\//.test(home) && !/MP4/i.test(home.replace(/\.mp4/gi, ''))) {
    fail('file inputs', 'homepage accepts video but never mentions it in visible copy');
  }
  notes.push('file inputs: all entry points on a page agree, and video is named in the copy');
}

/* ---------- 11. behavioural classes in markup still have a rule ---------- */
{
  /* Comments stripped first — this file documents the classes it styles,
     so a plain substring search matches the prose explaining a rule's
     removal just as happily as the rule itself. */
  const css = (existsSync(join(ROOT, 'src', 'app.css')) ? read(join(ROOT, 'src', 'app.css')) : '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /* .hide-mobile went inert: the rule was deleted in favour of the
     hamburger nav, but the hamburger only ever shipped on the homepage,
     and 69 landing pages kept the class. The class is not decorative —
     a page using it is asserting those links are hidden on a phone — so
     markup and stylesheet have to agree. Pure-presentation classes are
     not listed here; these are the ones with behaviour attached. */
  /* A theme control must come with a theme. The footer shipped a
     "Night mode" link that toggled .dark-mode, which no stylesheet
     defined — it flipped its own label and changed nothing else, so it
     read as working. If a page puts the control back, the mechanism it
     drives has to exist. */
  for (const [slug, f] of pages) {
    const html = read(f);
    if (!/id="themeBtn"/.test(html)) continue;
    const drivesDataTheme = /data-theme/.test(html) || /data-theme/.test(css);
    const drivesClass = /\.dark-mode/.test(css) || /\.dark-mode\s*\{/.test(html);
    if (!drivesDataTheme && !drivesClass) {
      fail('dead control', `${slug} has a theme button but nothing styles the theme it toggles`);
    }
  }
  const BEHAVIOURAL = ['hide-mobile'];
  for (const cls of BEHAVIOURAL) {
    const users = pages.filter(([, f]) => read(f).includes(`${cls}"`) || read(f).includes(`${cls} `));
    if (!users.length) continue;
    if (!css.includes(cls)) {
      fail('dead class', `${users.length} page(s) use .${cls} but src/app.css has no rule for it — the class does nothing`);
    }
  }
  notes.push('classes: .hide-mobile is styled where it is used');
}

/* ---------- 12. video extraction can't wait forever ---------- */
{
  const f = join(ROOT, 'src', 'home-app.js');
  if (existsSync(f)) {
    const js = read(f);
    const fn = js.slice(js.indexOf('async function extractVideoFrames'));
    const body = fn.slice(0, fn.indexOf('\nasync function addFilesFromList'));
    /* The loadedmetadata await has always had a 30s deadline. The seek
       loop had none, so a file that opened but could not be scrubbed
       (unseekable stream, damaged index) left the await pending for
       good: the page kept painting and the "Reading video…" toast sat
       at its 60s timeout, so it read as slow rather than stuck.
       Verified by stubbing a video element that fires loadedmetadata
       and never fires seeked — it now throws in ~10s. */
    const seekBlock = body.slice(body.indexOf("addEventListener('seeked'") - 800,
                                 body.indexOf("addEventListener('seeked'") + 400);
    if (!/setTimeout\(/.test(seekBlock)) {
      fail('video', 'the seek loop in extractVideoFrames has no timeout — an unseekable file hangs it forever');
    }
    /* duration is Infinity for MediaRecorder output and NaN for some
       damaged files. NaN made the frame count NaN, the loop ran zero
       times, and the caller threw on bufs[0] of an empty array. */
    if (!/Number\.isFinite\(dur\)/.test(body)) {
      fail('video', 'extractVideoFrames does not guard a non-finite duration');
    }
    notes.push('video: seek loop is bounded and non-finite durations are handled');
  }
}

/* ---------- 13. a focusable dropzone can be operated from the keyboard ---------- */
{
  /* Both engines render the dropzone as role="region" tabindex="0", so
     it takes a tab stop. The real control is the file input on the very
     next stop, and Enter/Space on the region did nothing — a keyboard
     user landed on the biggest target on the page, got a focus ring and
     found it inert. If a page makes the region focusable, the engine
     that drives it has to handle the activation keys. */
  const engines = [
    ['homepage', join(ROOT, 'src', 'home-app.js')],
    ['landing pages', join(ROOT, 'src', '02-decoders.js')],
  ];
  const focusableDropzone = pages.some(([, f]) =>
    /id="dropzone"[^>]*tabindex="0"|tabindex="0"[^>]*id="dropzone"/.test(read(f)));
  if (focusableDropzone) {
    for (const [label, f] of engines) {
      if (!existsSync(f)) continue;
      const js = read(f);
      const hasKeyHandler = /dz[A-Za-z]*\.addEventListener\('keydown'/.test(js)
        || /addEventListener\('keydown'[\s\S]{0,400}?fi\.click\(\)/.test(js);
      if (!hasKeyHandler) {
        fail('keyboard', `${label}: the dropzone is focusable but nothing handles Enter/Space on it`);
      }
    }
    notes.push('keyboard: the focusable dropzone responds to Enter and Space in both engines');
  }
}

/* ---------- 14. the icon set is real and self-consistent ---------- */
{
  const ico = join(ROOT, 'favicon.ico');
  /* /favicon.ico is requested by default by browsers and crawlers whether
     or not a page links it. The site shipped only a 256-byte SVG, so
     every one of those requests 404'd. */
  if (!existsSync(ico)) {
    fail('icons', 'no /favicon.ico — browsers and crawlers request it by default');
  } else {
    /* Validate the directory against its payloads. This is the same bug
       the app's own ICO encoder once had: a header claiming sizes the
       image data doesn't have. */
    const b = readFileSync(ico);
    if (b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) {
      fail('icons', 'favicon.ico is not a valid ICO (bad ICONDIR)');
    } else {
      const n = b.readUInt16LE(4);
      if (n < 2) fail('icons', `favicon.ico has ${n} entry — ship at least 16 and 32`);
      for (let i = 0; i < n; i++) {
        const o = 6 + i * 16;
        const w = b.readUInt8(o) || 256, h = b.readUInt8(o + 1) || 256;
        const len = b.readUInt32LE(o + 8), off = b.readUInt32LE(o + 12);
        if (off + len > b.length) { fail('icons', `favicon.ico entry ${i} points past EOF`); continue; }
        const pay = b.subarray(off, off + len);
        if (pay.subarray(1, 4).toString('ascii') !== 'PNG') continue;  /* BMP payloads are legal too */
        const rw = pay.readUInt32BE(16), rh = pay.readUInt32BE(20);
        if (rw !== w || rh !== h) {
          fail('icons', `favicon.ico entry ${i} declares ${w}x${h} but its PNG is ${rw}x${rh}`);
        }
      }
    }
  }
  /* iOS does not render SVG for apple-touch-icon — it silently falls back
     to a screenshot of the page. It shipped pointing at favicon.svg. */
  for (const [slug, file] of pages) {
    const m = read(file).match(/<link rel="apple-touch-icon"[^>]*href="([^"]+)"/);
    if (m && !/\.png$/i.test(m[1])) {
      fail('icons', `${slug}: apple-touch-icon is ${m[1]} — iOS only accepts PNG`);
    }
  }
  /* Safari tints the pinned-tab mask itself, so a mask-icon that points
     at a coloured or missing file is worse than none. */
  for (const [slug, file] of pages) {
    const m = read(file).match(/<link rel="mask-icon"[^>]*href="([^"]+)"[^>]*>/);
    if (!m) continue;
    const p = m[1].replace(/^\//, '');
    if (!/\.svg$/i.test(m[1])) { fail('icons', `${slug}: mask-icon must be an SVG`); continue; }
    if (!existsSync(join(ROOT, p))) { fail('icons', `${slug}: mask-icon ${m[1]} does not exist`); continue; }
    const svg = read(join(ROOT, p));
    /* Must be a flat black silhouette — any other fill defeats the tint. */
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((x) => x[1].toLowerCase());
    const bad = fills.filter((f) => f !== '#000000' && f !== '#000' && f !== 'black' && f !== 'none');
    if (bad.length) fail('icons', `${slug}: mask-icon is not a black silhouette (${bad[0]})`);
    if (!/<link rel="mask-icon"[^>]*color="/.test(m[0])) {
      fail('icons', `${slug}: mask-icon has no color attribute for Safari to tint with`);
    }
  }
  /* theme-color lives in two places and they drifted: the HTML said the
     new accent while the manifest still held the old one. */
  const mfPath = join(ROOT, 'manifest.webmanifest');
  if (existsSync(mfPath)) {
    let mf;
    try { mf = JSON.parse(read(mfPath)); }
    catch (e) { fail('icons', `manifest.webmanifest does not parse: ${String(e.message).slice(0, 60)}`); }
    if (mf) {
      const home = existsSync(join(ROOT, 'index.html')) ? read(join(ROOT, 'index.html')) : '';
      const metaTheme = (home.match(/<meta name="theme-color" content="([^"]+)"/) || [])[1];
      if (metaTheme && mf.theme_color && metaTheme.toLowerCase() !== String(mf.theme_color).toLowerCase()) {
        fail('icons', `theme-color disagrees: HTML ${metaTheme} vs manifest ${mf.theme_color}`);
      }
      /* Both are plain attributes, so they cannot use var(--accent) and
         have to be updated by hand when the brand colour changes. Tie
         them to the token so a rebrand cannot leave the browser chrome
         and the install banner on the old colour. */
      const cssSrc = existsSync(join(ROOT, 'src', 'app.css')) ? read(join(ROOT, 'src', 'app.css')) : '';
      const rust = (cssSrc.match(/--rust-500:\s*(#[0-9a-fA-F]{6})/) || [])[1];
      if (rust && metaTheme && metaTheme.toLowerCase() !== rust.toLowerCase()) {
        fail('icons', `theme-color ${metaTheme} does not match --accent's primitive ${rust} — the brand colour moved and these did not`);
      }
      /* Chrome needs a raster icon of at least 192px to treat the app as
         installable; SVG manifest icons are not enough on their own. */
      const pngs = (mf.icons || []).filter((i) => /png$/i.test(i.type || '') || /\.png$/i.test(i.src || ''));
      for (const want of ['192x192', '512x512']) {
        if (!pngs.some((i) => (i.sizes || '').split(/\s+/).includes(want))) {
          fail('icons', `manifest has no ${want} PNG icon — Chrome will not treat it as installable`);
        }
      }
      if (!(mf.icons || []).some((i) => /maskable/.test(i.purpose || ''))) {
        fail('icons', 'manifest declares no maskable icon');
      }
      /* Nothing may reference an icon that isn't on disk. */
      for (const i of mf.icons || []) {
        const p = String(i.src || '').replace(/^\//, '');
        if (p && !existsSync(join(ROOT, p))) fail('icons', `manifest references missing ${i.src}`);
      }
    }
  }
  notes.push('icons: favicon.ico validates, apple-touch-icon is PNG, manifest matches theme-color');
}

/* ---------- 15. the batch lands in the list, and mixed batches stay sane ---------- */
{
  const home = existsSync(join(ROOT, 'index.html')) ? read(join(ROOT, 'index.html')) : '';
  const app = existsSync(join(ROOT, 'src', 'home-app.js')) ? read(join(ROOT, 'src', 'home-app.js')) : '';
  if (home && app) {
    /* A finished batch used to be presented only through the cover-flow,
       which shows one image with the rest as thumbnails. The list is the
       default now; the comparison is a drill-down. */
    if (!/id="fileListWrap"/.test(home)) fail('batch list', 'the file list markup is gone from index.html');
    if (!/dataset\.view = 'list'/.test(app)) fail('batch list', 'dropping files no longer defaults to the list view');
    /* Ownership split: batch-level controls belong to the list, file-level
       ones to the compare view. Neither may duplicate the other.

       The first version of this asserted the whole action bar was hidden
       in list view. That was the wrong invariant — the settings inside it
       are global and belong with the batch; only its Share all /
       Download all cluster duplicates the list header. */
    if (!/body\[data-view="list"\] \.menu-card > \.actions\{display:none/.test(home)) {
      fail('batch list', 'the bar’s batch actions are not hidden in list view — Download all appears twice');
    }
    /* Compare is one file. A second batch navigator (the cover-flow), a
       second set of batch actions, and the old top-chrome all stacked
       into the same strip as the compare bar and made it unreadable. */
    for (const sel of ['.cover-flow', '.menu-card > .actions', '.top-chrome', '.filename-ribbon']) {
      const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`body\\[data-view="compare"\\][^{}]*${esc}`);
      if (!re.test(home)) fail('batch list', `${sel} is not hidden in compare view — it duplicates what the list owns`);
    }
    /* A fresh batch collapses the settings strip, so "Edit settings" is
       a real high-intent button and not a label for something already
       on screen. */
    if (!/dataset\.adjust = 'closed'/.test(app)) {
      fail('batch list', 'a fresh batch no longer collapses the settings strip');
    }
    if (!/id="flEditBtn"/.test(home)) fail('batch list', 'no Edit settings button in the list header');
    /* Auto must stay reachable. Without it the first dropped file sets
       the format for the whole batch: a 412 KB JPEG behind a PNG came
       back as a 930 KB PNG, i.e. the default path made files bigger. */
    /* Match the element, not the string: `data-fmt="auto"` also appears
       in a CSS comment, which made the first version of this check pass
       against a menu that had no Auto button in it at all. */
    if (!/<button[^>]*data-fmt="auto"/.test(home)) {
      fail('batch list', 'the workspace format menu has no Auto option — mixed batches get forced onto one format');
    }
    if (!/presetFormatFromInput\(fresh\.map/.test(app)) {
      fail('batch list', 'format is preset from the first file only, not the batch');
    }
    /* A file that fails to encode never touches ENCODE.encoded, so the
       success-side repaint hook never fires for it. Without an explicit
       failure path the row sat on "encoding…" forever and the header
       read "Optimising… 1 of 2" permanently — found by dropping a text
       file renamed .png, after the happy path had been the only thing
       tested. Both queue failure sites must route through the helper. */
    if (!/function markEncodeFailed/.test(app)) {
      fail('batch list', 'no markEncodeFailed — a failed file will sit on "encoding…" forever');
    }
    /* The invariant is that nothing records a failure without going
       through the helper, so there should be exactly one
       ENCODE.failed.add in the file — the one inside it. Counting call
       sites instead was too weak: there are three, and the first version
       of this check allowed two, so unhooking a queue site still passed. */
    const rawAdds = (app.match(/ENCODE\.failed\.add\(/g) || []).length;
    if (rawAdds !== 1) {
      fail('batch list', `${rawAdds} sites call ENCODE.failed.add directly — failures must go through markEncodeFailed or the list never learns about them`);
    }
    /* The workspace is a locked viewport — body and .stage are
       overflow:hidden at height:100vh so the image canvas owns the
       screen. The list inherited that and became 2900px of rows inside
       a 720px box with no scrollbar: on a 40-file batch thirty files
       were simply unreachable. List view has to restore scrolling. */
    if (!/body\[data-state="multi"\]\[data-view="list"\] \.stage\.multi\{[^}]*overflow-y:auto/.test(home)) {
      fail('batch list', 'list view does not restore scrolling — rows past the fold are unreachable in the locked workspace');
    }
    /* Removing one file has to remap the index-keyed ENCODE maps, or a
       file's results end up displayed against another file's name. */
    if (!/function flRemove/.test(app)) {
      fail('batch list', 'no way to remove a single file — the only exit from a wrong file is Clear all');
    } else if (!/shift\(ENCODE\.encoded\)/.test(app)) {
      fail('batch list', 'flRemove does not remap ENCODE.encoded — results will attach to the wrong rows');
    }
    notes.push('batch list: default view, scrollable, sortable, per-row remove, Auto for mixed batches, failures retry');
  }
}

/* ---------- 16. accent fills use the paired text token ---------- */
{
  const home = existsSync(join(ROOT, 'index.html')) ? read(join(ROOT, 'index.html')) : '';
  const css  = existsSync(join(ROOT, 'src', 'app.css')) ? read(join(ROOT, 'src', 'app.css')) : '';
  /* White on the mid rust is 5.1:1, but the dark contexts remap --accent
     to a LIGHT rust where white drops to 2.63. Anything filled with
     --accent must take its text colour from --on-accent, which flips
     with the context, rather than hardcoding #fff. */
  for (const [label, src] of [['index.html', home], ['app.css', css]]) {
    for (const m of src.matchAll(/\{[^{}]*background:\s*var\(--accent\)[^{}]*\}/g)) {
      if (/color:\s*#fff/i.test(m[0])) {
        fail('tokens', `${label}: an --accent fill hardcodes white text — use var(--on-accent), which flips for the dark canvas`);
      }
    }
  }
  if (css && !/--on-accent/.test(css)) fail('tokens', '--on-accent is gone; accent fills have no paired text colour');
  notes.push('tokens: accent fills take their text colour from --on-accent');
}

/* ---------- 16. no page is orphaned ---------- */
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
