#!/usr/bin/env python3
"""R22 — Edit modal pro-feel completion + a11y + discoverability sweep.

Seven coherent items shipped together:
  1. Cursor: drop to crosshair during drag (3 brushes) via body[data-edit-dragging]
  2. Cursor: Caps Lock toggle to precise crosshair (Photoshop standard)
  3. 8px spacing grid normalize across Edit modal CSS
  4. focus-visible accent-color outline for keyboard accessibility
  5. Tab keys 1-5 jump to Adjust/Transform/Retouch/Add/Background
  6. Expanded shortcut tooltips on action buttons + tab buttons
  7. pi-actions auto-reveal on first solo-mode encode complete (discoverability)

R18 rule: all file mods via Python on /tmp/imgready-clone. Tail-byte assert.
"""
import re
from pathlib import Path

SRC = Path('/tmp/imgready-clone/index.html')
s = SRC.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r22] read {orig_len} bytes')

# =====================================================================
# Item 1+2: Cursor CSS — body data-attributes toggle crosshair on
#                       all 3 brush canvases. Uses !important to
#                       override the inline cursor URL set by the
#                       existing _bgRingCursor() / refreshCursor fns.
# =====================================================================
CURSOR_CSS = '''
  /* R22 — precise crosshair override during active drag OR when
     Caps Lock is engaged (Photoshop convention). Uses !important
     to beat the inline cursor:url(...) set by each brush's
     refreshCursor function. Selectors cover Pixelate, Blur, and
     BG-Refine canvases. */
  body[data-edit-dragging="on"] .edit-pixelate-canvas,
  body[data-edit-dragging="on"] .edit-blur-canvas,
  body[data-edit-dragging="on"] .bg-refine-canvas,
  body[data-edit-precise="on"] .edit-pixelate-canvas,
  body[data-edit-precise="on"] .edit-blur-canvas,
  body[data-edit-precise="on"] .bg-refine-canvas{
    cursor: crosshair !important;
  }
'''
# Insert just before "body[data-edit-open=\"true\"] .menu-card,"
MARK_CURSOR_INSERT = 'body[data-edit-open="true"] .menu-card,'
assert MARK_CURSOR_INSERT in s, 'cursor CSS insertion point not found'
s = s.replace(MARK_CURSOR_INSERT, CURSOR_CSS + '\n  ' + MARK_CURSOR_INSERT)
print('[r22] CSS: cursor override for drag + caps lock')

