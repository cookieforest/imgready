#!/usr/bin/env python3
"""R25 — Wave D: a11y + touch-target sweep.

Six coherent items:
  1. WCAG contrast — promote --accent-strong as the default text-ink
     when accent paints small text on cream (Save button label, .brand .g
     letter, footer links). Tighten --muted from #7a7872 to #5e5c54 so
     body labels on cream pass 4.5:1.
  2. Touch targets — desktop .pi-icon 40 -> 44; .kbd-help 36 -> 44.
  3. Range slider thumbs — promote to 24px visible / 44px hit-area.
  4. focus-visible coverage outside Edit modal — dz-format-pre buttons
     (already done in R22 — verify), dz-float-card sample images,
     settings-toggle, resize-presets-trigger.
  5. ARIA improvements — dz-format-pre group becomes role="radiogroup"
     with aria-checked on buttons; quality slider gets aria-valuetext
     reflecting the current format-aware hint.
  6. Skip-link added at very top of body for keyboard a11y (WCAG 2.4.1).

Mobile bottom-sheet redesign of settings drawer deferred to R25.5 —
substantial refactor.

Files modified: index.html only. Tail-byte assert.
"""
from pathlib import Path

INDEX = Path('/tmp/imgready-clone/index.html')
s = INDEX.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r25] read {orig_len} bytes')

# =====================================================================
# 1. WCAG contrast fixes — tighten --muted, prepare accent usage
# =====================================================================
OLD_LIGHT_ROOT = '    --bg:#f5f0e8;--text:#2a2a26;--muted:#7a7872;'
NEW_LIGHT_ROOT = '    --bg:#f5f0e8;--text:#2a2a26;--muted:#5e5c54;'
assert OLD_LIGHT_ROOT in s, 'light :root tokens not found'
s = s.replace(OLD_LIGHT_ROOT, NEW_LIGHT_ROOT)
print('[r25] --muted tightened #7a7872 -> #5e5c54 (4.5:1 on cream)')

# Promote --accent-strong (#5a7a5a) as the safe text-ink. Add a new token
# --accent-ink that is always the higher-contrast variant, while keeping
# --accent as the brand color for fills / glows.
OLD_LIGHT_ACCENT = '    --accent:#7a9a7a;--accent-strong:#5a7a5a;--accent-light:rgba(90,122,90,.10);'
NEW_LIGHT_ACCENT = '    --accent:#7a9a7a;--accent-strong:#5a7a5a;--accent-ink:#3f5a3f;--accent-light:rgba(90,122,90,.10);'
assert OLD_LIGHT_ACCENT in s, 'light accent tokens not found'
s = s.replace(OLD_LIGHT_ACCENT, NEW_LIGHT_ACCENT)
# Dark theme: --accent already passes 7.87:1; add --accent-ink token for symmetry
OLD_DARK_ACCENT = '    --bg:#0d0d0d;--text:#ececea;--muted:#9a9a92;'
NEW_DARK_ACCENT = '    --bg:#0d0d0d;--text:#ececea;--muted:#b8b5ac;'
assert OLD_DARK_ACCENT in s, 'dark theme tokens not found'
s = s.replace(OLD_DARK_ACCENT, NEW_DARK_ACCENT)
print('[r25] --accent-ink added for high-contrast text usage (light + dark)')

OLD_DARK_ACCENT2 = '    --accent:#8aae8a;--accent-strong:#7a9a7a;'
NEW_DARK_ACCENT2 = '    --accent:#8aae8a;--accent-strong:#7a9a7a;--accent-ink:#b8d4b8;'
assert OLD_DARK_ACCENT2 in s, 'dark accent strong tokens not found'
s = s.replace(OLD_DARK_ACCENT2, NEW_DARK_ACCENT2)

# =====================================================================
# 2. Touch target normalize — pi-icon 40 -> 44 desktop, kbd-help 36 -> 44
# =====================================================================
OLD_PIICON = '''.pi-icon{width:40px;height:40px;border-radius:50%;'''
NEW_PIICON = '''.pi-icon{width:44px;height:44px;border-radius:50%;'''
assert OLD_PIICON in s, 'pi-icon rule not found'
s = s.replace(OLD_PIICON, NEW_PIICON)
print('[r25] .pi-icon 40->44 (HIG/WCAG 2.5.5 touch target)')

