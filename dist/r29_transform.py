#!/usr/bin/env python3
"""R29 — Compact the Edit options strip to match home .adjust-panel density.

User feedback: 'the setting still too big, there gotta be a smarter way
to sort it, look at what the home tool does, how tightly packed,
drop down etc'.

Home page's .adjust-panel is a SINGLE horizontal row of sections on
desktop:
  [Format pills] [Quality slider] [Resize ▾] [Privacy switch] [Advanced ▾]

It achieves density via:
  - flex-direction:row on the panel
  - Tiny labels (.62rem, uppercase, letter-spacing, margin-bottom:6px)
  - Compact controls (.adjust-pills button at --bb-btn-h)
  - Dropdowns for many-option choices (Resize uses a popover trigger
    instead of inline buttons)

This round applies the same pattern to the Edit modal's options strip:
  - Strip itself becomes flex-direction:row, flex-wrap:wrap
  - max-height tightened 36vh → 22vh
  - .adj-row grid changes to inline-flex (label + 110px slider + value)
  - Per-tool containers (.edit-pixelate-controls etc.) become
    horizontal flex rows
  - Vignette section gets the inline treatment instead of full-block
  - Preset strip stays horizontal but scrolls when narrow

CSS-only round. No render-function rewrites.
"""
from pathlib import Path

INDEX = Path('/tmp/imgready-clone/index.html')
s = INDEX.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r29] read {orig_len} bytes')

# =====================================================================
# 1. Strip itself — flex row + tighter padding + smaller max-height
# =====================================================================
OLD_STRIP = '''  .edit-modal .edit-options-strip{
    padding:12px 16px;
    display:flex;flex-direction:column;gap:10px;
    max-height:36vh;overflow-y:auto;overflow-x:hidden;
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .edit-modal .edit-options-strip:empty{display:none;}'''
NEW_STRIP = '''  /* R29 — strip mirrors home .adjust-panel density. flex-row primary;
     wraps onto a second line only when controls genuinely don\'t fit.
     max-height 22vh ensures even the busiest tab (Adjust) leaves the
     canvas with the lion\'s share of vertical space. */
  .edit-modal .edit-options-strip{
    padding:10px 14px;
    display:flex;flex-direction:row;flex-wrap:wrap;
    align-items:center;gap:14px 18px;
    max-height:22vh;overflow-y:auto;overflow-x:hidden;
    border-bottom:1px solid rgba(255,255,255,.06);
  }
  .edit-modal .edit-options-strip:empty{display:none;}
  /* Direct children of the strip become horizontal flex rows by default,
     overriding tool-specific column layouts that lived in the old
     panel-column world. Each render fn\'s top-level wrapper benefits. */
  .edit-modal .edit-options-strip > * {
    display:flex;flex-direction:row;align-items:center;gap:10px;
    flex:0 1 auto;
  }
  .edit-modal .edit-options-strip > div:first-child:not(.edit-subtoggle){
    margin-right:auto; /* lets later items push to the right when there\'s room */
  }'''
assert OLD_STRIP in s, 'R28 strip CSS not found'
s = s.replace(OLD_STRIP, NEW_STRIP)
print('[r29] CSS: strip is horizontal flex, max-height 22vh')

# =====================================================================
# 2. .adj-row — change from CSS grid to inline-flex compact
# =====================================================================
OLD_ADJ_ROW = '''  .adj-row{display:grid;grid-template-columns:70px 1fr 34px;gap:6px;align-items:center;}
  .adj-label{font-size:.74rem;color:rgba(255,255,255,.6);}
  .adj-val{font-size:.74rem;color:#fff;text-align:right;font-variant-numeric:tabular-nums;}
  .adj-row input[type=range]{width:100%;}'''
NEW_ADJ_ROW = '''  /* R29 — .adj-row compact inline-flex. Was a 3-col grid (70/1fr/34)
     that took a full panel-row each. Now a compact unit ~220px wide
     that lays beside its peers in a flex row, like the home page\'s
     quality-row sits beside the format pills + resize dropdown. */
  .adj-row{
    display:inline-flex;align-items:center;gap:8px;
    flex:0 0 auto;min-width:0;
  }
  .adj-label{
    font-size:.62rem;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;color:rgba(255,255,255,.55);
    white-space:nowrap;flex:0 0 auto;
  }
  .adj-row input[type=range]{
    width:120px;min-width:80px;max-width:160px;
    flex:0 1 auto;
  }
  .adj-val{
    font-family:var(--font-mono);
    font-size:.7rem;color:rgba(255,255,255,.85);
    text-align:right;font-variant-numeric:tabular-nums;
    min-width:30px;flex:0 0 auto;
  }'''