# =====================================================================
# Item 3: 8px grid normalize. Map current weird values to 4/8/12/16.
# =====================================================================
SPACING_PATCHES = [
    # Header padding 14px/18px → 16px/20px
    ('    height:48px;flex-shrink:0;\n    display:flex;align-items:center;gap:10px;\n    padding:0 14px 0 18px;',
     '    height:48px;flex-shrink:0;\n    display:flex;align-items:center;gap:12px;\n    padding:0 16px 0 20px;'),
    # Tabs padding 7px/10px → 8px/12px, gap 3px → 4px
    ('  .edit-modal .edit-tabs{\n    display:flex;gap:3px;padding:7px 10px;\n    border-bottom:1px solid rgba(255,255,255,.06);\n    flex-shrink:0;flex-wrap:nowrap;\n  }',
     '  .edit-modal .edit-tabs{\n    display:flex;gap:4px;padding:8px 12px;\n    border-bottom:1px solid rgba(255,255,255,.06);\n    flex-shrink:0;flex-wrap:nowrap;\n  }'),
    # Tab padding 7px/6px → 8px/8px, gap 3px → 4px
    ('  .edit-modal .edit-tab{\n    flex:1 1 0;min-width:0;\n    padding:7px 6px;border-radius:7px;\n    background:transparent;color:rgba(255,255,255,.55);\n    border:none;cursor:pointer;font-size:.72rem;font-weight:500;\n    transition:background .12s,color .12s;\n    display:flex;flex-direction:column;align-items:center;gap:3px;\n    line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\n  }',
     '  .edit-modal .edit-tab{\n    flex:1 1 0;min-width:0;\n    padding:8px 8px;border-radius:8px;\n    background:transparent;color:rgba(255,255,255,.55);\n    border:none;cursor:pointer;font-size:.72rem;font-weight:500;\n    transition:background .12s,color .12s;\n    display:flex;flex-direction:column;align-items:center;gap:4px;\n    line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;\n  }'),
    # Subtoggle: padding 3px → 4px, gap 3px → 4px, margin 10px → 12px
    ('  .edit-modal .edit-subtoggle{\n    display:flex;gap:3px;padding:3px;border-radius:8px;\n    background:rgba(255,255,255,.04);\n    border:1px solid rgba(255,255,255,.06);\n    margin:0 0 10px 0;\n  }',
     '  .edit-modal .edit-subtoggle{\n    display:flex;gap:4px;padding:4px;border-radius:8px;\n    background:rgba(255,255,255,.04);\n    border:1px solid rgba(255,255,255,.06);\n    margin:0 0 12px 0;\n  }'),
    # Subtab padding 6px 10px → 8px 12px, gap 5px → 6px
    ("  .edit-modal .edit-subtab{\n    flex:1 1 0;padding:6px 10px;border-radius:6px;\n    background:transparent;color:rgba(255,255,255,.55);\n    border:none;cursor:pointer;font-size:.76rem;font-weight:500;\n    display:inline-flex;align-items:center;justify-content:center;gap:5px;\n    transition:background .12s,color .12s;line-height:1;\n  }",
     "  .edit-modal .edit-subtab{\n    flex:1 1 0;padding:8px 12px;border-radius:6px;\n    background:transparent;color:rgba(255,255,255,.55);\n    border:none;cursor:pointer;font-size:.76rem;font-weight:500;\n    display:inline-flex;align-items:center;justify-content:center;gap:6px;\n    transition:background .12s,color .12s;line-height:1;\n  }"),
    # Edit body padding 14px/12px → 16px/16px, gap 12px → 16px
    ('  .edit-modal .edit-body{\n    flex:1;overflow-y:auto;overflow-x:hidden;\n    padding:14px 12px;\n    display:flex;flex-direction:column;gap:12px;\n  }',
     '  .edit-modal .edit-body{\n    flex:1;overflow-y:auto;overflow-x:hidden;\n    padding:16px 16px;\n    display:flex;flex-direction:column;gap:16px;\n  }'),
    # Actions row gap 6px → 8px, padding 8px/12px → 12px/16px
    ('  .edit-modal .edit-actions{\n    display:flex;align-items:center;gap:6px;width:100%;\n    padding:8px 12px;border-top:1px solid rgba(255,255,255,.07);\n    flex-shrink:0;flex-wrap:nowrap;\n  }\n  .edit-modal .edit-actions-row{\n    display:flex;align-items:center;gap:6px;width:100%;\n    flex-wrap:nowrap;\n  }',
     '  .edit-modal .edit-actions{\n    display:flex;align-items:center;gap:8px;width:100%;\n    padding:12px 16px;border-top:1px solid rgba(255,255,255,.07);\n    flex-shrink:0;flex-wrap:nowrap;\n  }\n  .edit-modal .edit-actions-row{\n    display:flex;align-items:center;gap:8px;width:100%;\n    flex-wrap:nowrap;\n  }'),
    # Btn padding 7px 14px → 8px 16px
    ('  .edit-modal .btn{\n    padding:7px 14px;border-radius:7px;\n    background:rgba(255,255,255,.08);color:#fff;\n    border:1px solid rgba(255,255,255,.14);\n    font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap;\n  }',
     '  .edit-modal .btn{\n    padding:8px 16px;border-radius:8px;\n    background:rgba(255,255,255,.08);color:#fff;\n    border:1px solid rgba(255,255,255,.14);\n    font-size:.82rem;font-weight:600;cursor:pointer;white-space:nowrap;\n  }'),
    # Btn primary min-width 78px / 7px 18px → 80px / 8px 20px
    ('  .edit-modal .edit-actions .btn-primary{flex:initial;min-width:78px;padding:7px 18px;}',
     '  .edit-modal .edit-actions .btn-primary{flex:initial;min-width:80px;padding:8px 20px;}'),
    # Btn-icon 28x28 → 32x32
    ('  .edit-modal .btn-icon{\n    width:28px;height:28px;padding:0;border-radius:6px;flex-shrink:0;\n    background:transparent;border:1px solid rgba(255,255,255,.12);\n    color:rgba(255,255,255,.55);font-size:.85rem;line-height:1;cursor:pointer;\n    display:inline-flex;align-items:center;justify-content:center;\n  }',
     '  .edit-modal .btn-icon{\n    width:32px;height:32px;padding:0;border-radius:8px;flex-shrink:0;\n    background:transparent;border:1px solid rgba(255,255,255,.12);\n    color:rgba(255,255,255,.55);font-size:.85rem;line-height:1;cursor:pointer;\n    display:inline-flex;align-items:center;justify-content:center;\n  }'),
    # History buttons gap 3px → 4px
    ('  .edit-modal .edit-history-btns{display:flex;gap:3px;flex-shrink:0;}',
     '  .edit-modal .edit-history-btns{display:flex;gap:4px;flex-shrink:0;}'),
]
applied = 0
for old, new in SPACING_PATCHES:
    if old in s:
        s = s.replace(old, new)
        applied += 1
    else:
        # try a few common whitespace variants — these are exact CSS strings so should match
        print(f'[r22] WARN: spacing patch missed: {old[:60]!r}…')
