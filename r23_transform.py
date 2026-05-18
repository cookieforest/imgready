#!/usr/bin/env python3
"""R23 — Surface encoder depth + fix latent quality-slider bug.

Foundation fixes (these address a real bug — quality slider in the
home-page settings panel had no `id` so it was reading nothing):
  A. Add id="qualitySlider" to the existing range input in .quality-row
  B. Add a hidden Quality value-binding label sync (q-val span already there)

New feature: Advanced encoder controls (5 sub-items shipped together):
  1. <details> Advanced section appended to .adjust-panel
  2. 4 format tabs (WebP/AVIF/JPG/PNG) each opening a per-format panel
  3. Per-format controls: 2-3 each — effort, lossless, chroma, progressive, etc.
  4. localStorage persistence per format (versioned key imgready.encoder.<fmt>.v1)
  5. Reset to defaults button

Plumbing (extend the encode pipeline):
  - src/01-state-helpers.js: extend getSettings() to read live DOM advanced controls
  - imgready-worker.js: extend each encoder call to apply settings.advanced[fmt]

Tail sentinels preserved on all three files.
"""
import re
from pathlib import Path

ROOT = Path('/tmp/imgready-clone')
INDEX = ROOT / 'index.html'
SRC01 = ROOT / 'src' / '01-state-helpers.js'
WORKER = ROOT / 'imgready-worker.js'

# Snapshot tail sentinels before any edits
src01_before_tail = SRC01.read_text(encoding='utf-8')[-100:]
worker_before_tail = WORKER.read_text(encoding='utf-8')[-100:]
index_before_tail = INDEX.read_text(encoding='utf-8')[-100:]
print('--- BEFORE tail snapshots ---')
print('src01:', repr(src01_before_tail[-50:]))
print('worker:', repr(worker_before_tail[-50:]))
print('index:', repr(index_before_tail[-30:]))

# =====================================================================
# 1. index.html — settings panel: add qualitySlider id + Advanced section
# =====================================================================
s = INDEX.read_text(encoding='utf-8')
orig_idx_len = len(s)

# Foundation fix A: add id="qualitySlider" to the .quality-row input
old_q = '<div class="quality-row"><input type="range" min="10" max="100" value="82" aria-label="Encoding quality (10 to 100)"><span class="q-val">82</span></div>'
new_q = '<div class="quality-row"><input type="range" id="qualitySlider" min="10" max="100" value="82" aria-label="Encoding quality (10 to 100)"><span class="q-val" id="qualityValLabel">82</span></div>'
assert old_q in s, 'quality-row input not found in index.html'
s = s.replace(old_q, new_q)
print('[r23] index: qualitySlider id added (fixes latent constant-quality bug)')

# Add Advanced section to .adjust-panel — append after Privacy section.
# Find the Privacy section closing tag (which sits at the end of .adjust-panel content)
PRIVACY_TAIL = '''        <div class="adjust-section"><span class="adjust-label">Privacy</span>
          <label class="switch"><input type="checkbox" checked><span class="switch-track"></span><span>Strip metadata</span></label></div>
      </div>'''
assert PRIVACY_TAIL in s, 'Privacy section tail not found'

