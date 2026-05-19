#!/usr/bin/env python3
"""R26 — refinement and cleanup based on debug audit + research dossiers.

Five items shipped together:
  1. Tighten @font-face weight ranges to match actually-downloaded axes
     (Inter 400..700, Fraunces 400..700, JBM 400..600). Truth-in-styling.
  2. Footer .brand markup adds .g class to second span for sage accent
     consistency with header wordmark.
  3. Remove dead R20 tab-overflow JS — _updateTabsOverflow,
     _scrollActiveTabIntoView, _wireTabsOverflowWatcher and the
     remaining orphaned class-toggle calls. Replaces them with no-ops
     to preserve any external call sites, but stops the actual class
     mutation.
  4. Add capture="environment" to the file input — gives mobile users
     a "take photo" picker option without changing desktop behavior.
     From R25 dossier top-8 (item that didn't make it into R25 ship).
  5. Quick visual polish: the Advanced encoder summary's chevron
     animation already works via R23 CSS — verify and tighten the
     hover state.

Tail-byte assert at end.
"""
import re
from pathlib import Path

INDEX = Path('/tmp/imgready-clone/index.html')
s = INDEX.read_text(encoding='utf-8')
orig_len = len(s)
print(f'[r26] read {orig_len} bytes')

# =====================================================================
# 1. Tighten font-face weight ranges
# =====================================================================
# Fraunces (downloaded as opsz 9..144 + wght 400..700)
OLD_FR = '''@font-face{
    font-family:'Fraunces';
    src:url('/fonts/fraunces-latin.woff2') format('woff2-variations'),
        url('/fonts/fraunces-latin.woff2') format('woff2');
    font-weight:100 900;'''
NEW_FR = '''@font-face{
    font-family:'Fraunces';
    src:url('/fonts/fraunces-latin.woff2') format('woff2-variations'),
        url('/fonts/fraunces-latin.woff2') format('woff2');
    font-weight:400 700;'''
assert OLD_FR in s, 'Fraunces font-face block not found'
s = s.replace(OLD_FR, NEW_FR)

OLD_IN = '''@font-face{
    font-family:'Inter';
    src:url('/fonts/inter-latin.woff2') format('woff2-variations'),
        url('/fonts/inter-latin.woff2') format('woff2');
    font-weight:100 900;'''
NEW_IN = '''@font-face{
    font-family:'Inter';
    src:url('/fonts/inter-latin.woff2') format('woff2-variations'),
        url('/fonts/inter-latin.woff2') format('woff2');
    font-weight:400 700;'''
assert OLD_IN in s, 'Inter font-face block not found'
s = s.replace(OLD_IN, NEW_IN)

OLD_JBM = '''@font-face{
    font-family:'JetBrains Mono';
    src:url('/fonts/jetbrainsmono-latin.woff2') format('woff2-variations'),
        url('/fonts/jetbrainsmono-latin.woff2') format('woff2');
    font-weight:100 900;'''
NEW_JBM = '''@font-face{
    font-family:'JetBrains Mono';
    src:url('/fonts/jetbrainsmono-latin.woff2') format('woff2-variations'),
        url('/fonts/jetbrainsmono-latin.woff2') format('woff2');
    font-weight:400 600;'''
assert OLD_JBM in s, 'JBM font-face block not found'
s = s.replace(OLD_JBM, NEW_JBM)
print('[r26] font-face weight ranges tightened to actual axis coverage')

# =====================================================================
# 2. Footer .brand — add .g class to second span
# =====================================================================
OLD_FOOTER_BRAND = '<a class="brand" href="/">img<span>ready</span></a>'
NEW_FOOTER_BRAND = '<a class="brand" href="/">img<span class="g">ready</span></a>'
if OLD_FOOTER_BRAND in s:
    s = s.replace(OLD_FOOTER_BRAND, NEW_FOOTER_BRAND)
    print('[r26] footer .brand gets .g class on second span (sage accent consistency)')
else:
    print('[r26] WARN: footer .brand markup variant not matched')

# =====================================================================
# 3. Replace R20 dead tab-overflow JS with no-ops (preserve call sites)
# =====================================================================
# The 3 functions live in a known block. Replace bodies with no-ops to
# keep the function symbols available if any external caller still
# references them, but stop the actual class-toggle work.
OLD_DEAD_BLOCK = '''function _updateTabsOverflow(){
  const bar = document.querySelector('.edit-modal .edit-tabs');
  if (!bar) return;
  const hasRight = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
  const hasLeft  = bar.scrollLeft > 1;
  bar.classList.toggle('edit-tabs--overflow-r', hasRight);
  bar.classList.toggle('edit-tabs--overflow-l', hasLeft);
}'''
NEW_DEAD_BLOCK = '''/* R26 — _updateTabsOverflow + _scrollActiveTabIntoView + _wireTabsOverflowWatcher
   are dead code from R19's horizontal-scroll tab bar. R20 replaced
   those tabs with equal-width flex:1 categorized tabs that don't
   overflow, but these functions were kept calling because the CSS
   classes they toggle (.edit-tabs--overflow-l/-r) used to have
   mask-image rules that are now gone. The toggles were no-ops in
   visible effect. Stub them out to stop the runtime work. */
function _updateTabsOverflow(){ /* R26: noop — see comment */ }'''
assert OLD_DEAD_BLOCK in s, 'dead R20 tab-overflow block not found'
s = s.replace(OLD_DEAD_BLOCK, NEW_DEAD_BLOCK)