assert OLD_ADJ_ROW in s, '.adj-row block not found'
s = s.replace(OLD_ADJ_ROW, NEW_ADJ_ROW)
print('[r29] CSS: .adj-row -> compact inline-flex 220px-wide unit')

# =====================================================================
# 3. Preset strip — tighter, scrollable horizontally
# =====================================================================
OLD_PRESET = '''  .edit-preset-strip{display:flex;gap:4px;flex-wrap:wrap;}'''
NEW_PRESET = '''  /* R29 — preset strip stays horizontal but no-wraps + scrolls so it
     doesn\'t push the strip to 2 lines on narrow viewports. */
  .edit-preset-strip{
    display:flex;gap:4px;flex-wrap:nowrap;
    overflow-x:auto;scrollbar-width:none;
    max-width:340px;
    padding:1px;
  }
  .edit-preset-strip::-webkit-scrollbar{display:none;}'''
assert OLD_PRESET in s, '.edit-preset-strip block not found'
s = s.replace(OLD_PRESET, NEW_PRESET)
print('[r29] CSS: preset strip becomes horizontal-scroll, no wrap')

# =====================================================================
# 4. Vignette section — compact horizontal pattern
# =====================================================================
OLD_VIG = '''  .edit-vignette-sliders .adj-row{grid-template-columns:62px 1fr 36px;}'''
NEW_VIG = '''  /* R29 — vignette uses the new compact .adj-row, no grid override needed. */
  .edit-vignette-section{
    display:inline-flex;align-items:center;gap:10px;
    flex:0 0 auto;
  }
  .edit-vignette-section h4{
    font-size:.62rem;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;color:rgba(255,255,255,.55);
    margin:0;white-space:nowrap;
  }
  .edit-vignette-sliders{
    display:inline-flex;align-items:center;gap:8px;
  }'''
assert OLD_VIG in s, 'vignette section CSS not found'
s = s.replace(OLD_VIG, NEW_VIG)
print('[r29] CSS: vignette section becomes inline-flex')

# =====================================================================
# 5. Sub-toggle (Transform Rotate|Crop, Retouch Pixelate|Blur) tighter
# =====================================================================
OLD_SUBTOG = '''  .edit-modal .edit-subtoggle{
    display:flex;gap:4px;padding:4px;border-radius:8px;
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.06);
    margin:0 0 12px 0;
  }
  .edit-modal .edit-subtab{
    flex:1 1 0;padding:8px 12px;border-radius:6px;
    background:transparent;color:rgba(255,255,255,.55);
    border:none;cursor:pointer;font-size:.76rem;font-weight:500;
    display:inline-flex;align-items:center;justify-content:center;gap:6px;
    transition:background .12s,color .12s;line-height:1;
  }'''
NEW_SUBTOG = '''  /* R29 — sub-toggle pill switcher, tighter and inline. */
  .edit-modal .edit-subtoggle{
    display:inline-flex;gap:2px;padding:3px;border-radius:7px;
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.06);
    margin:0;flex:0 0 auto;
  }
  .edit-modal .edit-subtab{
    flex:0 0 auto;padding:5px 10px;border-radius:5px;
    background:transparent;color:rgba(255,255,255,.55);
    border:none;cursor:pointer;font-size:.7rem;font-weight:600;
    display:inline-flex;align-items:center;justify-content:center;gap:5px;
    transition:background .12s,color .12s;line-height:1;
  }'''
assert OLD_SUBTOG in s, 'subtoggle CSS not found'
s = s.replace(OLD_SUBTOG, NEW_SUBTOG)
print('[r29] CSS: sub-toggle compacted')

# =====================================================================
# 6. Auto-enhance row + button — inline-flex, smaller
# =====================================================================
OLD_AE = '''  .edit-auto-enhance-row{display:flex;gap:8px;align-items:stretch;}'''
NEW_AE = '''  /* R29 — auto-enhance is its own compact pill in the strip */
  .edit-auto-enhance-row{
    display:inline-flex;gap:6px;align-items:center;
    flex:0 0 auto;
  }
  .edit-auto-enhance-row .edit-auto-enhance-btn{
    height:28px;padding:0 10px;
    font-size:.7rem;font-weight:600;
    border-radius:6px;
    background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.12);
    color:rgba(255,255,255,.85);
    display:inline-flex;align-items:center;gap:4px;
    cursor:pointer;white-space:nowrap;
  }
  .edit-auto-enhance-row .edit-auto-enhance-btn:hover{background:rgba(255,255,255,.10);color:#fff;}
  .edit-auto-enhance-row .edit-auto-enhance-btn.active{
    background:var(--accent);color:#fff;border-color:var(--accent);
  }
  .edit-auto-enhance-row .edit-auto-enhance-undo{
    font-size:.66rem;background:transparent;border:none;
    color:rgba(255,255,255,.55);cursor:pointer;
    padding:3px 6px;border-radius:4px;
  }
  .edit-auto-enhance-row .edit-auto-enhance-undo:hover{color:#fff;background:rgba(255,255,255,.06);}'''
