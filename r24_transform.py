#!/usr/bin/env python3
"""R24 — Brand cohesion: type system + accent harmonization (home + editor).

Self-hosts three OFL fonts (Fraunces VF, Inter VF, JetBrains Mono VF)
already downloaded to ./fonts/. Adds CSS variables, applies them across
home page and Edit modal. Strengthens sage accent in editor surfaces.

This round intentionally does NOT touch the 50 marketing pages — each
has its own inline <style> block; that's a separate propagation round
(R24.5). Today this validates the brand pattern on the highest-traffic
page first.

Files modified: index.html only (fonts/*.woff2 are already in place
and will be picked up by build.mjs mirrorDir).
"""
from pathlib import Path

INDEX = Path('/tmp/imgready-clone/index.html')
s = INDEX.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r24] read {orig_len} bytes')

# =====================================================================
# 1. @font-face + CSS variables — inject at the top of the first <style>
#    block in <head>. Anchor: the existing :root{ rule that defines
#    --bg, --text, --accent etc.
# =====================================================================
FONT_CSS = '''  /* R24 — Brand type system. Three self-hosted OFL variable fonts:
     - Fraunces (display): Adobe Fonts/Google Fonts via OFL, opsz+wght axes.
       Used for hero headings, modal titles, the wordmark italic.
     - Inter (body): rsms.me/inter, OFL, 400..700 wght axis. UI workhorse.
     - JetBrains Mono (mono accent): jetbrains.com/lp/mono, OFL.
       Used for byte counts, filenames, the keyboard-shortcut hints.
     All Latin-only subsets, total ~147KB woff2. Loaded with display:swap
     so first paint never blocks on font load. */
  @font-face{
    font-family:'Fraunces';
    src:url('/fonts/fraunces-latin.woff2') format('woff2-variations'),
        url('/fonts/fraunces-latin.woff2') format('woff2');
    font-weight:100 900;
    font-style:normal;
    font-display:swap;
    unicode-range:U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face{
    font-family:'Inter';
    src:url('/fonts/inter-latin.woff2') format('woff2-variations'),
        url('/fonts/inter-latin.woff2') format('woff2');
    font-weight:100 900;
    font-style:normal;
    font-display:swap;
    unicode-range:U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
  @font-face{
    font-family:'JetBrains Mono';
    src:url('/fonts/jetbrainsmono-latin.woff2') format('woff2-variations'),
        url('/fonts/jetbrainsmono-latin.woff2') format('woff2');
    font-weight:100 900;
    font-style:normal;
    font-display:swap;
    unicode-range:U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
  }
'''

OLD_ROOT = '  :root{\n    --bg:#f5f0e8;--text:#2a2a26;--muted:#7a7872;'
NEW_ROOT = FONT_CSS + '  :root{\n    --bg:#f5f0e8;--text:#2a2a26;--muted:#7a7872;\n    /* R24 — type tokens. Body via Inter; display via Fraunces (warm serif\n       with opsz + wght axes); mono via JetBrains Mono for byte-count strings. */\n    --font-display:"Fraunces",ui-serif,Georgia,"Times New Roman",serif;\n    --font-body:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;\n    --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;'

assert OLD_ROOT in s, ':root opening not found'
s = s.replace(OLD_ROOT, NEW_ROOT)
print('[r24] @font-face declarations + CSS vars injected at :root')

# =====================================================================
# 2. Apply --font-body to body (replace the existing -apple-system stack)
# =====================================================================
OLD_BODY = 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;'
NEW_BODY = 'body{font-family:var(--font-body);'
assert OLD_BODY in s, 'body font-family rule not found'
s = s.replace(OLD_BODY, NEW_BODY)
print('[r24] body font-family -> var(--font-body)')