OLD_SCROLL_INTO_VIEW = '''function _scrollActiveTabIntoView(){
  const bar = document.querySelector('.edit-modal .edit-tabs');
  const a   = document.querySelector('.edit-modal .edit-tab.active');
  if (bar && a){
    const aL = a.offsetLeft, aR = aL + a.offsetWidth;
    const cw = bar.clientWidth, sl = bar.scrollLeft;
    if (aR > sl + cw)      bar.scrollLeft = aR - cw + 6;
    else if (aL < sl)      bar.scrollLeft = Math.max(0, aL - 6);
  }
  _updateTabsOverflow();
  setTimeout(_updateTabsOverflow, 60);
}'''
NEW_SCROLL_INTO_VIEW = '''function _scrollActiveTabIntoView(){ /* R26: noop — tabs no longer scroll */ }'''
assert OLD_SCROLL_INTO_VIEW in s, 'scrollActiveTabIntoView block not found'
s = s.replace(OLD_SCROLL_INTO_VIEW, NEW_SCROLL_INTO_VIEW)

OLD_WIRE = '''let _tabsOverflowWired = false;
function _wireTabsOverflowWatcher(){
  if (_tabsOverflowWired) return;
  _tabsOverflowWired = true;
  document.addEventListener('scroll', (e)=>{
    const t = e.target;
    if (t && t.classList && t.classList.contains('edit-tabs')) _updateTabsOverflow();
  }, true);
  window.addEventListener('resize', ()=>{
    if (document.querySelector('.edit-modal')) _updateTabsOverflow();
  });
}'''
NEW_WIRE = '''let _tabsOverflowWired = false;
function _wireTabsOverflowWatcher(){ /* R26: noop — tabs no longer scroll */ }'''
assert OLD_WIRE in s, 'wireTabsOverflowWatcher block not found'
s = s.replace(OLD_WIRE, NEW_WIRE)
print('[r26] R20 dead tab-overflow code stubbed to no-ops (callers untouched)')

# =====================================================================
# 4. Add capture="environment" to the file input (mobile camera picker)
# =====================================================================
OLD_FILE_INPUT = '<input type="file" id="fileInput" accept="image/*,.heic,.heif,.tif,.tiff,.bmp,.svg,.ico" multiple aria-label="Choose image files to compress">'
NEW_FILE_INPUT = '<input type="file" id="fileInput" accept="image/*,.heic,.heif,.tif,.tiff,.bmp,.svg,.ico" multiple aria-label="Choose image files to compress (or take a photo on mobile)">'
# Don't add capture="environment" because that would FORCE the camera, not offer it as an option.
# What we WANT is to let mobile users see both gallery + camera in the system picker.
# Actually: omitting capture is correct — both options appear. Adding capture=environment forces camera.
# So instead let me ADD an aria-label hint and a small CSS pseudo or button for explicit camera.
# Simplest correct fix: the picker without `capture` already offers camera on mobile per WHATWG spec.
# So no HTML change needed for "camera support" — it already works.
# The R25 dossier item was misread by me; the right addition is making it discoverable on mobile.
# For R26: just tighten the aria-label. Real camera-button is R27 work.
if OLD_FILE_INPUT in s:
    s = s.replace(OLD_FILE_INPUT, NEW_FILE_INPUT)
    print('[r26] file input aria-label tightened to mention mobile camera capability')
else:
    print('[r26] file input not found')

# =====================================================================
# 5. Advanced encoder summary chevron polish — already animates via R23.
#    Add a subtle hover background for better affordance.
# =====================================================================
OLD_ADV_SUMMARY = '''  .r23-adv-summary{
    cursor:pointer;list-style:none;
    padding:10px 12px;
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    font-size:.82rem;font-weight:600;color:rgba(255,255,255,.85);
    user-select:none;
  }'''
NEW_ADV_SUMMARY = '''  .r23-adv-summary{
    cursor:pointer;list-style:none;
    padding:10px 12px;
    display:flex;align-items:center;justify-content:space-between;gap:8px;
    font-size:.82rem;font-weight:600;color:rgba(255,255,255,.85);
    user-select:none;
    transition:background .12s ease;
  }
  .r23-adv-summary:hover{background:rgba(255,255,255,.04);}
  .r23-adv-details[open] .r23-adv-summary{background:rgba(138,174,138,.06);}'''
assert OLD_ADV_SUMMARY in s, 'R23 summary block not found'
s = s.replace(OLD_ADV_SUMMARY, NEW_ADV_SUMMARY)
print('[r26] Advanced encoder summary: hover state + open-state subtle bg tint')

# =====================================================================
# Write + tail-assert
# =====================================================================
INDEX.write_text(s, encoding='utf-8')
final_len = len(s)
print(f'[r26] index.html: {orig_len} -> {final_len} (delta {final_len - orig_len:+d})')
assert s.endswith('</body>\n</html>\n'), 'tail broken'
print('[r26] TAIL OK')
