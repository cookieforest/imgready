#!/usr/bin/env python3
"""R28 — Edit modal rebuild to mirror home page solo-state layout.

R27 was wrong:
- Brand bar elements stacked vertically (Save had flex:1 from a legacy
  rule that used to be overridden by .edit-actions .btn-primary;
  removing .edit-actions left flex:1 unopposed → Save stretched
  full-width, breaking row layout perception).
- The bottom didn't mirror the home .menu-card pattern at all.
- Image had chrome above AND below (brand bar + options + tabs), not
  truly full-height.

R28 mirrors the home page solo-state exactly:
- Image canvas fills inset:0 (true full-viewport)
- Top floats a minimal brand-mark + filename chip pair (translucent
  glass pills, pointer-events only on chips, transparent between)
- Bottom floats a single .menu-card with solid #1a1a1a (no backdrop-
  filter — comment in home CSS explicitly says it causes white-flash
  bugs), border-radius:14px, containing:
   - options strip on top (only renders when active tab has controls)
   - bottom row with: tabs (flex:1) + actions cluster (history + Cancel + Save)

DOM IDs preserved. Existing render functions write to editPreviewCol
+ editBody + editTitle unchanged.

Hard fixes:
- .btn-primary flex:1 explicitly overridden via flex:initial !important
  in the new actions cluster.
"""
from pathlib import Path

INDEX = Path('/tmp/imgready-clone/index.html')
s = INDEX.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r28] read {orig_len} bytes')

# =====================================================================
# Replace the R27 modal HTML with the new structure
# =====================================================================
OLD_MODAL_HTML = '''<div id="editModal" class="edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="editTitle">
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

NEW_MODAL_HTML = '''<div id="editModal" class="edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="editTitle">
  <!-- R28 — image canvas fills the viewport (inset:0). All chrome
       floats over it. Mirrors how the home solo state composes its
       .image-canvas with .top-chrome + .menu-card overlays. -->
  <main class="edit-canvas-area" id="editPreviewCol"></main>
  <!-- R28 — floating top chrome: two translucent pills (brand link +
       filename chip). pointer-events:none on container so canvas
       interactions (drag compare slider, etc.) pass through the empty
       space between the pills. -->
  <div class="edit-top-chrome">
    <a class="edit-brand-link" href="#" onclick="event.preventDefault();cancelEdit();" aria-label="Exit edit and return to imgready home">img<span class="g">ready</span></a>
    <span class="edit-filename-chip" id="editTitle" aria-live="polite">Edit</span>
    <span class="edit-size-info" id="editSizeInfo"></span>
  </div>
  <!-- R28 — bottom menu card mirroring home .menu-wrap > .menu-card.
       Solid #1a1a1a background (no backdrop-filter — see home CSS
       comment about white-flash on backdrop-filtered animating containers).
       Two stacked sections: options strip (only renders when active tab
       has controls; auto-collapses via :empty) + bottom row of tabs +
       action cluster. -->
  <div class="edit-menu-wrap">
    <div class="edit-menu-card">
      <section class="edit-options-strip" id="editBody" role="region" aria-label="Tool options"></section>
      <div class="edit-menu-bottom-row">
        <nav class="edit-tab-bar" role="tablist" id="editTabs" aria-label="Edit tools"></nav>
        <div class="edit-actions-cluster">
          <button type="button" class="btn btn-ghost" id="editResetBtn" onclick="_editResetAll()" disabled title="Reset all edits">Reset</button>
          <button type="button" class="btn btn-icon" id="editUndoBtn" onclick="_editUndo()" disabled title="Undo (Ctrl+Z)" aria-label="Undo"><svg class="ico" aria-hidden="true"><use href="#i-undo"/></svg></button>
          <button type="button" class="btn btn-icon" id="editRedoBtn" onclick="_editRedo()" disabled title="Redo (Ctrl+Y)" aria-label="Redo"><svg class="ico" aria-hidden="true"><use href="#i-redo"/></svg></button>
          <button type="button" class="btn btn-icon" id="editCompareBtn" onclick="_toggleEditCompare()" title="View original" aria-label="View original"><svg class="ico" aria-hidden="true"><use href="#i-arrow-left-right"/></svg></button>
          <button type="button" class="btn" onclick="cancelEdit()" title="Cancel — Esc">Cancel</button>
          <button type="button" class="btn btn-primary" id="editSaveBtn" onclick="saveEdit()">Save</button>
        </div>
      </div>
    </div>
  </div>'''

assert OLD_MODAL_HTML in s, 'R27 modal HTML block not found'
# Note: the R27 markup did not have a closing </div> for .edit-modal-card,
# so we need to close .edit-modal correctly. Also remove the obsolete
# .edit-modal-card wrapper since R28 uses .edit-modal directly.
# Find the closing structure that follows the old modal:
OLD_MODAL_CLOSE = '''  </div>
</div>