ADV_SECTION = '''        <div class="adjust-section"><span class="adjust-label">Privacy</span>
          <label class="switch"><input type="checkbox" id="stripExif" checked><span class="switch-track"></span><span>Strip metadata</span></label></div>
        <!-- R23 Advanced encoder section — surfaces codec params already
             loaded in WASM. Defaults preserve current behavior (no
             behavior change unless user opens & changes). Native
             <details> + per-format tabs; localStorage-persisted per
             format under imgready.encoder.<fmt>.v1. -->
        <div class="adjust-section r23-adv-section">
          <details class="r23-adv-details">
            <summary class="r23-adv-summary"><span>Advanced encoder</span><span class="r23-adv-hint">codec settings</span></summary>
            <div class="r23-adv-body">
              <div class="r23-adv-tabs" role="tablist" aria-label="Format">
                <button type="button" class="r23-adv-tab active" data-r23-tab="webp" role="tab" aria-selected="true">WebP</button>
                <button type="button" class="r23-adv-tab" data-r23-tab="avif" role="tab" aria-selected="false">AVIF</button>
                <button type="button" class="r23-adv-tab" data-r23-tab="jpg" role="tab" aria-selected="false">JPG</button>
                <button type="button" class="r23-adv-tab" data-r23-tab="png" role="tab" aria-selected="false">PNG</button>
              </div>
              <div class="r23-adv-panel" data-fmt="webp" role="tabpanel">
                <label class="r23-adv-row">
                  <span class="r23-adv-name">Effort</span>
                  <input type="range" name="effort" min="0" max="6" value="4" aria-label="WebP effort 0 to 6">
                  <output class="r23-adv-val">4</output>
                </label>
                <label class="r23-adv-row r23-adv-check">
                  <input type="checkbox" name="lossless">
                  <span>Lossless</span>
                </label>
                <p class="r23-adv-help">Higher effort = smaller file, slower encode. Lossless ignores Quality.</p>
              </div>
              <div class="r23-adv-panel" data-fmt="avif" role="tabpanel" hidden>
                <label class="r23-adv-row">
                  <span class="r23-adv-name">Effort</span>
                  <input type="range" name="effort" min="0" max="10" value="4" aria-label="AVIF effort 0 to 10">
                  <output class="r23-adv-val">4</output>
                </label>
                <label class="r23-adv-row r23-adv-check">
                  <input type="checkbox" name="lossless">
                  <span>Lossless</span>
                </label>
                <label class="r23-adv-row">
                  <span class="r23-adv-name">Chroma</span>
                  <select name="subsample" aria-label="AVIF chroma subsampling">
                    <option value="420" selected>4:2:0 (smaller)</option>
                    <option value="444">4:4:4 (sharper)</option>
                  </select>
                </label>
                <p class="r23-adv-help">AVIF is slow — effort 0 is fast but larger; 10 is small but slow. 4:4:4 helps fine text and lines.</p>
              </div>
              <div class="r23-adv-panel" data-fmt="jpg" role="tabpanel" hidden>
                <label class="r23-adv-row r23-adv-check">
                  <input type="checkbox" name="progressive" checked>
                  <span>Progressive rendering</span>
                </label>
                <label class="r23-adv-row">
                  <span class="r23-adv-name">Chroma</span>
                  <select name="subsample" aria-label="JPEG chroma subsampling">
                    <option value="auto" selected>Auto</option>
                    <option value="444">4:4:4 (sharpest)</option>
                    <option value="422">4:2:2</option>
                    <option value="420">4:2:0 (smallest)</option>
                  </select>
                </label>
                <label class="r23-adv-row r23-adv-check">
                  <input type="checkbox" name="optimize_coding" checked>
                  <span>Optimize Huffman tables</span>
                </label>
                <p class="r23-adv-help">Progressive renders top-down on slow connections. 4:4:4 keeps text crisp; 4:2:0 is smallest.</p>
              </div>
              <div class="r23-adv-panel" data-fmt="png" role="tabpanel" hidden>
                <label class="r23-adv-row">
                  <span class="r23-adv-name">Optimization</span>
                  <input type="range" name="level" min="0" max="6" value="2" aria-label="OxiPNG level 0 to 6">
                  <output class="r23-adv-val">2</output>
                </label>
                <label class="r23-adv-row r23-adv-check">
                  <input type="checkbox" name="interlace">
                  <span>Interlace</span>
                </label>
                <p class="r23-adv-help">Level 0 = no extra work; 6 = aggressive (slow on large batches). Interlace = progressive PNG.</p>
              </div>
              <button type="button" class="r23-adv-reset" id="r23AdvReset">Reset to defaults</button>
            </div>
          </details>
        </div>
      </div>'''

s = s.replace(PRIVACY_TAIL, ADV_SECTION)
print('[r23] index: Advanced section appended to .adjust-panel')

