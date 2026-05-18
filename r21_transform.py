#!/usr/bin/env python3
"""R21 — pro-editor brush keyboard polish.

Changes:
1. Add [ and ] for active-brush size across Pixelate/Blur/BG-Refine
   with Photoshop variable-increment (1/5/10/20 px tiers) + key-repeat.
2. Add Shift+[ / Shift+] for Blur radius (the only "softness" analog).
3. Add title tooltips to every brush slider with the shortcut hint.
4. Append "Use [ and ] to resize" to each brush help-text.

All keyboard handling lives inside the existing editOpen=true guarded
handler (line ~6223), so no new global listener is added. Brush state
mutation routes through dispatchEvent(new Event('input',{bubbles:true}))
so the existing change listeners fire and the cursor refreshes for free.

R18 lesson: file mods via Python on /tmp/imgready-clone (Linux), never
the Edit tool on the Windows mount. Tail-byte assert at end.
"""
import re
from pathlib import Path

SRC = Path('/tmp/imgready-clone/index.html')
s = SRC.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r21] read {orig_len} bytes')

# --------------------------------------------------------------------
# 1. Extend the existing edit-modal keydown handler with bracket keys.
#    Insertion point: just before the closing `});` of the editOpen
#    keydown handler. Find it via the unique Ctrl+Y branch.
# --------------------------------------------------------------------
OLD_KEY_TAIL = '''  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey)) && !isInput){
    _editRedo(); e.preventDefault();
  }
});'''

NEW_KEY_TAIL = '''  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey)) && !isInput){
    _editRedo(); e.preventDefault();
  }
  /* R21 — Photoshop-style bracket keys for brush size + Shift-bracket for
     Blur radius. Variable increment per Adobe's Photoshop convention
     (https://helpx.adobe.com/photoshop/using/default-keyboard-shortcuts.html):
     1px below 10, 5px below 50, 10px below 100, 20px above. Native key-repeat
     works because we tap the existing slider input via dispatchEvent, which
     means each repeated keydown fires one update — cursor + UI refresh for
     free via the slider's own change listener. */
  else if ((e.key === '[' || e.key === ']') && !isInput){
    const dir = (e.key === ']') ? 1 : -1;
    /* Shift+bracket routes to Blur radius if Blur sub-tab is active. */
    if (e.shiftKey){
      const radEl = document.getElementById('blRadius');
      if (radEl){
        const cur = parseInt(radEl.value, 10);
        const step = (cur < 5) ? 1 : (cur < 15) ? 2 : 5;
        const next = Math.max(parseInt(radEl.min,10), Math.min(parseInt(radEl.max,10), cur + dir * step));
        if (next !== cur){
          radEl.value = String(next);
          radEl.dispatchEvent(new Event('input', { bubbles: true }));
          radEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        e.preventDefault();
      }
      return;
    }
    /* Plain bracket: find the active brush slider, mutate, dispatch. */
    const brushIds = ['bgrBrush', 'pxBrush', 'blBrush'];
    let slider = null;
    for (let i = 0; i < brushIds.length; i++){
      const el = document.getElementById(brushIds[i]);
      if (el){ slider = el; break; }
    }
    if (slider){
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

assert OLD_KEY_TAIL in s, 'keydown handler tail not found'
s = s.replace(OLD_KEY_TAIL, NEW_KEY_TAIL)
print('[r21] keydown handler extended with bracket keys')

# --------------------------------------------------------------------
# 2. Tooltip hints on brush sliders. Three brush sliders + one radius.
# --------------------------------------------------------------------
SLIDER_PATCHES = [
    # Pixelate brush slider
    (
        '<input type="range" id="pxBrush" min="6" max="160" step="1" value="\' + px.brushPx + \'">',
        '<input type="range" id="pxBrush" min="6" max="160" step="1" value="\' + px.brushPx + \'" title="Brush size — [ and ]">'
    ),
    # Blur brush slider
    (
        '<input type="range" id="blBrush" min="6" max="160" step="1" value="\' + bl.brushPx + \'">',
        '<input type="range" id="blBrush" min="6" max="160" step="1" value="\' + bl.brushPx + \'" title="Brush size — [ and ]">'
    ),
    # Blur radius slider — Shift-bracket
    (
        '<input type="range" id="blRadius" min="2" max="40" step="1" value="\' + bl.radius + \'">',
        '<input type="range" id="blRadius" min="2" max="40" step="1" value="\' + bl.radius + \'" title="Blur strength — Shift+[ and Shift+]">'
    ),
    # BG Refine brush slider
    (
        '<input type="range" id="bgrBrush" min="6" max="160" step="1" value="\' + ref.brushPx + \'">',
        '<input type="range" id="bgrBrush" min="6" max="160" step="1" value="\' + ref.brushPx + \'" title="Brush size — [ and ]">'
    ),
]
for old, new in SLIDER_PATCHES:
    if old not in s:
        # Slider not present — skip silently. (BG refine slider only exists post-removal.)
        print(f'[r21] WARN: slider patch not found, skipping: {old[:60]}…')
        continue
    s = s.replace(old, new)
print('[r21] slider tooltips applied')

# --------------------------------------------------------------------
# 3. Help-text suffixes — append "Use [ and ] to resize." to brush hints.
# --------------------------------------------------------------------
HELP_PATCHES = [
    # Pixelate help
    (
        'Drag over areas you want to hide. Switch to Erase to clear pixelation.',
        'Drag over areas you want to hide. Switch to Erase to clear pixelation. Use [ and ] to resize the brush.'
    ),
    # BG refine help
    (
        'Erase trims extra pixels; Restore brings back the original. Lower Soft = feathered edges, higher = crisp.',
        'Erase trims extra pixels; Restore brings back the original. Lower Soft = feathered edges, higher = crisp. Use [ and ] to resize.'
    ),
]
for old, new in HELP_PATCHES:
    if old not in s:
        print(f'[r21] WARN: help patch not found: {old[:60]}…')
        continue
    s = s.replace(old, new)
print('[r21] help-text suffixes applied')

# Blur help is harder to grep because we don't know exact text — find it.
m = re.search(r'class="edit-blur-help">[^<]+', s)
if m:
    blur_help = m.group(0)
    if 'Use [ and ]' not in blur_help:
        # Append a sentence to the existing text
        new_blur = blur_help.rstrip() + ' Use [ and ] to resize.'
        s = s.replace(blur_help, new_blur)
        print('[r21] blur help-text suffix applied')
    else:
        print('[r21] blur help already has the hint, skipped')
else:
    print('[r21] WARN: blur help-text not found via regex')

# --------------------------------------------------------------------
# Write + tail-assert.
# --------------------------------------------------------------------
SRC.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r21] wrote {final_len} bytes (delta {final_len - orig_len:+d})')
print(f'[r21] tail: {s[-30:]!r}')
assert s.endswith('</body>\n</html>\n'), 'TAIL ASSERTION FAILED'
print('[r21] TAIL OK')