<!-- Bulk batch progress'''
NEW_MODAL_CLOSE = '''
</div>

<!-- Bulk batch progress'''

s = s.replace(OLD_MODAL_HTML, NEW_MODAL_HTML)
# Also strip the legacy .edit-modal-card wrapper opening (R27 still had it)
s = s.replace('<div id="editModal" class="edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="editTitle">\n  <div class="edit-modal-card">',
              '<div id="editModal" class="edit-modal" hidden role="dialog" aria-modal="true" aria-labelledby="editTitle">')
# And remove the matching closing </div>
s = s.replace(OLD_MODAL_CLOSE, NEW_MODAL_CLOSE)
print('[r28] HTML: modal restructured to image-canvas + floating top + bottom .menu-card')

# =====================================================================
# Replace the R27 CSS block with R28 CSS
# =====================================================================
OLD_CSS = '''  /* R27 — Edit modal layout rebuild. 4 stacked horizontal regions:
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

NEW_CSS = '''  /* R28 — Edit modal mirrors home solo-state composition:
     image-canvas fills inset:0, chrome (top brand + bottom menu-card)
     floats absolutely above. NO backdrop-filter on the bottom card
     (the home .menu-card comment explicitly warned about white-flash
     bugs with backdrop-filter on animating containers). */
  .edit-modal{
    position:fixed;inset:0;z-index:9000;
    background:#0a0a0c;
    color:#fff;overflow:hidden;
  }
  .edit-modal[hidden]{display:none !important;}
  /* R28 — image canvas fills the entire modal. Render fns continue to
     write to this element via id="editPreviewCol". */
  .edit-modal .edit-canvas-area{
    position:absolute;inset:0;
    display:flex;align-items:center;justify-content:center;
    background:#0a0a0c;
    overflow:hidden;
  }
  /* R28 — floating top chrome. pointer-events:none on the container
     so the canvas (compare slider, brush canvases) can be interacted
     with through the gaps between pills; the pills themselves restore
     pointer-events. Each pill has its own translucent glass treatment. */
  .edit-modal .edit-top-chrome{
    position:absolute;top:16px;left:16px;right:16px;
    z-index:10;
    display:flex;align-items:center;gap:10px;
    pointer-events:none;
  }
  .edit-modal .edit-top-chrome > *{
    pointer-events:auto;
    background:rgba(15,15,18,.72);
    -webkit-backdrop-filter:blur(20px) saturate(180%);
    backdrop-filter:blur(20px) saturate(180%);
    border:1px solid rgba(255,255,255,.08);
    border-radius:100px;
    padding:7px 14px;
    color:#fff;
    line-height:1.2;
  }
  .edit-modal .edit-brand-link{
    font-family:var(--font-display);
    font-style:italic;font-weight:600;
    font-size:.98rem;
    text-decoration:none;
    transition:opacity .12s;
    flex-shrink:0;
  }
  .edit-modal .edit-brand-link:hover{opacity:.85;}
  .edit-modal .edit-brand-link .g{color:var(--accent);}
  .edit-modal .edit-brand-link:focus-visible{outline:2px solid var(--accent);outline-offset:3px;}
  .edit-modal .edit-filename-chip{
    font-family:var(--font-mono);
    font-size:.74rem;
    color:rgba(255,255,255,.85);
    max-width:360px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    flex:0 1 auto;min-width:0;
  }
  .edit-modal .edit-top-chrome .edit-size-info{
    font-family:var(--font-mono);
    font-size:.7rem;
    color:rgba(255,255,255,.55);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    max-width:180px;
  }
  .edit-modal .edit-top-chrome .edit-size-info:empty{display:none;}
  /* R28 — bottom menu wrap + card. Mirrors home .menu-wrap / .menu-card
     exactly: solid #1a1a1a card, border-radius:14px, floats with 16px
     margins from viewport edges. */
  .edit-modal .edit-menu-wrap{
    position:absolute;
    left:16px;right:16px;bottom:16px;
    z-index:10;
    display:flex;align-items:stretch;justify-content:center;
    pointer-events:none;
  }
  .edit-modal .edit-menu-card{
    pointer-events:auto;
    background:#1a1a1a;
    border:1px solid rgba(255,255,255,.10);
    border-radius:14px;
    display:flex;flex-direction:column;
    overflow:hidden;
    max-width:1100px;width:100%;
  }
  /* R28 — options strip lives ABOVE the bottom row inside the card.
     Has a border-bottom that separates it visually from the bottom row
     when content is present. :empty collapses entirely, taking the
     border with it (no orphan separator on tabs that have no controls). */
  .edit-modal .edit-options-strip{
    padding:12px 16px;
    display:flex;flex-direction:column;gap:10px;
    max-height:36vh;overflow-y:auto;overflow-x:hidden;
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .edit-modal .edit-options-strip:empty{display:none;}
  .edit-modal .edit-menu-bottom-row{
    display:flex;align-items:stretch;gap:6px;
    padding:6px 8px;
  }
  .edit-modal .edit-tab-bar{
    display:flex;gap:2px;
    flex:1 1 auto;min-width:0;
  }
  .edit-modal .edit-tab-bar .edit-tab{
    flex:1 1 0;min-width:0;
    padding:8px 6px;border-radius:8px;
    background:transparent;color:rgba(255,255,255,.55);
    border:none;cursor:pointer;
    font-family:var(--font-body);
    font-size:.72rem;font-weight:500;
    display:flex;flex-direction:column;align-items:center;gap:3px;
    line-height:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    transition:background .12s,color .12s;
  }
  .edit-modal .edit-tab-bar .edit-tab .ico{width:1.15em;height:1.15em;margin:0;}
  .edit-modal .edit-tab-bar .edit-tab:hover{color:rgba(255,255,255,.9);background:rgba(255,255,255,.04);}
  .edit-modal .edit-tab-bar .edit-tab.active{background:rgba(138,174,138,.12);color:#fff;}
  .edit-modal .edit-tab-bar .edit-tab.active .ico{color:var(--accent);}
  .edit-modal .edit-actions-cluster{
    display:flex;align-items:center;gap:4px;
    padding-left:8px;
    border-left:1px solid rgba(255,255,255,.08);
    flex-shrink:0;
  }
  /* R28 — actions cluster buttons. Hard-override flex:initial !important
     to defeat the legacy .edit-modal .btn-primary{flex:1} rule that
     caused R27's Save button to stretch full-width and break the row. */
  .edit-modal .edit-actions-cluster .btn{
    height:34px;padding:0 14px;
    font-family:var(--font-body);
    font-size:.76rem;font-weight:600;
    border-radius:8px;
    background:rgba(255,255,255,.08);color:#fff;
    border:1px solid rgba(255,255,255,.14);
    cursor:pointer;white-space:nowrap;
    flex:initial !important;
  }
  .edit-modal .edit-actions-cluster .btn:hover{background:rgba(255,255,255,.14);}
  .edit-modal .edit-actions-cluster .btn-icon{
    width:34px;height:34px;padding:0;
    background:transparent;border-color:transparent;
    color:rgba(255,255,255,.65);
    display:inline-flex;align-items:center;justify-content:center;
  }
  .edit-modal .edit-actions-cluster .btn-icon:hover{
    background:rgba(255,255,255,.08);color:#fff;
  }
  .edit-modal .edit-actions-cluster .btn-icon:disabled,
  .edit-modal .edit-actions-cluster .btn-ghost:disabled{
    opacity:.25;cursor:default;pointer-events:none;
  }
  .edit-modal .edit-actions-cluster .btn-ghost{
    background:transparent;border-color:transparent;
    color:rgba(255,255,255,.48);
    font-size:.72rem;
  }
  .edit-modal .edit-actions-cluster .btn-ghost:hover{
    color:rgba(255,255,255,.88);background:rgba(255,255,255,.06);
  }
  .edit-modal .edit-actions-cluster .btn-primary{
    background:var(--accent-strong);color:#fff;
    border-color:var(--accent-strong);
    min-width:80px;
    flex:initial !important;
  }
  .edit-modal .edit-actions-cluster .btn-primary:hover{
    background:var(--accent);filter:brightness(1.05);
  }
  .edit-modal .edit-actions-cluster .btn-primary:focus-visible{
    outline:2px solid var(--accent);outline-offset:2px;
  }
  /* Legacy selector neutralizers — these are referenced by older CSS
     blocks; defang to prevent any cascade bleed onto the new structure. */
  .edit-modal .edit-modal-card,
  .edit-modal .edit-header,
  .edit-modal .edit-brand-bar,
  .edit-modal .edit-layout,
  .edit-modal .edit-preview-col,
  .edit-modal .edit-panel-col{display:contents;}'''

assert OLD_CSS in s, 'R27 CSS block not found'
s = s.replace(OLD_CSS, NEW_CSS)
print('[r28] CSS: layout block fully replaced (image inset:0 + floating chrome)')

# =====================================================================
# Update tab bar CSS — the new selector is .edit-tab-bar; harmonize
# any orphan .edit-tabs rules so they don't conflict.
# =====================================================================
# Remove R27's combined .edit-modal .edit-tab-bar, .edit-modal .edit-tabs rule
# since R28 sets these styles inside the main CSS block now.
OLD_R27_TABBAR = '''  /* R27 — categorized icon+label tabs, now at BOTTOM of modal as a
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
NEW_R27_TABBAR = '''  /* R28 — .edit-tabs (legacy class) inherits the .edit-tab-bar styles
     defined above for backward compat with any future render that
     uses the old class. */
  .edit-modal .edit-tabs{display:contents;}'''
assert OLD_R27_TABBAR in s, 'R27 tab bar combined rule not found'
s = s.replace(OLD_R27_TABBAR, NEW_R27_TABBAR)
print('[r28] CSS: R27 tab-bar selector consolidated into main R28 block')

# =====================================================================
# Mobile breakpoint — keep card sticky to bottom with safe-area padding
# =====================================================================
OLD_MOBILE = '''    /* R27 — mobile layout. The desktop layout is ALREADY vertical
       so most adjustments are size tweaks rather than reflow. */
    .edit-modal .edit-brand-bar{height:48px;padding:0 12px;gap:8px;}
    .edit-modal .edit-brand{font-size:.95rem;}
    .edit-modal .edit-filename{font-size:.72rem;padding:4px 8px;max-width:140px;}
    .edit-modal .edit-options-strip{max-height:180px;padding:10px 12px;gap:10px;}
    /* legacy .edit-layout / .edit-panel-col selectors no longer exist
       in markup; explicit display:none on any vestigial appearance. */
    .edit-modal .edit-layout, .edit-modal .edit-panel-col{display:none !important;}'''
NEW_MOBILE = '''    /* R28 — mobile layout. Floating top chrome with tighter padding
       and shrunken pills. Bottom card wraps the actions row onto its
       own line below the tabs so all 6 action buttons fit. */
    .edit-modal .edit-top-chrome{top:10px;left:10px;right:10px;gap:6px;}
    .edit-modal .edit-top-chrome > *{padding:6px 12px;}
    .edit-modal .edit-brand-link{font-size:.9rem;}
    .edit-modal .edit-filename-chip{font-size:.7rem;max-width:140px;}
    .edit-modal .edit-menu-wrap{
      left:8px;right:8px;
      bottom:max(8px, env(safe-area-inset-bottom, 8px));
    }
    .edit-modal .edit-menu-bottom-row{flex-direction:column;align-items:stretch;gap:6px;padding:6px;}
    .edit-modal .edit-actions-cluster{
      border-left:none;border-top:1px solid rgba(255,255,255,.06);
      padding-left:0;padding-top:6px;width:100%;
      justify-content:flex-end;
    }
    .edit-modal .edit-options-strip{max-height:32vh;padding:10px 12px;gap:10px;}'''
if OLD_MOBILE in s:
    s = s.replace(OLD_MOBILE, NEW_MOBILE)
    print('[r28] CSS: mobile breakpoint rewritten for new structure')
else:
    print('[r28] WARN: old mobile block not matched')

# =====================================================================
# Tail-byte + write
# =====================================================================
INDEX.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r28] index.html: {orig_len} -> {final_len} (delta {final_len - orig_len:+d})')
assert s.endswith('</body>\n</html>\n'), 'tail broken'
print('[r28] TAIL OK')