# CSS for the new section. Insert before "body[data-edit-open=\"true\"] .menu-card,"
ADV_CSS = '''
  /* R23 — Advanced encoder controls section. Native <details>, per-format
     tabs, simple form controls. No JS framework, no animations beyond the
     browser-native details expand. Persists per format to localStorage. */
  .r23-adv-section .r23-adv-details{
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.08);
    border-radius:10px;
    overflow:hidden;
  }
  .r23-adv-summary{
    cursor:pointer;list-style:none;
    padding:10px 12px;
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    font-size:.82rem;font-weight:600;color:rgba(255,255,255,.85);
    user-select:none;
  }
  .r23-adv-summary::-webkit-details-marker{display:none;}
  .r23-adv-summary::after{
    content:"";display:inline-block;width:8px;height:8px;
    border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;
    transform:rotate(45deg);transition:transform .15s ease;
    margin-left:auto;flex-shrink:0;
  }
  .r23-adv-details[open] .r23-adv-summary::after{transform:rotate(-135deg);}
  .r23-adv-hint{
    font-size:.7rem;font-weight:500;color:rgba(255,255,255,.45);
    margin-right:auto;
  }
  .r23-adv-body{
    padding:12px 12px 14px;
    border-top:1px solid rgba(255,255,255,.06);
    display:flex;flex-direction:column;gap:12px;
  }
  .r23-adv-tabs{
    display:flex;gap:4px;padding:4px;border-radius:8px;
    background:rgba(0,0,0,.18);
  }
  .r23-adv-tab{
    flex:1 1 0;padding:6px 10px;border-radius:6px;
    background:transparent;border:none;color:rgba(255,255,255,.55);
    font-size:.74rem;font-weight:600;cursor:pointer;
    transition:background .12s,color .12s;
  }
  .r23-adv-tab:hover{color:rgba(255,255,255,.9);}
  .r23-adv-tab.active{background:rgba(255,255,255,.1);color:#fff;}
  .r23-adv-tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .r23-adv-panel{display:flex;flex-direction:column;gap:10px;}
  .r23-adv-panel[hidden]{display:none !important;}
  .r23-adv-row{
    display:flex;align-items:center;gap:10px;
    font-size:.78rem;color:rgba(255,255,255,.85);
  }
  .r23-adv-name{flex:0 0 90px;color:rgba(255,255,255,.65);}
  .r23-adv-row input[type="range"]{flex:1 1 auto;min-width:0;accent-color:var(--accent);}
  .r23-adv-row select{
    flex:1 1 auto;min-width:0;
    background:rgba(0,0,0,.3);color:#fff;
    border:1px solid rgba(255,255,255,.14);border-radius:6px;
    padding:5px 8px;font-size:.78rem;font-family:inherit;
  }
  .r23-adv-row select:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
  .r23-adv-val{
    flex:0 0 34px;text-align:right;
    font-size:.74rem;font-variant-numeric:tabular-nums;
    color:rgba(255,255,255,.7);
  }
  .r23-adv-check{flex-wrap:nowrap;gap:8px;}
  .r23-adv-check input[type="checkbox"]{flex:0 0 auto;accent-color:var(--accent);}
  .r23-adv-help{
    margin:2px 0 0;font-size:.68rem;color:rgba(255,255,255,.4);line-height:1.45;
  }
  .r23-adv-reset{
    background:transparent;border:1px solid rgba(255,255,255,.14);
    color:rgba(255,255,255,.55);
    padding:6px 12px;border-radius:6px;
    font-size:.72rem;font-weight:600;cursor:pointer;
    align-self:flex-start;margin-top:4px;
    transition:background .12s,color .12s;
  }
  .r23-adv-reset:hover{background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);}
  .r23-adv-reset:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}
'''

# Insert before the R22 cursor CSS block (which itself sits before the menu-card overlay rule)
INSERT_ANCHOR = '  /* R22 — precise crosshair override during active drag OR when'
assert INSERT_ANCHOR in s, 'R22 cursor anchor not found'
s = s.replace(INSERT_ANCHOR, ADV_CSS + '\n' + INSERT_ANCHOR)
print('[r23] index: Advanced CSS added')