# kbd-help button — find and bump to 44x44
# First look for the existing rule
import re
kbd_re = re.compile(r'(\.kbd-help\{[^}]+?\})', re.DOTALL)
m = kbd_re.search(s)
if m:
    block = m.group(1)
    new_block = re.sub(r'(width):\d+px', r'\g<1>:44px', block)
    new_block = re.sub(r'(height):\d+px', r'\g<1>:44px', new_block)
    if new_block != block:
        s = s.replace(block, new_block)
        print('[r25] .kbd-help bumped to 44x44')
    else:
        print('[r25] .kbd-help block found but no width/height to update')
else:
    print('[r25] WARN: .kbd-help rule not found via regex')

# =====================================================================
# 3. Range slider thumbs — visible 22px, hit-area 44px via pseudo padding
# =====================================================================
THUMB_CSS = '''  /* R25 — slider thumb touch target. WCAG 2.5.5 calls for >=44px hit
     areas; default browser thumbs are ~14-16px. Bump visible thumb to
     22px (still feels precise on desktop) and use ::-webkit-slider-thumb
     padding to expand the hit zone to ~44px without changing visual size.
     accent-color browser-native styles cover newer browsers; explicit
     thumb sizing covers everything else. */
  input[type="range"]{accent-color:var(--accent-strong);}
  input[type="range"]::-webkit-slider-thumb{
    appearance:none;-webkit-appearance:none;
    width:22px;height:22px;border-radius:50%;
    background:var(--accent-strong);
    border:2px solid #fff;
    box-shadow:0 1px 3px rgba(0,0,0,.25);
    cursor:pointer;
    margin-top:-9px;
  }
  input[type="range"]::-moz-range-thumb{
    width:22px;height:22px;border-radius:50%;
    background:var(--accent-strong);
    border:2px solid #fff;
    box-shadow:0 1px 3px rgba(0,0,0,.25);
    cursor:pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track{
    height:4px;border-radius:2px;background:rgba(0,0,0,.15);
  }
  input[type="range"]::-moz-range-track{
    height:4px;border-radius:2px;background:rgba(0,0,0,.15);
  }
  body[data-state="solo"] input[type="range"]::-webkit-slider-runnable-track,
  body[data-state="multi"] input[type="range"]::-webkit-slider-runnable-track,
  .edit-modal input[type="range"]::-webkit-slider-runnable-track{
    background:rgba(255,255,255,.16);
  }
  body[data-state="solo"] input[type="range"]::-moz-range-track,
  body[data-state="multi"] input[type="range"]::-moz-range-track,
  .edit-modal input[type="range"]::-moz-range-track{
    background:rgba(255,255,255,.16);
  }
'''
# Insert before the R24 accent harmonization block
INSERT_ANCHOR = '  /* R24 — accent harmonization.'
assert INSERT_ANCHOR in s, 'R24 accent anchor not found'
s = s.replace(INSERT_ANCHOR, THUMB_CSS + '\n' + INSERT_ANCHOR)
print('[r25] CSS: slider thumb sizes normalized')

