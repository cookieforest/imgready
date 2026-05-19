#!/usr/bin/env python3
"""R27 — Edit modal restructure to match home/compress tool layout.

Was: 2-column grid (canvas 1fr | panel 380px). Header on top with h2 title.
Footer with actions stuck to bottom of right panel.

Now: 4 stacked horizontal regions:
  1. Top: liquid-glass brand bar with imgready wordmark + filename chip
     + Reset / Undo / Redo / Compare cluster + Cancel + Save
  2. Middle: full-width canvas area (flex:1, fills remaining space)
  3. Above bottom: per-tab options strip (max 240px tall, internal scroll
     if content overflows)
  4. Bottom: 5-tab navigation strip

Element IDs preserved (editPreviewCol, editBody, editTabs, editTitle,
all button IDs) so JS render functions still find their targets
unchanged. Substantial CSS rewrite of the edit-modal block.

Liquid glass = backdrop-filter: blur(20px) saturate(180%) on translucent
backgrounds (Apple HIG Big Sur+ pattern), already used by .pi-icon in
this codebase so the technique is proven.

Mobile: the vertical stack works natively without media query overrides
since we already removed the 2-col grid; just tighten paddings + tab
font size in the existing @media (max-width:640px) block.
"""
import re
from pathlib import Path

INDEX = Path('/tmp/imgready-clone/index.html')
s = INDEX.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r27] read {orig_len} bytes')

# =====================================================================
# 1. Replace the Edit modal HTML structure
# =====================================================================
OLD_MODAL_HTML = '''<div id="editModal" class="edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="editTitle">
  <div class="edit-modal-card">
    <header class="edit-header">
      <h2 id="editTitle">Edit</h2>
    </header>
    <div class="edit-layout">
      <div class="edit-preview-col" id="editPreviewCol"></div>
      <div class="edit-panel-col">
        <nav class="edit-tabs" role="tablist" id="editTabs"></nav>
        <main class="edit-body" id="editBody"></main>
        <!-- R20 footer: single row, size-info inline-left, history
             cluster (Reset / Undo / Redo / Compare) groups all
             non-destructive history ops together per Apple Photos and
             Pixlr E patterns; primary actions (Cancel / Save) on
             the right with the spacer between. -->
        <footer class="edit-actions">
          <span class="edit-size-info" id="editSizeInfo"></span>
          <button type="button" class="btn btn-ghost" id="editResetBtn" onclick="_editResetAll()" disabled title="Reset all edits">Reset</button>
          <div class="edit-history-btns">
            <button type="button" class="btn btn-icon" id="editUndoBtn" onclick="_editUndo()" disabled title="Undo (Ctrl+Z)" aria-label="Undo"><svg class="ico" aria-hidden="true"><use href="#i-undo"/></svg></button>
            <button type="button" class="btn btn-icon" id="editRedoBtn" onclick="_editRedo()" disabled title="Redo (Ctrl+Y)" aria-label="Redo"><svg class="ico" aria-hidden="true"><use href="#i-redo"/></svg></button>
            <button type="button" class="btn btn-icon" id="editCompareBtn" onclick="_toggleEditCompare()" title="View original" aria-label="View original"><svg class="ico" aria-hidden="true"><use href="#i-arrow-left-right"/></svg></button>
          </div>
          <span class="edit-actions-spacer" aria-hidden="true"></span>
          <button type="button" class="btn" onclick="cancelEdit()" title="Cancel — Esc">Cancel</button>
          <button type="button" class="btn btn-primary" id="editSaveBtn" onclick="saveEdit()">Save</button>
        </footer>
      </div>
    </div>'''