# Inline JS for tab switching, persistence, qualityValLabel sync, reset
ADV_JS = '''
<script>
/* R23 — Advanced encoder controls glue. Vanilla JS, no framework. */
(function(){
  'use strict';
  var DEFAULTS = {
    webp: { effort: 4, lossless: false },
    avif: { effort: 4, lossless: false, subsample: '420' },
    jpg:  { progressive: true, subsample: 'auto', optimize_coding: true },
    png:  { level: 2, interlace: false }
  };
  function $(sel, root){ return (root || document).querySelector(sel); }
  function $$(sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function key(fmt){ return 'imgready.encoder.' + fmt + '.v1'; }

  function applyToPanel(fmt){
    var panel = $('.r23-adv-panel[data-fmt="' + fmt + '"]');
    if (!panel) return;
    var stored;
    try { stored = JSON.parse(localStorage.getItem(key(fmt)) || 'null'); } catch(_) { stored = null; }
    var vals = Object.assign({}, DEFAULTS[fmt] || {}, stored || {});
    Object.keys(vals).forEach(function(name){
      var el = panel.querySelector('[name="' + name + '"]');
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!vals[name];
      else el.value = String(vals[name]);
      if (el.type === 'range') {
        var out = el.parentElement.querySelector('output.r23-adv-val');
        if (out) out.textContent = el.value;
      }
    });
  }
  function persist(fmt){
    var panel = $('.r23-adv-panel[data-fmt="' + fmt + '"]');
    if (!panel) return;
    var out = {};
    $$('input,select', panel).forEach(function(el){
      var n = el.name; if (!n) return;
      if (el.type === 'checkbox') out[n] = el.checked;
      else if (el.type === 'range') out[n] = parseInt(el.value, 10);
      else out[n] = el.value;
    });
    try { localStorage.setItem(key(fmt), JSON.stringify(out)); } catch(_){}
  }

  function wireTabs(){
    var tabs = $$('.r23-adv-tab');
    tabs.forEach(function(t){
      t.addEventListener('click', function(){
        var fmt = t.getAttribute('data-r23-tab');
        tabs.forEach(function(x){
          x.classList.toggle('active', x === t);
          x.setAttribute('aria-selected', x === t ? 'true' : 'false');
        });
        $$('.r23-adv-panel').forEach(function(p){
          p.hidden = p.getAttribute('data-fmt') !== fmt;
        });
      });
    });
  }
  function wireInputs(){
    $$('.r23-adv-panel').forEach(function(panel){
      var fmt = panel.getAttribute('data-fmt');
      panel.addEventListener('input', function(e){
        var el = e.target;
        if (el.type === 'range') {
          var out = el.parentElement.querySelector('output.r23-adv-val');
          if (out) out.textContent = el.value;
        }
        persist(fmt);
      });
      panel.addEventListener('change', function(){ persist(fmt); });
    });
  }
  function wireReset(){
    var btn = $('#r23AdvReset');
    if (!btn) return;
    btn.addEventListener('click', function(){
      Object.keys(DEFAULTS).forEach(function(fmt){
        try { localStorage.removeItem(key(fmt)); } catch(_){}
        applyToPanel(fmt);
      });
    });
  }
  function syncQualityLabel(){
    var s = document.getElementById('qualitySlider');
    var lbl = document.getElementById('qualityValLabel');
    if (!s || !lbl) return;
    s.addEventListener('input', function(){
      lbl.textContent = s.value;
      var hdr = s.closest('.adjust-section') && s.closest('.adjust-section').querySelector('.adjust-label');
      if (hdr) hdr.textContent = 'Quality · ' + s.value;
    });
  }

  function init(){
    Object.keys(DEFAULTS).forEach(applyToPanel);
    wireTabs();
    wireInputs();
    wireReset();
    syncQualityLabel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
</script>
'''

# Insert just before </body>
BODY_CLOSE = '\n</body>\n</html>\n'
assert BODY_CLOSE in s, 'body close not found'
s = s.replace(BODY_CLOSE, ADV_JS + BODY_CLOSE)
print('[r23] index: Advanced inline JS appended')

INDEX.write_text(s, encoding='utf-8')
new_idx_len = len(s)
print(f'[r23] index.html: {orig_idx_len} -> {new_idx_len} (+{new_idx_len-orig_idx_len})')
assert s.endswith('</body>\n</html>\n'), 'index tail broken'

# =====================================================================
# 2. src/01-state-helpers.js — extend getSettings to inject advanced
# =====================================================================
s01 = SRC01.read_text(encoding='utf-8')
orig_01_len = len(s01)