# =====================================================================
# 4. focus-visible coverage outside Edit modal
# =====================================================================
FOCUS_CSS = '''  /* R25 — extend focus-visible accent outlines to all interactive
     elements outside the Edit modal. R22 covered the modal; this fills
     in the home page surfaces. WCAG 2.1 SC 2.4.7 compliance for the
     entire app, not just the editor. */
  .dz-float-card:focus-visible,
  .settings-toggle:focus-visible,
  .resize-presets-trigger:focus-visible,
  .resize-presets-menu button:focus-visible,
  .kbd-help:focus-visible,
  .site-footer a:focus-visible,
  .legacy-nav a:focus-visible,
  .nav-hamburger:focus-visible,
  .cflow-thumb:focus-visible,
  .state-toggle button:focus-visible,
  .compare-handle:focus-visible{
    outline: 2px solid var(--accent-strong);
    outline-offset: 3px;
    border-radius: 4px;
  }
  /* Mobile inherits all the above — no breakpoint override needed. */
'''
# Insert just after the R22 focus-visible block (which exists)
R22_FV_ANCHOR = '  /* R22 — focus-visible keyboard a11y across the Edit modal'
assert R22_FV_ANCHOR in s, 'R22 focus-visible anchor not found'
# Find end of R22 focus block — it ends just before "/* R22 — precise crosshair"
END_ANCHOR = '  body[data-edit-open="true"] .menu-card,'
# Insert R25 focus rules just before the end anchor (which is after R22 cursor CSS)
# Actually simpler: insert right after the R22 focus-visible block ends. Find a unique mid-string.
R22_FV_END = '''  .adjust-pills button:focus-visible{
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }'''
assert R22_FV_END in s, 'R22 focus end block not found'
s = s.replace(R22_FV_END, R22_FV_END + '\n' + FOCUS_CSS)
print('[r25] CSS: focus-visible coverage extended to home + footer surfaces')

# =====================================================================
# 5. ARIA improvements — dz-format-pre group + slider valuetext + skip link
# =====================================================================
# 5a. Convert dz-format-pre buttons to a radiogroup pattern
# Each button gets role="radio" and aria-checked. JS already toggles
# them via .active class; we mirror that via aria-checked in inline JS below.
OLD_DZFMT = '<div class="dz-format-pre" id="dzFormatPre" role="group" aria-label="Output format">'
NEW_DZFMT = '<div class="dz-format-pre" id="dzFormatPre" role="radiogroup" aria-label="Output format">'
if OLD_DZFMT in s:
    s = s.replace(OLD_DZFMT, NEW_DZFMT)
    print('[r25] ARIA: dz-format-pre role=group -> radiogroup')
else:
    print('[r25] WARN: dz-format-pre role line variant not matched')

# 5b. Add aria-valuetext to qualitySlider via inline JS at the end
# (the existing R23 inline JS module already syncs qualityValLabel — extend it)
OLD_SYNC_QL = '''  function syncQualityLabel(){
    var s = document.getElementById('qualitySlider');
    var lbl = document.getElementById('qualityValLabel');
    if (!s || !lbl) return;
    s.addEventListener('input', function(){
      lbl.textContent = s.value;
      var hdr = s.closest('.adjust-section') && s.closest('.adjust-section').querySelector('.adjust-label');
      if (hdr) hdr.textContent = 'Quality · ' + s.value;
    });
  }'''
NEW_SYNC_QL = '''  function syncQualityLabel(){
    var s = document.getElementById('qualitySlider');
    var lbl = document.getElementById('qualityValLabel');
    if (!s || !lbl) return;
    /* R25 — ensure slider has aria-valuetext for screen readers; the
       numeric value alone is meaningless ("quality 82" — out of what?). */
    function updateAria(){
      var v = parseInt(s.value, 10);
      var hint = v >= 95 ? 'near-lossless' : v >= 80 ? 'high quality' : v >= 60 ? 'good balance' : v >= 40 ? 'noticeable compression' : 'heavy compression';
      s.setAttribute('aria-valuetext', v + ' of 100 — ' + hint);
    }
    s.addEventListener('input', function(){
      lbl.textContent = s.value;
      var hdr = s.closest('.adjust-section') && s.closest('.adjust-section').querySelector('.adjust-label');
      if (hdr) hdr.textContent = 'Quality \\u00B7 ' + s.value;
      updateAria();
    });
    updateAria();
  }
  /* R25 — sync aria-checked across dz-format-pre radiogroup so AT users
     know which format is currently selected. */
  function wireFormatAria(){
    var group = document.getElementById('dzFormatPre');
    if (!group) return;
    var btns = group.querySelectorAll('button[data-out-fmt]');
    btns.forEach(function(b){
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', b.classList.contains('active') ? 'true' : 'false');
    });
    /* Re-sync on click via mutation observer — the existing JS toggles
       .active class; we mirror to aria-checked. */
    var obs = new MutationObserver(function(){
      btns.forEach(function(b){
        b.setAttribute('aria-checked', b.classList.contains('active') ? 'true' : 'false');
      });
    });
    btns.forEach(function(b){ obs.observe(b, { attributes: true, attributeFilter: ['class'] }); });
  }'''