NEW_MODAL_HTML = '''<div id="editModal" class="edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="editTitle">
  <div class="edit-modal-card">
    <!-- R27 — liquid-glass brand bar at top. Wordmark left, filename
         chip center-left, history cluster + primary actions right.
         Matches the home/compress/convert tool top-chrome aesthetic so
         entering Edit mode reads as the same product, not a different
         page. -->
    <header class="edit-brand-bar">
      <a class="edit-brand" href="#" onclick="event.preventDefault();cancelEdit();" aria-label="Exit edit and return to imgready home">img<span class="g">ready</span></a>
      <span class="edit-filename" id="editTitle" aria-live="polite">Edit</span>
      <span class="edit-size-info" id="editSizeInfo"></span>
      <span class="edit-bar-spacer" aria-hidden="true"></span>
      <button type="button" class="btn btn-ghost" id="editResetBtn" onclick="_editResetAll()" disabled title="Reset all edits">Reset</button>
      <div class="edit-history-btns">
        <button type="button" class="btn btn-icon" id="editUndoBtn" onclick="_editUndo()" disabled title="Undo (Ctrl+Z)" aria-label="Undo"><svg class="ico" aria-hidden="true"><use href="#i-undo"/></svg></button>
        <button type="button" class="btn btn-icon" id="editRedoBtn" onclick="_editRedo()" disabled title="Redo (Ctrl+Y)" aria-label="Redo"><svg class="ico" aria-hidden="true"><use href="#i-redo"/></svg></button>
        <button type="button" class="btn btn-icon" id="editCompareBtn" onclick="_toggleEditCompare()" title="View original" aria-label="View original"><svg class="ico" aria-hidden="true"><use href="#i-arrow-left-right"/></svg></button>
      </div>
      <button type="button" class="btn" onclick="cancelEdit()" title="Cancel — Esc">Cancel</button>
      <button type="button" class="btn btn-primary" id="editSaveBtn" onclick="saveEdit()">Save</button>
    </header>
    <!-- R27 — canvas area fills middle. Element ID preserved so existing
         _renderXxxTab functions still write the image into this slot. -->
    <main class="edit-canvas-area" id="editPreviewCol"></main>
    <!-- R27 — per-tab options strip. Was the right-side panel body in
         R20-R26; now a horizontal strip below the canvas, max ~240px tall
         with internal scroll. Element ID preserved so JS render fns
         (Adjust/Transform/Retouch/Add/Background) write controls here. -->
    <section class="edit-options-strip" id="editBody" role="region" aria-label="Tool options"></section>
    <!-- R27 — bottom tab bar. 5 categorized tabs (R20) live here. -->
    <nav class="edit-tab-bar" role="tablist" id="editTabs" aria-label="Edit tools"></nav>'''

assert OLD_MODAL_HTML in s, 'Edit modal HTML block not found exactly'
s = s.replace(OLD_MODAL_HTML, NEW_MODAL_HTML)
print('[r27] HTML: edit modal restructured to 4-stack layout')

# =====================================================================
# 2. Replace the .edit-modal CSS block with new layout rules
# =====================================================================
# The OLD CSS block covers .edit-modal, .edit-modal-card, .edit-header,
# .edit-layout (2-col grid), .edit-preview-col, .edit-panel-col, .edit-tabs,
# .edit-tab, .edit-body, .edit-actions, .edit-actions-row, .edit-actions-spacer.
# I'll replace the structural rules; per-element rules (.edit-tab, .btn, etc.)
# are still needed in modified form.

OLD_LAYOUT_CSS = '''  .edit-modal{
    position:fixed;inset:0;z-index:9000;
    background:#0d0d10;
    display:flex;flex-direction:column;
    color:#fff;overflow:hidden;
  }
  .edit-modal[hidden]{display:none !important;}
  .edit-modal-card{
    background:#15151a;width:100%;height:100%;
    display:flex;flex-direction:column;overflow:hidden;position:relative;
  }
  .edit-modal .edit-header{
    height:48px;flex-shrink:0;
    display:flex;align-items:center;gap:12px;
    padding:0 16px 0 20px;
    border-bottom:1px solid rgba(255,255,255,.07);
  }
  .edit-modal .edit-header h2{
    margin:0;font-size:.95rem;font-weight:600;
    flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  }
  .edit-layout{
    flex:1;min-height:0;
    display:grid;grid-template-columns:1fr 380px;
    overflow:hidden;
  }
  .edit-preview-col{
    background:#0a0a0c;
    display:flex;align-items:center;justify-content:center;
    overflow:hidden;position:relative;
  }
  .edit-panel-col{
    display:flex;flex-direction:column;
    border-left:1px solid rgba(255,255,255,.07);
    background:#15151a;overflow:hidden;
  }'''