OLD_GETSETTINGS = '''function getSettings(fmt){
  var q=parseInt((G('qualitySlider')||{value:82}).value)/100;
  /* Resize input drives one of two modes — Longest side (px) or Percent.
     Mode toggle persists separately; the same input value carries the
     numeric. We split into maxDim/resizePct here so the worker doesn't
     have to know about modes — it just sees one or the other. */
  var resizeMode=(G('resizeMode')||{}).value||'dim';
  var resizeVal=parseInt((G('resizeMax')||{}).value)||0;
  var maxDim=resizeMode==='dim'?resizeVal:0;
  var resizePct=resizeMode==='pct'?Math.max(1,Math.min(100,resizeVal)):0;
  var stripExifEl=G('stripExif');
  var stripExif=stripExifEl?!!stripExifEl.checked:true;
  var mimeMap={webp:'image/webp',avif:'image/avif',png:'image/png',jpg:'image/jpeg',gif:'image/gif'};
  return{mime:mimeMap[fmt]||'image/webp',quality:fmt==='gif'?undefined:q,maxDim:maxDim,resizePct:resizePct,stripExif:stripExif};
}'''

NEW_GETSETTINGS = '''function getSettings(fmt){
  var q=parseInt((G('qualitySlider')||{value:82}).value)/100;
  /* Resize input drives one of two modes — Longest side (px) or Percent.
     Mode toggle persists separately; the same input value carries the
     numeric. We split into maxDim/resizePct here so the worker doesn't
     have to know about modes — it just sees one or the other. */
  var resizeMode=(G('resizeMode')||{}).value||'dim';
  var resizeVal=parseInt((G('resizeMax')||{}).value)||0;
  var maxDim=resizeMode==='dim'?resizeVal:0;
  var resizePct=resizeMode==='pct'?Math.max(1,Math.min(100,resizeVal)):0;
  var stripExifEl=G('stripExif');
  var stripExif=stripExifEl?!!stripExifEl.checked:true;
  var mimeMap={webp:'image/webp',avif:'image/avif',png:'image/png',jpg:'image/jpeg',gif:'image/gif'};
  /* R23 — read live Advanced encoder controls if present (set up in
     the home settings panel). Falls back to {} so the worker continues
     with its own defaults. */
  var advanced = _r23ReadAdvanced();
  return{mime:mimeMap[fmt]||'image/webp',quality:fmt==='gif'?undefined:q,maxDim:maxDim,resizePct:resizePct,stripExif:stripExif,advanced:advanced};
}
function _r23ReadAdvanced(){
  function readPanel(fmt){
    var panel = document.querySelector('.r23-adv-panel[data-fmt="' + fmt + '"]');
    if (!panel) return null;
    var inputs = panel.querySelectorAll('input,select');
    var out = {};
    Array.prototype.forEach.call(inputs, function(el){
      var n = el.name; if (!n) return;
      if (el.type === 'checkbox') out[n] = el.checked;
      else if (el.type === 'range') out[n] = parseInt(el.value, 10);
      else out[n] = el.value;
    });
    return out;
  }
  return { webp: readPanel('webp'), avif: readPanel('avif'), jpg: readPanel('jpg'), png: readPanel('png') };
}'''

assert OLD_GETSETTINGS in s01, 'getSettings exact match not found in src/01-state-helpers.js'
s01 = s01.replace(OLD_GETSETTINGS, NEW_GETSETTINGS)
SRC01.write_text(s01, encoding='utf-8')
print(f'[r23] src/01-state-helpers.js: {orig_01_len} -> {len(s01)} (+{len(s01)-orig_01_len})')
assert '/* CHUNK_END:01-state-helpers v1 */' in s01[-100:], 'src/01 sentinel broken'

# =====================================================================
# 3. imgready-worker.js — extend each encoder branch with advanced params
# =====================================================================
sw = WORKER.read_text(encoding='utf-8')
orig_w_len = len(sw)

# 3a. AVIF
OLD_AVIF = '''  if (fmt === 'avif') {
    const enc = await ensureAvif();
    const id = ctx.getImageData(0, 0, w, h);
    const buf = await enc(id, { quality: Math.round((q ?? 0.5) * 100) });
    return new Blob([buf], { type: 'image/avif' });
  }'''