print(f'[r22] CSS: {applied}/{len(SPACING_PATCHES)} spacing normalizations applied')

# =====================================================================
# Item 4: focus-visible accent-color outlines for keyboard a11y.
# =====================================================================
FOCUS_CSS = '''
  /* R22 — focus-visible keyboard a11y across the Edit modal and the
     main app's pi-icon row. WCAG 2.1 SC 2.4.7 (Focus Visible) compliance.
     Uses :focus-visible (not :focus) so mouse clicks don't trigger the
     outline — only keyboard nav (Tab) does. */
  .edit-modal button:focus-visible,
  .edit-modal input[type="range"]:focus-visible,
  .edit-modal .edit-tab:focus-visible,
  .edit-modal .edit-subtab:focus-visible{
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .edit-modal input[type="text"]:focus-visible,
  .edit-modal input[type="number"]:focus-visible{
    outline: 2px solid var(--accent);
    outline-offset: 1px;
    border-color: var(--accent);
  }
  .pi-icon:focus-visible{
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .dz-format-pre button:focus-visible,
  .adjust-pills button:focus-visible{
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
'''
# Insert just before the cursor CSS block we just added — they're related
focus_anchor = 'body[data-edit-open="true"] .menu-card,'
s = s.replace(focus_anchor, FOCUS_CSS + '\n  ' + focus_anchor, 1)
print('[r22] CSS: focus-visible outlines')