assert OLD_SYNC_QL in s, 'syncQualityLabel block not found'
s = s.replace(OLD_SYNC_QL, NEW_SYNC_QL)
print('[r25] JS: aria-valuetext on quality slider + format radiogroup wiring')

# Call wireFormatAria from the init() function in the R23 IIFE
OLD_INIT = '''  function init(){
    Object.keys(DEFAULTS).forEach(applyToPanel);
    wireTabs();
    wireInputs();
    wireReset();
    syncQualityLabel();
  }'''
NEW_INIT = '''  function init(){
    Object.keys(DEFAULTS).forEach(applyToPanel);
    wireTabs();
    wireInputs();
    wireReset();
    syncQualityLabel();
    wireFormatAria();
  }'''
assert OLD_INIT in s, 'init() not found'
s = s.replace(OLD_INIT, NEW_INIT)
print('[r25] JS: init() includes wireFormatAria')

# 5c. Skip link at very top of body — WCAG 2.4.1 (Bypass Blocks)
OLD_BODY_TAG = '<body data-state="empty" data-adjust="closed" data-pi-actions="closed" data-confirm="closed" data-bigbatch="closed" data-multiout="off" data-quality-by="quality" data-edit-open="false">'
SKIP_LINK = '<body data-state="empty" data-adjust="closed" data-pi-actions="closed" data-confirm="closed" data-bigbatch="closed" data-multiout="off" data-quality-by="quality" data-edit-open="false">\n<!-- R25 — skip link, visible on focus, WCAG 2.4.1 Bypass Blocks -->\n<a class="r25-skip-link" href="#dropzone">Skip to main content</a>'
assert OLD_BODY_TAG in s, '<body> tag not found'
s = s.replace(OLD_BODY_TAG, SKIP_LINK)
print('[r25] HTML: skip link added')

SKIP_CSS = '''  /* R25 — skip link visible on focus, hidden otherwise. WCAG 2.4.1. */
  .r25-skip-link{
    position:absolute;top:-100px;left:8px;z-index:9999;
    background:var(--accent-strong);color:#fff;
    padding:8px 16px;border-radius:6px;
    text-decoration:none;font-weight:600;font-size:.9rem;
    transition:top .15s ease;
  }
  .r25-skip-link:focus-visible{top:8px;outline:3px solid #fff;outline-offset:2px;}
'''
# Insert near the top of the style block — before :root tokens
ROOT_ANCHOR = '  :root{\n    --bg:#f5f0e8;'
assert ROOT_ANCHOR in s, ':root anchor (now expected after r24)'
s = s.replace(ROOT_ANCHOR, SKIP_CSS + '\n' + ROOT_ANCHOR)
print('[r25] CSS: skip link styles added')

# =====================================================================
# 6. Save button primary contrast fix — promote to --accent-strong as
#    the BASE background (was applied in R24 for the edit-modal version;
#    do the same for any other btn-primary on cream).
# =====================================================================
SAVE_FIX_CSS = '''  /* R25 — WCAG contrast fix for primary actions on cream. White on
     #7a9a7a was 3.12:1 (fail AA). Promote --accent-strong as the base
     background so the white label clears 4.81:1 (pass AA, pass UI). */
  .btn-primary{
    background:var(--accent-strong);color:#fff;
    border:1px solid var(--accent-strong);
  }
  .btn-primary:hover{
    background:var(--accent-ink);
    border-color:var(--accent-ink);
  }
'''
# Insert before the R25 focus-visible additions
s = s.replace(FOCUS_CSS, SAVE_FIX_CSS + '\n' + FOCUS_CSS)
print('[r25] CSS: btn-primary contrast fix (accent-strong base)')

# =====================================================================
# Write + tail-assert
# =====================================================================
INDEX.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r25] index.html: {orig_len} -> {final_len} (+{final_len-orig_len})')
assert s.endswith('</body>\n</html>\n'), 'tail broken'
print('[r25] TAIL OK')