NEW_AVIF = '''  if (fmt === 'avif') {
    const enc = await ensureAvif();
    const id = ctx.getImageData(0, 0, w, h);
    /* R23 — Advanced AVIF params from settings.advanced.avif (UI effort
       0..10 maps to jsquash speed = 10 - effort; lossless and subsample
       passed through). Defaults preserve prior behavior. */
    const advA = (settings.advanced && settings.advanced.avif) || {};
    const _effort = (advA.effort != null) ? Math.max(0, Math.min(10, advA.effort)) : 4;
    const avifOpts = {
      quality: advA.lossless ? 100 : Math.round((q ?? 0.5) * 100),
      speed: 10 - _effort,
      subsample: (advA.subsample === '444') ? 3 : 1,
      lossless: !!advA.lossless,
    };
    const buf = await enc(id, avifOpts);
    return new Blob([buf], { type: 'image/avif' });
  }'''
assert OLD_AVIF in sw, 'avif encode block exact match not found'
sw = sw.replace(OLD_AVIF, NEW_AVIF)
print('[r23] worker: AVIF encoder extended')

# 3b. WebP
OLD_WEBP = '''  if (fmt === 'webp') {
    const enc = await ensureWebp();
    const id = ctx.getImageData(0, 0, w, h);
    const buf = await enc(id, { quality: Math.round((q ?? 0.82) * 100) });
    return new Blob([buf], { type: 'image/webp' });
  }'''
NEW_WEBP = '''  if (fmt === 'webp') {
    const enc = await ensureWebp();
    const id = ctx.getImageData(0, 0, w, h);
    /* R23 — Advanced WebP params from settings.advanced.webp. effort 0..6
       maps to libwebp method; lossless toggles lossless mode. */
    const advW = (settings.advanced && settings.advanced.webp) || {};
    const _method = (advW.effort != null) ? Math.max(0, Math.min(6, advW.effort)) : 4;
    const webpOpts = {
      quality: Math.round((q ?? 0.82) * 100),
      method: _method,
      lossless: advW.lossless ? 1 : 0,
    };
    const buf = await enc(id, webpOpts);
    return new Blob([buf], { type: 'image/webp' });
  }'''
assert OLD_WEBP in sw, 'webp encode block exact match not found'
sw = sw.replace(OLD_WEBP, NEW_WEBP)
print('[r23] worker: WebP encoder extended')

# 3c. JPEG
OLD_JPG = '''      const buf = await enc(id, {
        quality: Math.round((q ?? 0.82) * 100),
        progressive: true,    /* progressive JPGs render top-down on slow connections */
        optimize_coding: true /* Huffman optimization — small extra savings */
      });'''
NEW_JPG = '''      /* R23 — Advanced JPEG params from settings.advanced.jpg.
         progressive/optimize_coding are user toggles. Chroma subsampling:
         'auto' lets MozJPEG decide; '444'/'422'/'420' force the mode by
         passing auto_subsample=false plus the explicit chroma_subsample. */
      const advJ = (settings.advanced && settings.advanced.jpg) || {};
      const _jpgOpts = {
        quality: Math.round((q ?? 0.82) * 100),
        progressive: advJ.progressive !== false,
        optimize_coding: advJ.optimize_coding !== false,
      };
      if (advJ.subsample && advJ.subsample !== 'auto') {
        _jpgOpts.auto_subsample = false;
        _jpgOpts.chroma_subsample = (advJ.subsample === '444') ? 1
                                  : (advJ.subsample === '422') ? 2 : 3;
      }
      const buf = await enc(id, _jpgOpts);'''
assert OLD_JPG in sw, 'jpg encode block exact match not found'
sw = sw.replace(OLD_JPG, NEW_JPG)
print('[r23] worker: JPEG encoder extended')

# 3d. PNG (oxipng — 2 call sites)
OLD_OXI_1 = '''        try {
          const optimise = await ensureOxipng();
          const opt = await optimise(pngBuf, { level: 2, interlace: false });
          if (opt && opt.byteLength < pngBuf.byteLength) pngBuf = opt;
        } catch (e) { /* keep un-optimized */ }'''
NEW_OXI_1 = '''        try {
          const optimise = await ensureOxipng();
          /* R23 — OxiPNG advanced: level 0..6, interlace toggle. */
          const advP = (settings.advanced && settings.advanced.png) || {};
          const oxiOpts = {
            level: (advP.level != null) ? Math.max(0, Math.min(6, advP.level)) : 2,
            interlace: !!advP.interlace,
          };
          const opt = await optimise(pngBuf, oxiOpts);
          if (opt && opt.byteLength < pngBuf.byteLength) pngBuf = opt;
        } catch (e) { /* keep un-optimized */ }'''