NEW_LAYOUT_CSS = '''  /* R27 — Edit modal layout rebuild. 4 stacked horizontal regions:
     brand bar (top) → canvas (flex:1) → options strip → tab bar (bottom).
     Removes the previous 2-col grid (canvas | right panel). Liquid-glass
     backdrop-filter on the chrome surfaces matches the rest of the app's
     translucent treatment (already used by .pi-icon). */
  .edit-modal{
    position:fixed;inset:0;z-index:9000;
    background:#0a0a0c;
    display:flex;flex-direction:column;
    color:#fff;overflow:hidden;
  }
  .edit-modal[hidden]{display:none !important;}
  .edit-modal-card{
    background:#0a0a0c;width:100%;height:100%;
    display:flex;flex-direction:column;overflow:hidden;position:relative;
  }
  /* R27 — liquid glass top bar */
  .edit-modal .edit-brand-bar{
    height:56px;flex-shrink:0;z-index:10;
    display:flex;align-items:center;gap:10px;
    padding:0 16px;
    background:rgba(15,15,18,.72);
    backdrop-filter:blur(20px) saturate(180%);
    -webkit-backdrop-filter:blur(20px) saturate(180%);
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .edit-modal .edit-brand{
    font-family:var(--font-display);
    font-style:italic;font-weight:600;font-size:1.05rem;
    color:#fff;text-decoration:none;
    letter-spacing:-.01em;
    transition:opacity .12s;
    flex-shrink:0;
  }
  .edit-modal .edit-brand:hover{opacity:.85;}
  .edit-modal .edit-brand .g{color:var(--accent);}
  .edit-modal .edit-brand:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px;}
  .edit-modal .edit-filename{
    font-family:var(--font-mono);
    font-size:.78rem;color:rgba(255,255,255,.7);
    background:rgba(255,255,255,.06);
    padding:5px 10px;border-radius:6px;
    flex:0 1 auto;min-width:0;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    max-width:380px;
  }
  .edit-modal .edit-bar-spacer{flex:1 1 auto;min-width:8px;}
  .edit-modal .edit-brand-bar .edit-size-info{
    font-family:var(--font-mono);
    font-size:.7rem;color:rgba(255,255,255,.45);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    max-width:200px;flex:0 1 auto;
  }
  /* R27 — canvas area, full-flex middle */
  .edit-modal .edit-canvas-area{
    flex:1 1 auto;min-height:0;
    background:#0a0a0c;
    display:flex;align-items:center;justify-content:center;
    overflow:hidden;position:relative;
  }
  /* R27 — per-tab options strip. Auto-sizes to content but capped at 240px
     so the canvas never gets crushed. Overflowing content scrolls
     vertically within the strip. Empty strip collapses entirely. */
  .edit-modal .edit-options-strip{
    flex:0 0 auto;
    max-height:240px;overflow-y:auto;overflow-x:hidden;
    padding:12px 16px;
    background:rgba(15,15,18,.65);
    backdrop-filter:blur(20px) saturate(180%);
    -webkit-backdrop-filter:blur(20px) saturate(180%);
    border-top:1px solid rgba(255,255,255,.06);
    display:flex;flex-direction:column;gap:12px;
  }
  .edit-modal .edit-options-strip:empty{display:none;}'''