assert OLD_AE in s, 'auto-enhance row CSS not found'
s = s.replace(OLD_AE, NEW_AE)
print('[r29] CSS: auto-enhance row compacted')

# =====================================================================
# 7. Brush tool controls (Pixelate / Blur / BG Refine) — horizontal
# =====================================================================
# Find each top-level control wrapper and make it horizontal.
HORIZONTAL_WRAPPERS = '''
  /* R29 — top-level tool control wrappers become horizontal flex rows
     that fit alongside other controls in the strip. The render-fn output
     is unchanged; only the layout changes. */
  .edit-pixelate-controls,
  .edit-blur-controls,
  .edit-text-controls,
  .bg-refine-section,
  .edit-adjust-sliders,
  .edit-rotate-row{
    display:inline-flex !important;
    flex-direction:row !important;
    align-items:center;
    gap:10px;
    flex:0 1 auto;
    margin:0 !important;
    padding:0 !important;
    border:none !important;
  }
  .edit-pixelate-controls .px-tool-strip,
  .edit-blur-controls .bl-tool-strip,
  .bg-refine-section .bg-refine-tool-strip{
    display:inline-flex;gap:2px;
    flex:0 0 auto;
  }
  .edit-pixelate-controls .edit-preset-btn,
  .edit-blur-controls .edit-preset-btn,
  .bg-refine-section .edit-preset-btn,
  .edit-rotate-row .edit-rotate-btn{
    height:28px;padding:0 10px;
    font-size:.7rem;border-radius:6px;
  }
  /* Help paragraphs collapse to a tooltip-on-hover style — they were
     taking a full row each. */
  .edit-pixelate-help,
  .edit-blur-help,
  .bg-refine-help,
  .tx-anchor-help{
    font-size:.62rem;color:rgba(255,255,255,.4);
    max-width:240px;line-height:1.35;margin:0;
    flex:0 1 auto;
  }
  /* Clear-all buttons get compact pill treatment. */
  .edit-frames-action-btn{
    height:28px;padding:0 10px;
    font-size:.7rem;font-weight:600;border-radius:6px;
    background:rgba(255,255,255,.06);
    border:1px solid rgba(255,255,255,.12);
    color:rgba(255,255,255,.85);cursor:pointer;
    flex:0 0 auto;
  }
  .edit-frames-action-btn:hover{background:rgba(255,255,255,.12);color:#fff;}
  /* Add tab item list horizontal scroll. */
  .tx-item-list{
    display:flex;gap:6px;
    overflow-x:auto;flex:1 1 auto;min-width:0;
    scrollbar-width:none;
  }
  .tx-item-list::-webkit-scrollbar{display:none;}
  .tx-sel-controls{
    display:inline-flex;gap:6px;align-items:center;
    flex:0 1 auto;
  }
  /* h4 section heads inline */
  .edit-options-strip h4,
  .bg-refine-section h4{
    font-size:.62rem;font-weight:700;letter-spacing:.06em;
    text-transform:uppercase;color:rgba(255,255,255,.55);
    margin:0;white-space:nowrap;flex:0 0 auto;
  }
'''

# Insert this block right after the strip CSS
ANCHOR = "  .edit-modal .edit-options-strip > div:first-child:not(.edit-subtoggle){"
END_ANCHOR_LINE = "    margin-right:auto; /* lets later items push to the right when there\\'s room */\n  }"
# We already added the strip block; append wrappers after it
INSERTION_POINT = "    margin-right:auto; /* lets later items push to the right when there's room */\n  }"
assert INSERTION_POINT in s, 'strip wrapper insertion anchor not found'
s = s.replace(INSERTION_POINT, INSERTION_POINT + HORIZONTAL_WRAPPERS)
print('[r29] CSS: per-tool control wrappers set to inline-flex row')

# =====================================================================
# Tail-byte + write
# =====================================================================
INDEX.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r29] index.html: {orig_len} -> {final_len} (delta {final_len - orig_len:+d})')
assert s.endswith('</body>\n</html>\n'), 'tail broken'
print('[r29] TAIL OK')