assert OLD_OXI_1 in sw, 'oxipng call site 1 not found'
sw = sw.replace(OLD_OXI_1, NEW_OXI_1)

OLD_OXI_2 = '''      try {
        const optimise = await ensureOxipng();
        const opt = await optimise(buf, { level: 2, interlace: false });
        if (opt && opt.byteLength < buf.byteLength) return new Blob([opt], { type: 'image/png' });
      } catch (e) { /* keep un-optimized */ }'''
NEW_OXI_2 = '''      try {
        const optimise = await ensureOxipng();
        /* R23 — OxiPNG advanced (lossless PNG path). */
        const advP2 = (settings.advanced && settings.advanced.png) || {};
        const oxiOpts2 = {
          level: (advP2.level != null) ? Math.max(0, Math.min(6, advP2.level)) : 2,
          interlace: !!advP2.interlace,
        };
        const opt = await optimise(buf, oxiOpts2);
        if (opt && opt.byteLength < buf.byteLength) return new Blob([opt], { type: 'image/png' });
      } catch (e) { /* keep un-optimized */ }'''
assert OLD_OXI_2 in sw, 'oxipng call site 2 not found'
sw = sw.replace(OLD_OXI_2, NEW_OXI_2)
print('[r23] worker: PNG/OxiPNG (2 sites) extended')

# Also turn on extraOptimize by default IF user has touched png advanced
# (otherwise oxipng is opt-in only). Actually keep behavior — only run
# oxipng when settings.extraOptimize is set. Let's surface that via the
# advanced UI in a future round. For now the advanced.png.{level,interlace}
# only takes effect when extraOptimize is also true.

# However for R23 we should make oxipng kick in automatically when user
# has explicitly set non-default level. Simpler: enable extraOptimize
# whenever settings.advanced.png is present with level != null.
# Find the settings.extraOptimize check sites and adjust.
# Actually, the cleanest: in src/01-state-helpers' getSettings, set
# extraOptimize=true when png advanced has a non-default level OR interlace.
# This way the worker is unchanged.
OLD_GETSET_RETURN = '''return{mime:mimeMap[fmt]||'image/webp',quality:fmt==='gif'?undefined:q,maxDim:maxDim,resizePct:resizePct,stripExif:stripExif,advanced:advanced};
}
function _r23ReadAdvanced(){'''
NEW_GETSET_RETURN = '''/* R23 — when png advanced has been touched (non-default level or interlace on),
   auto-enable extraOptimize so oxipng actually runs. Otherwise leave it off
   to preserve the original "fast PNG by default" UX. */
  var _extraOpt = false;
  if (fmt === 'png' && advanced.png) {
    if ((advanced.png.level != null && advanced.png.level !== 2) || advanced.png.interlace) {
      _extraOpt = true;
    }
  }
  return{mime:mimeMap[fmt]||'image/webp',quality:fmt==='gif'?undefined:q,maxDim:maxDim,resizePct:resizePct,stripExif:stripExif,advanced:advanced,extraOptimize:_extraOpt};
}
function _r23ReadAdvanced(){'''
s01 = SRC01.read_text(encoding='utf-8')
assert OLD_GETSET_RETURN in s01, 'getSettings return + helper preamble not found for extraOptimize wiring'
s01 = s01.replace(OLD_GETSET_RETURN, NEW_GETSET_RETURN)
SRC01.write_text(s01, encoding='utf-8')
print('[r23] src/01: extraOptimize auto-enable when png advanced touched')

WORKER.write_text(sw, encoding='utf-8')
print(f'[r23] imgready-worker.js: {orig_w_len} -> {len(sw)} (+{len(sw)-orig_w_len})')

# =====================================================================
# Tail-sentinel assertions on all three files
# =====================================================================
final_index = INDEX.read_text(encoding='utf-8')
final_s01 = SRC01.read_text(encoding='utf-8')
final_w = WORKER.read_text(encoding='utf-8')
assert final_index.endswith('</body>\n</html>\n'), 'index.html tail broken'
assert '/* CHUNK_END:01-state-helpers v1 */' in final_s01[-100:], 'src/01 tail sentinel broken'
assert '/* WORKER_EOF */' in final_w[-50:], 'imgready-worker.js tail sentinel broken'
print('[r23] ALL TAIL SENTINELS OK')