# =====================================================================
# Item 5: Tab keys 1-5 in the editOpen keydown handler.
# Item 6 (partial): Cancel button tooltip "Cancel — Esc"
# =====================================================================
# Insert tab key handler after the bracket key handler from R21.
# Anchor: the closing of the bracket handler's else-if chain.
BRACKET_TAIL = '''    if (slider){
      const cur = parseInt(slider.value, 10);
      const step = (cur < 10) ? 1 : (cur < 50) ? 5 : (cur < 100) ? 10 : 20;
      const next = Math.max(parseInt(slider.min,10), Math.min(parseInt(slider.max,10), cur + dir * step));
      if (next !== cur){
        slider.value = String(next);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
      e.preventDefault();
    }
  }
});'''
NEW_BRACKET_TAIL = '''    if (slider){
      const cur = parseInt(slider.value, 10);
      const step = (cur < 10) ? 1 : (cur < 50) ? 5 : (cur < 100) ? 10 : 20;
      const next = Math.max(parseInt(slider.min,10), Math.min(parseInt(slider.max,10), cur + dir * step));
      if (next !== cur){
        slider.value = String(next);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
      }
      e.preventDefault();
    }
  }
  /* R22 — number keys 1-5 jump to Edit modal tabs. Adobe convention. */
  else if (/^[1-5]$/.test(e.key) && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey){
    const tabIds = ['adjust', 'transform', 'retouch', 'add', 'bg'];
    const idx = parseInt(e.key, 10) - 1;
    const target = document.querySelector('.edit-modal .edit-tab[data-tab="' + tabIds[idx] + '"]');
    if (target){ target.click(); e.preventDefault(); }
  }
  /* R22 — Caps Lock toggle for precise crosshair (Photoshop standard). */
  if (e.getModifierState && e.getModifierState('CapsLock')){
    document.body.dataset.editPrecise = 'on';
  } else {
    document.body.dataset.editPrecise = '';
  }
});
/* R22 — track Caps Lock state on keyup too (the key itself doesn't always
   fire a keydown for CapsLock toggles in all browsers; checking
   getModifierState on every keyup catches the state change reliably). */
document.addEventListener('keyup', e => {
  if (document.body.dataset.editOpen !== 'true') return;
  if (e.getModifierState && e.getModifierState('CapsLock')){
    document.body.dataset.editPrecise = 'on';
  } else {
    document.body.dataset.editPrecise = '';
  }
});
/* R22 — track active brush drag globally so the cursor swaps to a thin
   crosshair during a stroke (CSS rule above does the actual swap). */
document.addEventListener('pointerdown', e => {
  if (document.body.dataset.editOpen !== 'true') return;
  const t = e.target;
  if (t && t.classList && (t.classList.contains('edit-pixelate-canvas')
                       || t.classList.contains('edit-blur-canvas')
                       || t.classList.contains('bg-refine-canvas'))){
    document.body.dataset.editDragging = 'on';
  }
}, true);
document.addEventListener('pointerup',   () => { document.body.dataset.editDragging = ''; }, true);
document.addEventListener('pointercancel', () => { document.body.dataset.editDragging = ''; }, true);'''
assert BRACKET_TAIL in s, 'R21 bracket tail not found — cannot extend'
s = s.replace(BRACKET_TAIL, NEW_BRACKET_TAIL)
print('[r22] JS: tab keys + caps lock + drag tracker added')

# =====================================================================
# Item 6: Tooltip shortcut hints — Cancel, Save, Compare, tab buttons.
# Tab buttons get their hint dynamically in the openEditMode loop.
# =====================================================================
# Cancel button gets explicit "Esc" hint
old_cancel = '<button type="button" class="btn" onclick="cancelEdit()">Cancel</button>'
new_cancel = '<button type="button" class="btn" onclick="cancelEdit()" title="Cancel — Esc">Cancel</button>'
assert old_cancel in s, 'Cancel button not found'
s = s.replace(old_cancel, new_cancel)

# Save button — add Ctrl+Enter hint (commonly used "submit" shortcut, though we don't wire it)
# Skipping save tooltip since we don't actually bind Ctrl+Enter.

# Tab buttons: extend the inner-html template in openEditMode tab loop
# to include the numeric shortcut hint via title.
OLD_TAB_HTML = """    /* R20 - every tab gets an icon + label. */
    btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + (t.icon || 'i-arrow-left-right') + '"/></svg><span>' + t.label + '</span>';"""
NEW_TAB_HTML = """    /* R20 - every tab gets an icon + label. R22 - title carries shortcut hint. */
    btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + (t.icon || 'i-arrow-left-right') + '"/></svg><span>' + t.label + '</span>';
    btn.title = t.label + ' — ' + (i + 1);"""
assert OLD_TAB_HTML in s, 'tab html template not found'
s = s.replace(OLD_TAB_HTML, NEW_TAB_HTML)
print('[r22] tooltips: Cancel + tab buttons')

# =====================================================================
# Item 7: pi-actions auto-reveal on first solo-mode encode complete.
# Hook into hideCenterStatus() (line ~4308) — runs when encode completes.
# Use a session-scope flag so it only triggers on the first encode.
# =====================================================================
OLD_HIDE = '''function hideCenterStatus(){
  /* Tear down the defer window — if encode finished inside the 2000ms
     suppression, the timer never gets to fire (and never paints). */
  clearDeferCenterStatus();
  const el = document.getElementById('centerStatus');
  if (el) el.hidden = true;
  document.body.dataset.encoding = '';
  document.body.dataset.qualityEncoding = '';'''