assert OLD_LAYOUT_CSS in s, 'old layout CSS block not found exactly'
s = s.replace(OLD_LAYOUT_CSS, NEW_LAYOUT_CSS)
print('[r27] CSS: layout block replaced (canvas full-width, options strip, brand bar)')

# =====================================================================
# 3. Update the tab bar CSS — move from top-of-panel to bottom-of-modal
# =====================================================================
OLD_TAB_BAR = '''  /* R20 - categorized icon+label tabs.
     Was: 7 flat photo tabs in a horizontally-scrolling row with edge-
     fade mask. At 380px panel width the labels overflowed and forced
     scroll, the canonical "toolbar overflow" anti-pattern (Pixlr X,
     Apple Photos, Canva all use grouped tabs instead). Now: 5 equal-
     width tabs each with a Lucide glyph + short label, no scroll. */
  .edit-modal .edit-tabs{
    display:flex;gap:4px;padding:8px 12px;
    border-bottom:1px solid rgba(255,255,255,.06);
    flex-shrink:0;flex-wrap:nowrap;
  }'''

NEW_TAB_BAR = '''  /* R27 — categorized icon+label tabs, now at BOTTOM of modal as a
     persistent tab-bar nav (matching iOS/iPadOS pattern). The selector
     stays .edit-tab-bar for the new structural element; .edit-tabs is
     also styled the same way as a fallback in case any future render
     uses the legacy class. */
  .edit-modal .edit-tab-bar,
  .edit-modal .edit-tabs{
    display:flex;gap:4px;padding:10px 16px 12px;
    background:rgba(15,15,18,.82);
    backdrop-filter:blur(20px) saturate(180%);
    -webkit-backdrop-filter:blur(20px) saturate(180%);
    border-top:1px solid rgba(255,255,255,.08);
    flex-shrink:0;flex-wrap:nowrap;
  }'''
assert OLD_TAB_BAR in s, 'R20 tab bar block not found'
s = s.replace(OLD_TAB_BAR, NEW_TAB_BAR)
print('[r27] CSS: tab bar moved to bottom with liquid-glass treatment')

# =====================================================================
# 4. Old .edit-body CSS — already aliased via #editBody == .edit-options-strip.
#    The legacy class .edit-body still exists in CSS. Make it a no-op now.
# =====================================================================
OLD_EDIT_BODY = '''  .edit-modal .edit-body{
    flex:1;overflow-y:auto;overflow-x:hidden;
    padding:16px 16px;
    display:flex;flex-direction:column;gap:16px;
  }'''
NEW_EDIT_BODY = '''  /* R27 — legacy .edit-body styling kept for any inline references;
     same rules as .edit-options-strip so nothing breaks. */
  .edit-modal .edit-body{
    overflow-y:auto;overflow-x:hidden;
    padding:0;
    display:flex;flex-direction:column;gap:12px;
  }'''
if OLD_EDIT_BODY in s:
    s = s.replace(OLD_EDIT_BODY, NEW_EDIT_BODY)
    print('[r27] CSS: legacy .edit-body harmonized with strip behavior')
else:
    print('[r27] WARN: legacy .edit-body block not found (already swapped?)')

# =====================================================================
# 5. Old footer CSS — defang the old .edit-actions selector since the
#    footer element is gone. Replace with empty rule to avoid bleed.
# =====================================================================
OLD_ACTIONS_CSS = '''  /* R20 - single-row footer (further compaction from R12).
     size-info is no longer its own row - it lives inline left of the
     history controls, ellipsis-truncated so it never pushes buttons.
     This reclaims ~12px more vertical for the canvas. */
  .edit-modal .edit-actions{
    display:flex;align-items:center;gap:8px;width:100%;
    padding:12px 16px;border-top:1px solid rgba(255,255,255,.07);
    flex-shrink:0;flex-wrap:nowrap;
  }
  .edit-modal .edit-actions-row{
    display:flex;align-items:center;gap:8px;width:100%;
    flex-wrap:nowrap;
  }
  .edit-modal .edit-actions-spacer{flex:1 1 auto;min-width:0;}'''