# =====================================================================
# 3. Apply --font-display to h1, h2 — explicit rules added so display
#    typography lifts on the home hero + Edit modal modal title.
# =====================================================================
DISPLAY_RULES = '''  /* R24 — display type for hero headings + brand wordmark + Edit modal
     title. Fraunces opsz axis auto-adjusts at large sizes to read warmer. */
  h1,h2,.brand,.hero h2,.edit-modal .edit-header h2{
    font-family:var(--font-display);
    font-feature-settings:"ss01" on;
    letter-spacing:-.01em;
  }
  .brand{font-style:italic;font-weight:600;}
  .hero h2{font-weight:600;}
  .edit-modal .edit-header h2{font-weight:600;letter-spacing:-.005em;}
  /* R24 — mono for byte counts, file size strings, keyboard hints,
     anything that should read as "technical, factual, not marketing copy". */
  kbd, .qr-size, .size-info, .edit-size-info, .compare-meta span:nth-child(2),
  .batch-progress-text, .lbl-title + span,
  output.r23-adv-val, .r23-adv-name, .pi-icon code,
  .pct{
    font-family:var(--font-mono);
    font-feature-settings:"tnum" on, "zero" on;
  }
'''

# Insert after the body{} rule so the cascade is correct
BODY_RULE_END = '''  body{font-family:var(--font-body);
    color:var(--text);background:var(--bg);}'''
assert BODY_RULE_END in s, 'body rule full block not found'
s = s.replace(BODY_RULE_END, BODY_RULE_END + '\n' + DISPLAY_RULES)
print('[r24] display + mono rules added')

# =====================================================================
# 4. Strengthen sage accent in editor — Save button slightly more
#    saturated, active tab + active subtab use accent at higher
#    opacity, the kbd-help button uses accent ink.
# =====================================================================
ACCENT_RULES = '''  /* R24 — accent harmonization. Carry the sage more confidently into the
     dark editor surfaces. Was: subtle accent ink on hover only. Now:
     accent fills the primary Save action with a saturated tone that
     matches the cream-on-sage logo treatment, and the active Edit tab
     gets a thin accent underline so users can scan to the active panel
     at a glance. */
  .edit-modal .btn-primary{
    background:var(--accent-strong, var(--accent));
    color:#0a0a0c;
    box-shadow:0 0 0 1px var(--accent), 0 8px 18px -8px rgba(122,154,122,.45);
  }
  .edit-modal .btn-primary:hover{
    background:var(--accent);
    filter:brightness(1.04);
  }
  .edit-modal .edit-tab.active{
    background:rgba(138,174,138,.12);
    position:relative;
  }
  .edit-modal .edit-tab.active::after{
    content:"";position:absolute;left:8px;right:8px;bottom:2px;
    height:2px;background:var(--accent);border-radius:1px;
  }
  /* R24 — wordmark on the hero gets the warm sage as the second word's color
     (was already using .g class on the "g" letter; promote to whole accent). */
  .brand .g{color:var(--accent-strong, var(--accent));font-weight:600;}
'''

# Insert before the R23 advanced encoder CSS block
INSERT_ANCHOR = '  /* R23 — Advanced encoder controls section.'
assert INSERT_ANCHOR in s, 'R23 anchor not found for accent insert'
s = s.replace(INSERT_ANCHOR, ACCENT_RULES + '\n' + INSERT_ANCHOR)
print('[r24] accent strengthening rules added')

# =====================================================================
# 5. Update the wordmark/logo in the page header to use the new type
#    system. The .brand span currently renders as bold sans; switch to
#    Fraunces italic (already set up via the .brand rule above) and
#    confirm the markup.
# =====================================================================
# No HTML change needed — the existing .brand markup picks up the new
# font automatically via the CSS rule. Verify the markup still exists.
assert 'class="brand"' in s or "class='brand'" in s, '.brand markup not found'
print('[r24] wordmark uses .brand class — picks up new font automatically')

# =====================================================================
# Tail-byte assertion + write
# =====================================================================
INDEX.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r24] index.html: {orig_len} -> {final_len} (+{final_len-orig_len})')
assert s.endswith('</body>\n</html>\n'), 'index tail broken'
print('[r24] TAIL OK')