NEW_HIDE = '''function hideCenterStatus(){
  /* Tear down the defer window — if encode finished inside the 2000ms
     suppression, the timer never gets to fire (and never paints). */
  clearDeferCenterStatus();
  const el = document.getElementById('centerStatus');
  if (el) el.hidden = true;
  document.body.dataset.encoding = '';
  document.body.dataset.qualityEncoding = '';
  /* R22 — discoverability: when a first encode lands in solo mode and
     the user hasn't yet seen the pi-action icons this session, reveal
     them once. The existing 3s auto-close timer dismisses naturally
     so the icons don't linger past the discovery moment. */
  if (!window._r22PiSeen
      && document.body.dataset.state === 'solo'
      && document.body.dataset.editOpen !== 'true'
      && document.body.dataset.piActions !== 'open'){
    window._r22PiSeen = true;
    setTimeout(() => {
      if (typeof openPiActions === 'function') openPiActions();
    }, 400);
  }'''
assert OLD_HIDE in s, 'hideCenterStatus prologue not found'
s = s.replace(OLD_HIDE, NEW_HIDE)
print('[r22] JS: pi-actions auto-reveal on first solo encode')

# =====================================================================
# Mobile breakpoint adjustments to keep proportions
# =====================================================================
MOBILE_PATCHES = [
    # Mobile edit-header padding 0 12px → 0 16px, gap 8px → 12px
    ('    .edit-modal .edit-header{height:42px;padding:0 12px;gap:8px;}',
     '    .edit-modal .edit-header{height:44px;padding:0 16px;gap:12px;}'),
    # Mobile edit-tabs padding 5px/8px → 8px/12px
    ('    .edit-modal .edit-tabs{padding:5px 8px;gap:2px;flex-wrap:nowrap;}',
     '    .edit-modal .edit-tabs{padding:8px 12px;gap:4px;flex-wrap:nowrap;}'),
    # Mobile tab padding 6px/4px → 8px/4px, gap 2px → 4px
    ('    .edit-modal .edit-tab{padding:6px 4px;font-size:.66rem;gap:2px;}',
     '    .edit-modal .edit-tab{padding:8px 4px;font-size:.66rem;gap:4px;}'),
    # Mobile body 10px → 12px
    ('    .edit-modal .edit-body{padding:10px 10px;gap:10px;min-height:0;}',
     '    .edit-modal .edit-body{padding:12px 12px;gap:12px;min-height:0;}'),
    # Mobile actions padding 6px/10px → 8px/12px
    ('    .edit-modal .edit-actions{padding:6px 10px;gap:4px;}',
     '    .edit-modal .edit-actions{padding:8px 12px;gap:8px;}'),
    # Mobile actions-row gap 5px → 8px
    ('    .edit-modal .edit-actions-row{gap:5px;}',
     '    .edit-modal .edit-actions-row{gap:8px;}'),
    # Mobile btn padding 6px/12px → 8px/14px
    ('    .edit-modal .btn{padding:6px 12px;font-size:.78rem;}',
     '    .edit-modal .btn{padding:8px 14px;font-size:.78rem;}'),
    # Mobile btn-icon 28x28 (already in r20 mobile) — bump to 32x32 to match desktop
    ('    .edit-modal .btn-icon{width:28px;height:28px;}',
     '    .edit-modal .btn-icon{width:32px;height:32px;}'),
    # Mobile btn-primary min-width 70px → 80px to match desktop
    ('    .edit-modal .edit-actions .btn-primary{min-width:70px;padding:6px 14px;}',
     '    .edit-modal .edit-actions .btn-primary{min-width:80px;padding:8px 16px;}'),
]
mobile_applied = 0
for old, new in MOBILE_PATCHES:
    if old in s:
        s = s.replace(old, new)
        mobile_applied += 1
    else:
        print(f'[r22] WARN: mobile patch missed: {old[:60]!r}…')
print(f'[r22] CSS: {mobile_applied}/{len(MOBILE_PATCHES)} mobile spacing patches applied')

# =====================================================================
# Write + tail-assert
# =====================================================================
SRC.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r22] wrote {final_len} bytes (delta {final_len - orig_len:+d})')
print(f'[r22] tail: {s[-30:]!r}')
assert s.endswith('</body>\n</html>\n'), 'TAIL ASSERT FAILED'
print('[r22] TAIL OK')