NEW_ACTIONS_CSS = '''  /* R27 — old .edit-actions footer is gone; actions moved to the
     brand bar. These selectors are kept as no-ops for any
     accidentally-still-referenced legacy DOM. */
  .edit-modal .edit-actions,
  .edit-modal .edit-actions-row{display:contents;}
  .edit-modal .edit-actions-spacer{display:none;}'''
assert OLD_ACTIONS_CSS in s, 'R20 actions footer CSS not found'
s = s.replace(OLD_ACTIONS_CSS, NEW_ACTIONS_CSS)
print('[r27] CSS: legacy .edit-actions footer rules defanged')

# =====================================================================
# 6. Mobile breakpoint — the layout is already vertical so just tighten
#    the brand bar height and tab bar padding to fit narrow screens.
# =====================================================================
OLD_MOBILE = '''    /* Mobile layout overhaul: preview hogs vertical space; controls compact. */
    .edit-modal .edit-header{height:44px;padding:0 16px;gap:12px;}
    .edit-modal .edit-header h2{font-size:.86rem;}
    .edit-layout{grid-template-columns:1fr;grid-template-rows:minmax(36vh,1fr) auto;}
    .edit-panel-col{
      border-left:none;border-top:1px solid rgba(255,255,255,.07);
      max-height:60vh;
    }'''
NEW_MOBILE = '''    /* R27 — mobile layout. The desktop layout is ALREADY vertical
       so most adjustments are size tweaks rather than reflow. */
    .edit-modal .edit-brand-bar{height:48px;padding:0 12px;gap:8px;}
    .edit-modal .edit-brand{font-size:.95rem;}
    .edit-modal .edit-filename{font-size:.72rem;padding:4px 8px;max-width:140px;}
    .edit-modal .edit-options-strip{max-height:180px;padding:10px 12px;gap:10px;}
    /* legacy .edit-layout / .edit-panel-col selectors no longer exist
       in markup; explicit display:none on any vestigial appearance. */
    .edit-modal .edit-layout, .edit-modal .edit-panel-col{display:none !important;}'''
if OLD_MOBILE in s:
    s = s.replace(OLD_MOBILE, NEW_MOBILE)
    print('[r27] CSS: mobile breakpoint updated for new structure')
else:
    print('[r27] WARN: old mobile block not matched — leaving prior mobile rules in place')

# =====================================================================
# 7. Update openEditMode() to set the filename in the new chip
#    (the existing JS already writes "Edit \\u2014 filename" to the
#    element with id="editTitle", which is now the .edit-filename
#    span). Verify the line is intact.
# =====================================================================
TITLE_SET = """if (title) title.textContent = `Edit \\u2014 ${f.name || 'image'}`;"""
if TITLE_SET in s:
    print('[r27] openEditMode title-set is intact — filename will populate the chip')
else:
    # try alternate quotes
    if "title.textContent" in s:
        print('[r27] title-set line variant present — filename should still populate')
    else:
        print('[r27] WARN: title-set line not found, filename chip may stay empty')

# Tighten the filename copy: drop the "Edit — " prefix since the bar
# now visually conveys we're in Edit mode. Just show the filename.
NEW_TITLE_SET = """if (title) title.textContent = (f.name || 'image');"""
if TITLE_SET in s:
    s = s.replace(TITLE_SET, NEW_TITLE_SET)
    print('[r27] JS: filename chip drops "Edit — " prefix (redundant in new bar)')

# =====================================================================
# Tail assert + write
# =====================================================================
INDEX.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r27] index.html: {orig_len} -> {final_len} (delta {final_len - orig_len:+d})')
assert s.endswith('</body>\n</html>\n'), 'tail broken'
print('[r27] TAIL OK')
