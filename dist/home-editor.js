/* ============================================================
   EDIT MODE — second workflow surface. State held in _editState
   while the modal is open. On Save the pending edits are applied
   to FILES[idx].file (a new source blob) and the encode pipeline
   re-runs from that source. Optimize/convert flow is untouched —
   it just sees a different source file after Save.
   ============================================================ */
const _editState = {
  active: false, idx: -1,
  originalFile: null, originalUrl: null, fileType: null,
  pendingEdits: {},
  rotateState: { deg: 0, flipH: false, flipV: false, angle: 0 },
  framesState: null, bgState: null,
  _undoStack: [], _redoStack: [],
  _splitActive: false,
};
function _detectEditFileType(file){
  const ext = (file.name || '').toLowerCase().split('.').pop();
  const type = (file.type || '').toLowerCase();
  if (ext === 'gif' || type === 'image/gif') return 'gif';
  if (ext === 'png' || type === 'image/png') return 'png';
  if (ext === 'jpg' || ext === 'jpeg' || type === 'image/jpeg') return 'jpg';
  if (ext === 'webp' || type === 'image/webp') return 'webp';
  if (ext === 'avif' || type === 'image/avif') return 'avif';
  if (ext === 'heic' || ext === 'heif' || type === 'image/heic' || type === 'image/heif') return 'heic';
  if (ext === 'tif' || ext === 'tiff') return 'tiff';
  if (ext === 'bmp') return 'bmp';
  if (ext === 'svg') return 'svg';
  if (ext === 'ico') return 'ico';
  return 'other';
}
/* R20 - 5 categorized photo tabs (Apple Photos / Pixlr X pattern).
   Transform groups Rotate+Crop; Retouch groups Pixelate+Blur. Each
   group exposes a sub-toggle inside the panel body so the surface is
   identical to the previous flat layout, just nested one level. */
/* R31 — flat camera-roll strip: each tool is a direct top-level
   button. Removed the grouped Transform/Retouch meta-tabs that hid
   Rotate, Crop, Pixelate and Blur behind a sub-toggle. The existing
   renderers (_renderRotateTab, _renderCropTab, etc.) are unchanged;
   they now get called directly from _switchEditTab. */
function _editTabsForType(t){
  const isPhoto = (t === 'png' || t === 'jpg' || t === 'webp' || t === 'avif' || t === 'heic');
  const tabs = [];
  if (t === 'gif') {
    tabs.push({ id: 'frames',   label: 'Frames',  icon: 'i-arrow-left-right' });
    return tabs;
  }
  if (isPhoto) {
    /* R76/R86 — Hid Pixelate / Text / Remove BG per user audit:
       half-baked features dilute the conversion-first SEO message.
       Renderers remain in code (no breakage) but tab buttons are
       not exposed. */
    tabs.push({ id: 'adjust',   label: 'Adjust',  icon: 'i-sliders-horizontal' });
    tabs.push({ id: 'filters',  label: 'Filters', icon: 'i-palette' });
    tabs.push({ id: 'rotate',   label: 'Rotate',  icon: 'i-rotate-cw' });
    tabs.push({ id: 'crop',     label: 'Crop',    icon: 'i-crop' });
  } else {
    tabs.push({ id: 'rotate',   label: 'Rotate',  icon: 'i-rotate-cw' });
    tabs.push({ id: 'crop',     label: 'Crop',    icon: 'i-crop' });
  }
  return tabs;
}
function _openEditFromPi(){
  const idx = CFLOW.selected;
  if (typeof FILES === 'undefined' || !FILES[idx]) return;
  openEditMode(idx);
  document.body.dataset.piActions = 'closed';
}
function openEditMode(idx){
  if (!FILES[idx]) return;
  const f = FILES[idx];
  _editState.active = true;
  _editState.idx = idx;
  /* Round 11 HEIC fix: most canvas paths (createImageBitmap, autoEnhance,
   * bgRefine, save pipeline) call into the originalFile blob directly. Raw
   * HEIC blobs are NOT decodable by Chrome/Firefox/Edge — only Safari does
   * it natively. We already decoded HEIC to a JPEG blob in addFilesFromList
   * (stored as f.decodedBlob). Use that here. f.file remains the original
   * HEIC for metadata + encoder-level use. */
  _editState.originalFile = f.decodedBlob || f.file;
  /* Round 17 HEIC fix: f.url is a blob URL for the RAW HEIC, which
   * Chrome/Firefox/Edge can't decode. When we have a decoded JPEG blob,
   * mint a dedicated URL for it so every Edit-mode preview (<img>, CSS
   * background-image) and the transformers.js BG pipeline see a real,
   * renderable image. cancelEdit revokes it via _decodedOwnUrl. */
  if (f.decodedBlob && f.decodedBlob !== f.file){
    _editState._decodedOwnUrl = URL.createObjectURL(f.decodedBlob);
    _editState.originalUrl = _editState._decodedOwnUrl;
  } else {
    _editState._decodedOwnUrl = null;
    _editState.originalUrl = f.url;
  }
  _editState.fileType = _detectEditFileType(f.file);
  _editState.pendingEdits = {};
  _editState.rotateState = { deg: 0, flipH: false, flipV: false, angle: 0 };
  _editState._undoStack = []; _editState._redoStack = [];
  _editState.framesState = null;
  if (_editState.bgState && _editState.bgState.previewUrl) {
    try { URL.revokeObjectURL(_editState.bgState.previewUrl); } catch(_){}
  }
  _editState.bgState = null;
  document.body.dataset.editOpen = 'true';
  const modal = document.getElementById('editModal');
  if (!modal) return;
  modal.removeAttribute('hidden');
  const eb0 = document.getElementById('editBody'); if (eb0) delete eb0.dataset.splitBound;
  const title = document.getElementById('editTitle');
  if (title) title.textContent = (f.name || 'image');
  const tabs = _editTabsForType(_editState.fileType);
  const tabBar = document.getElementById('editTabs');
  tabBar.innerHTML = '';
  tabs.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'edit-tab' + (i === 0 ? ' active' : '');
    btn.dataset.tab = t.id;
    /* R20 - every tab gets an icon + label. R22 - title carries shortcut hint. */
    btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + (t.icon || 'i-arrow-left-right') + '"/></svg><span>' + t.label + '</span>';
    btn.title = t.label + ' — ' + (i + 1);
    btn.addEventListener('click', () => _switchEditTab(t.id));
    tabBar.appendChild(btn);
  });
  _switchEditTab(tabs[0].id);
  _updateEditHistoryUI();
  /* R33 — keep split-btn above the card on resize (e.g. virtual keyboard,
     orientation change). One listener per page session. */
  if (!window._editResizeBound) {
    window._editResizeBound = true;
    window.addEventListener('resize', function(){
      requestAnimationFrame(_updateSplitBtnPos);
    }, { passive: true });
  }
  /* R34 — wire zoom once per page load */
  try { _wireEditZoom(); } catch(_){}
}
/* R26 — _updateTabsOverflow + _scrollActiveTabIntoView + _wireTabsOverflowWatcher
   are dead code from R19's horizontal-scroll tab bar. R20 replaced
   those tabs with equal-width flex:1 categorized tabs that don't
   overflow, but these functions were kept calling because the CSS
   classes they toggle (.edit-tabs--overflow-l/-r) used to have
   mask-image rules that are now gone. The toggles were no-ops in
   visible effect. Stub them out to stop the runtime work. */
function _updateTabsOverflow(){ /* R26: noop */ }
/* R31 — revived: scrolls the active tool button into view inside the
   horizontal strip. Uses scrollIntoView with inline:'nearest' so it
   nudges the strip just enough without over-scrolling. */
function _scrollActiveTabIntoView(){
  const active = document.querySelector('.edit-modal .edit-tab-bar .edit-tab.active');
  if (active) active.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'nearest' });
}
let _tabsOverflowWired = false;
function _wireTabsOverflowWatcher(){ /* R26: noop */ }
/* R34 — tools render into editZoomLayer (inside editPreviewCol) so
   CSS transforms on the zoom layer only affect image content, not the
   split-compare button/overlay which live directly on editPreviewCol. */
function _editPreviewEl(){
  return document.getElementById('editZoomLayer') || document.getElementById('editPreviewCol');
}

/* R34 — edit-canvas zoom state, mirrors the main-tool ZOOM object. */
const EDIT_ZOOM = { scale:1, x:0, y:0, dragging:false, lastX:0, lastY:0, pinchDist:0, _chipTimer:null };
function _applyEditZoom(){
  const zl = document.getElementById('editZoomLayer');
  if (!zl) return;
  zl.style.transform = `translate(${EDIT_ZOOM.x}px,${EDIT_ZOOM.y}px) scale(${EDIT_ZOOM.scale})`;
  const chip = document.getElementById('editZoomChip');
  if (!chip) return;
  chip.textContent = Math.round(EDIT_ZOOM.scale * 100) + '%';
  if (EDIT_ZOOM.scale > 1.005){
    chip.classList.add('show');
    if (EDIT_ZOOM._chipTimer) clearTimeout(EDIT_ZOOM._chipTimer);
    EDIT_ZOOM._chipTimer = setTimeout(() => chip.classList.remove('show'), 1200);
  } else {
    chip.classList.remove('show');
  }
}
function _resetEditZoom(){
  EDIT_ZOOM.scale=1; EDIT_ZOOM.x=0; EDIT_ZOOM.y=0;
  EDIT_ZOOM.dragging=false; EDIT_ZOOM.pinchDist=0;
  _applyEditZoom();
}
function _setEditZoomToward(nextScale, cx, cy){
  const col = document.getElementById('editPreviewCol');
  if (!col) return;
  const r = col.getBoundingClientRect();
  const mx = cx - r.left - r.width/2;
  const my = cy - r.top  - r.height/2;
  const nz = Math.max(1, Math.min(6, nextScale));
  if (nz === EDIT_ZOOM.scale) return;
  const f = nz / EDIT_ZOOM.scale;
  EDIT_ZOOM.x = mx - (mx - EDIT_ZOOM.x)*f;
  EDIT_ZOOM.y = my - (my - EDIT_ZOOM.y)*f;
  EDIT_ZOOM.scale = nz;
  if (EDIT_ZOOM.scale <= 1){ EDIT_ZOOM.x=0; EDIT_ZOOM.y=0; }
  _applyEditZoom();
}
function _wireEditZoom(){
  const col = document.getElementById('editPreviewCol');
  if (!col || col.dataset.editZoomWired) return;
  col.dataset.editZoomWired = '1';
  /* wheel zoom — skip when target is inside the bottom pill/card */
  col.addEventListener('wheel', e => {
    if (e.target.closest('.edit-action-pill,.edit-menu-card')) return;
    /* crop has its own canvas; leave wheel alone there */
    if (document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')) return;
    e.preventDefault();
    _setEditZoomToward(EDIT_ZOOM.scale + (e.deltaY > 0 ? -0.18 : 0.18), e.clientX, e.clientY);
  }, { passive:false });
  /* double-click: toggle 1× ↔ 2.5× */
  col.addEventListener('dblclick', e => {
    if (e.target.closest('.edit-action-pill,.edit-menu-card')) return;
    if (document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')) return;
    if (EDIT_ZOOM.scale > 1) _resetEditZoom();
    else _setEditZoomToward(2.5, e.clientX, e.clientY);
  });
  /* drag-to-pan when zoomed */
  col.addEventListener('pointerdown', e => {
    if (EDIT_ZOOM.scale <= 1) return;
    if (e.target.closest('.edit-action-pill,.edit-menu-card,.edit-split-btn,.edit-crop-canvas-wrap,.edit-split-handle')) return;
    EDIT_ZOOM.dragging=true; EDIT_ZOOM.lastX=e.clientX; EDIT_ZOOM.lastY=e.clientY;
    try { col.setPointerCapture(e.pointerId); } catch(_){}
  });
  col.addEventListener('pointermove', e => {
    if (!EDIT_ZOOM.dragging) return;
    EDIT_ZOOM.x += e.clientX - EDIT_ZOOM.lastX;
    EDIT_ZOOM.y += e.clientY - EDIT_ZOOM.lastY;
    EDIT_ZOOM.lastX=e.clientX; EDIT_ZOOM.lastY=e.clientY;
    _applyEditZoom();
  });
  const _endEditDrag = e => { EDIT_ZOOM.dragging=false; try{ col.releasePointerCapture(e.pointerId); }catch(_){} };
  col.addEventListener('pointerup', _endEditDrag);
  col.addEventListener('pointercancel', _endEditDrag);
  /* pinch-to-zoom on touch */
  col.addEventListener('touchmove', e => {
    if (e.touches.length !== 2) return;
    if (document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')) return;
    e.preventDefault();
    const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY;
    const dist=Math.sqrt(dx*dx+dy*dy);
    if (EDIT_ZOOM.pinchDist>0){
      const sc=dist/EDIT_ZOOM.pinchDist;
      _setEditZoomToward(EDIT_ZOOM.scale*sc,
        (e.touches[0].clientX+e.touches[1].clientX)/2,
        (e.touches[0].clientY+e.touches[1].clientY)/2);
    }
    EDIT_ZOOM.pinchDist=dist;
  }, { passive:false });
  col.addEventListener('touchend', e => { if (e.touches.length<2) EDIT_ZOOM.pinchDist=0; });
}

function _switchEditTab(tabId){
  document.querySelectorAll('.edit-modal .edit-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });
  if (typeof _wireTabsOverflowWatcher === 'function') _wireTabsOverflowWatcher();
  /* R31 — scroll active tool into view + trigger slide-up animation. */
  requestAnimationFrame(()=>{
    _scrollActiveTabIntoView();
    const body = document.getElementById('editBody');
    if (body && body.children.length){
      body.classList.remove('anim-in');
      void body.offsetWidth;
      body.classList.add('anim-in');
    }
  });
  /* R30 — Remove any portalled adjust-tab dropdowns from a previous tab
     render. The dropdowns are appended to <body> (not #editBody) so the
     normal body.innerHTML='' below doesn't clean them up. */
  /* R30c — Class-based portal cleanup picks up every tool dropdown. */
  document.querySelectorAll('body > .edit-filter-dd-menu, body > .edit-vignette-dd-menu, body > .edit-adjust-dd-menu, body > .edit-tool-dd-menu').forEach(m => {
    if (m.parentNode === document.body) m.parentNode.removeChild(m);
  });
  const body = document.getElementById('editBody');
  body.innerHTML = '';
  const previewCol = document.getElementById('editPreviewCol');
  if (previewCol) {
    previewCol.innerHTML = '';
    /* R34 — recreate zoom layer; split UI (btn+overlay) will be appended
       by _ensureSplitUi to editPreviewCol directly, outside this layer. */
    const _zl = document.createElement('div');
    _zl.id = 'editZoomLayer'; _zl.className = 'edit-zoom-layer edit-preview-col';
    previewCol.appendChild(_zl);
    _resetEditZoom();
  }
  /* R51 — clear floating section pill before tab content renders;
     _renderAdjustTab and _renderFiltersTab will re-show it. */
  try { _hideAdjSectionPill(); } catch(_){}
  /* R20 routing - grouped tabs delegate to existing renderers via a
     sub-toggle wrapper. Legacy IDs still route for backward-compat. */
  if (tabId === 'frames') _renderFramesTab(body);
  else if (tabId === 'adjust') _renderAdjustTab(body);
  else if (tabId === 'filters') _renderFiltersTab(body);
  else if (tabId === 'transform') _renderTransformTab(body);
  else if (tabId === 'rotate') _renderRotateTab(body);
  else if (tabId === 'crop') { _renderCropTab(body).catch(e => console.warn('[crop]', e)); }
  else if (tabId === 'blur') { _renderBlurTab(body).catch(e => console.warn('[blur]', e)); }
  /* Round 10: ensure split-compare UI persists across tab switches. */
  try { _ensureSplitUi(); } catch(_) {}
  /* R45 — recompute pill position after the new tab's options strip
     has measured its height. rAF gives the layout a tick to settle. */
  requestAnimationFrame(() => {
    try { _updateSplitBtnPos(); } catch(_){}
    try { _updateMenuCardH(); } catch(_){}
  });
}
/* R20 wrappers - Transform (Rotate|Crop) and Retouch (Pixelate|Blur). */
function _renderSubToggle(body, items, activeId, onSwitch){
  const wrap = document.createElement('div');
  wrap.className = 'edit-subtoggle';
  wrap.setAttribute('role', 'tablist');
  items.forEach(it => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'edit-subtab' + (it.id === activeId ? ' active' : '');
    b.dataset.subtab = it.id;
    b.setAttribute('role', 'tab');
    b.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + it.icon + '"/></svg><span>' + it.label + '</span>';
    b.addEventListener('click', () => {
      if (it.id === activeId) return;
      onSwitch(it.id);
    });
    wrap.appendChild(b);
  });
  body.appendChild(wrap);
  const sub = document.createElement('div');
  sub.className = 'edit-subbody';
  sub.id = 'editSubBody';
  body.appendChild(sub);
  return sub;
}
function _renderTransformTab(body){
  const sub = _editState._transformSub || 'rotate';
  _editState._transformSub = sub;
  const subBody = _renderSubToggle(body, [
    { id: 'rotate', label: 'Rotate', icon: 'i-rotate-cw' },
    { id: 'crop',   label: 'Crop',   icon: 'i-scissors' }
  ], sub, (newSub) => {
    _editState._transformSub = newSub;
    body.innerHTML = '';
    _renderTransformTab(body);
    if (typeof _updateSplitBtnState === 'function') _updateSplitBtnState();
  });
  if (sub === 'rotate') _renderRotateTab(subBody);
  else if (sub === 'crop') _renderCropTab(subBody).catch(e => console.warn('[crop]', e));
}
function cancelEdit(){
  /* R30 — Clean up portalled adjust-tab dropdowns (filter / vignette menus
     are appended to <body>, not #editBody, so they wouldn't otherwise be
     removed when the modal closes). */
  /* R30c — Class-based portal cleanup picks up every tool dropdown. */
  document.querySelectorAll('body > .edit-filter-dd-menu, body > .edit-vignette-dd-menu, body > .edit-adjust-dd-menu, body > .edit-tool-dd-menu').forEach(m => {
    if (m.parentNode === document.body) m.parentNode.removeChild(m);
  });
  if (_editState._blurBitmap){ try { _editState._blurBitmap.close && _editState._blurBitmap.close(); } catch(_){} _editState._blurBitmap = null; }
  _editState._blurBaseBlob = null; _editState._blurBaseSig = null;
  /* Round 17 HEIC fix: release the decoded-JPEG blob URL we minted in
   * openEditMode so it doesn't leak between Edit sessions. */
  if (_editState._decodedOwnUrl){
    try { URL.revokeObjectURL(_editState._decodedOwnUrl); } catch(_){}
    _editState._decodedOwnUrl = null;
  }
  document.body.dataset.editOpen = 'false';
  const modal = document.getElementById('editModal');
  if (modal) modal.setAttribute('hidden', '');
  _editState.active = false;
  _editState.pendingEdits = {};
  _editState._splitActive = false;
  if (_editState.framesState && _editState.framesState.frames) {
    _editState.framesState.frames.forEach(fr => { try { fr.bitmap && fr.bitmap.close && fr.bitmap.close(); } catch(_){} });
  }
  _editState.framesState = null;
  if (_editState.bgState){
    if (_editState.bgState._refineBgBmp){ try { _editState.bgState._refineBgBmp.close && _editState.bgState._refineBgBmp.close(); } catch(_){} _editState.bgState._refineBgBmp = null; }
    if (_editState.bgState._refineOrigBmp){ try { _editState.bgState._refineOrigBmp.close && _editState.bgState._refineOrigBmp.close(); } catch(_){} _editState.bgState._refineOrigBmp = null; }
  }
  _editState.bgState = null;
  if (_editState.pendingEdits && _editState.pendingEdits.autoEnhancedUrl){
    try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
  }
  if (_editState._pxBitmap){
    try { _editState._pxBitmap.close && _editState._pxBitmap.close(); } catch(_){}
    _editState._pxBitmap = null;
  }
  _editState._pxBaseUrl && (function(){ try { URL.revokeObjectURL(_editState._pxBaseUrl); } catch(_){} })();
  _editState._pxBaseUrl = null;
  _editState._pxBaseBlob = null;
  if (_editState._txBitmap){
    try { _editState._txBitmap.close && _editState._txBitmap.close(); } catch(_){}
    _editState._txBitmap = null;
  }
  if (_editState._txBaseUrl){ try { URL.revokeObjectURL(_editState._txBaseUrl); } catch(_){} _editState._txBaseUrl = null; _editState._txBaseBlob = null; _editState._txBaseSig = null; }
}
async function saveEdit(){
  const idx = _editState.idx;
  if (idx < 0 || !FILES[idx]) { cancelEdit(); return; }
  const f = FILES[idx];
  const saveBtn = document.getElementById('editSaveBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026'; }
  let newBlob = null;
  try {
    /* Round 17 HEIC fix: the photo-edit chain feeds workingBlob into
     * createImageBitmap() in every _applyX helper. For HEIC entries
     * f.file is the raw HEIC (un-decodable by Chrome/Firefox/Edge),
     * so start from the decoded JPEG blob the round-11 fix stashes
     * in _editState.originalFile. Non-HEIC: originalFile === f.file. */
    let workingBlob = _editState.originalFile || f.file;
    if (_editState.pendingEdits.gifEdit) {
      workingBlob = await _applyGifEdit(f.file, _editState.pendingEdits.gifEdit);
    } else {
      if (_editState.pendingEdits.autoEnhanced) {
        workingBlob = _editState.pendingEdits.autoEnhanced;
      }
      if (_editState.pendingEdits.rotate && _editState.rotateState && _editState.rotateState.enabled !== false) {
        workingBlob = await _applyRotation(workingBlob, _editState.pendingEdits.rotate);
      }
      /* R47 — skip if both sub-sections disabled. _applyPhotoAdjust itself
         is now per-section aware. */
      if (_editState.pendingEdits.photoAdjust && _editState.pendingEdits.photoAdjust._dirty) {
        const _pa = _editState.pendingEdits.photoAdjust;
        if (_pa.sliderEnabled !== false || _pa.filterEnabled !== false) {
          workingBlob = await _applyPhotoAdjust(workingBlob, _pa);
        }
      }
      if (_editState.pendingEdits.photoCrop) {
        workingBlob = await _applyPhotoCrop(workingBlob, _editState.pendingEdits.photoCrop);
      }
      if (_editState.pendingEdits.vignette && _editState.pendingEdits.vignette._dirty && _editState.pendingEdits.vignette.enabled !== false) {
        workingBlob = await _applyVignette(workingBlob, _editState.pendingEdits.vignette);
      }
      if (_editState.pendingEdits.blur && (
            (_editState.pendingEdits.blur.strokes && _editState.pendingEdits.blur.strokes.length) ||
            _editState.pendingEdits.blur.full) && _editState.pendingEdits.blur.enabled !== false) {
        workingBlob = await _applyBlur(workingBlob, _editState.pendingEdits.blur);
      }
    }
    newBlob = (workingBlob !== f.file) ? workingBlob : null;
  } catch (err) {
    console.warn('[edit] save failed', err);
    (window.imgreadyToast||alert)('Edit failed: ' + (err.message || err));
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    return;
  }
  if (newBlob) {
    try { URL.revokeObjectURL(f.url); } catch(_){}
    let newName = f.file.name || 'image';
    if (_editState.pendingEdits.bgRemoved && newBlob === _editState.pendingEdits.bgRemoved) {
      newName = newName.replace(/\.[^.]+$/, '') + '.png';
    } else if (/\.(heic|heif)$/i.test(newName)){
      /* Round 17 HEIC fix: every Edit path encodes via canvas.toBlob,
       * which can only emit image/png or image/jpeg. Keep the file name
       * honest so downloads match the bytes inside. */
      const ext = (newBlob.type === 'image/png') ? '.png' : '.jpg';
      newName = newName.replace(/\.[^.]+$/, '') + ext;
    }
    f.file = new File([newBlob], newName, { type: newBlob.type || f.file.type });
    f.url = URL.createObjectURL(newBlob);
    f.dims = null;
    if (typeof ENCODE !== 'undefined' && ENCODE.encoded && ENCODE.encoded.has(idx)) {
      const e = ENCODE.encoded.get(idx);
      try { URL.revokeObjectURL(e.url); } catch(_){}
      ENCODE.encoded.delete(idx);
    }
    if (typeof ENCODE !== 'undefined' && ENCODE.allEncoded && ENCODE.allEncoded.has(idx)) {
      const bundle = ENCODE.allEncoded.get(idx);
      if (bundle) bundle.forEach(b => { try { URL.revokeObjectURL(b.url); } catch(_){} });
      ENCODE.allEncoded.delete(idx);
    }
    if (typeof buildThumbs === 'function') buildThumbs();
    if (typeof layoutCoverFlow === 'function') layoutCoverFlow();
    if (typeof invalidateEncoded === 'function') invalidateEncoded();
    if (typeof syncMainImage === 'function') syncMainImage(true);
  }
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  cancelEdit();
}
/* ---- EDIT UNDO/REDO HELPERS (Round 4) ---- */
function _editSnapshot(){
  const pe = _editState.pendingEdits;
  return {
    rotate: pe.rotate ? { ...pe.rotate } : null,
    photoAdjust: pe.photoAdjust ? { ...pe.photoAdjust } : null,
    photoCrop: pe.photoCrop ? { ...pe.photoCrop } : null,
    bgRemoved: pe.bgRemoved || null,
    bgRefine: pe.bgRefine ? JSON.parse(JSON.stringify(pe.bgRefine)) : null,
    autoEnhanced: pe.autoEnhanced || null,
    autoEnhancedUrl: pe.autoEnhancedUrl || null,
    pixelate: pe.pixelate ? JSON.parse(JSON.stringify(pe.pixelate)) : null,
    blur: pe.blur ? JSON.parse(JSON.stringify(pe.blur)) : null,
    vignette: pe.vignette ? { ...pe.vignette } : null,
    textOverlays: pe.textOverlays ? JSON.parse(JSON.stringify(pe.textOverlays)) : null,
    gifEdit: pe.gifEdit ? JSON.parse(JSON.stringify(pe.gifEdit)) : null,
    rotateState: { ..._editState.rotateState },
  };
}
function _editRestore(snap){
  _editState.pendingEdits = {};
  if (snap.rotate) _editState.pendingEdits.rotate = snap.rotate;
  if (snap.photoAdjust) _editState.pendingEdits.photoAdjust = snap.photoAdjust;
  if (snap.photoCrop) _editState.pendingEdits.photoCrop = snap.photoCrop;
  if (snap.bgRemoved) _editState.pendingEdits.bgRemoved = snap.bgRemoved;
  if (snap.bgRefine) _editState.pendingEdits.bgRefine = snap.bgRefine;
  if (snap.autoEnhanced) {
    _editState.pendingEdits.autoEnhanced = snap.autoEnhanced;
    _editState.pendingEdits.autoEnhancedUrl = snap.autoEnhancedUrl;
  }
  if (snap.pixelate) _editState.pendingEdits.pixelate = snap.pixelate;
  if (snap.blur) _editState.pendingEdits.blur = snap.blur;
  if (snap.vignette) _editState.pendingEdits.vignette = snap.vignette;
  if (snap.textOverlays) _editState.pendingEdits.textOverlays = snap.textOverlays;
  if (snap.gifEdit) _editState.pendingEdits.gifEdit = snap.gifEdit;
  _editState.rotateState = { ...snap.rotateState };
}
function _editPushUndo(){
  try { _updateSplitBtnState(); } catch(_){}
  _editState._undoStack.push(_editSnapshot());
  if (_editState._undoStack.length > 20) _editState._undoStack.shift();
  _editState._redoStack = [];
  _updateEditHistoryUI();
}
function _editUndo(){
  if (!_editState._undoStack.length) return;
  _editState._redoStack.push(_editSnapshot());
  _editRestore(_editState._undoStack.pop());
  _updateEditHistoryUI();
  _reRenderEditTab();
}
function _editRedo(){
  if (!_editState._redoStack.length) return;
  _editState._undoStack.push(_editSnapshot());
  _editRestore(_editState._redoStack.pop());
  _updateEditHistoryUI();
  _reRenderEditTab();
}
function _editResetAll(){
  if (_editState._blurBitmap){ try { _editState._blurBitmap.close && _editState._blurBitmap.close(); } catch(_){} _editState._blurBitmap = null; }
  _editState._blurBaseBlob = null; _editState._blurBaseSig = null;
  if (!_editState.active) return;
  _editPushUndo();
  _editState.pendingEdits = {};
  _editState.rotateState = { deg: 0, flipH: false, flipV: false, angle: 0 };
  if (_editState.bgState && _editState.bgState.previewUrl){
    try { URL.revokeObjectURL(_editState.bgState.previewUrl); } catch(_){}
  }
  if (_editState.bgState){
    if (_editState.bgState._refineBgBmp){ try { _editState.bgState._refineBgBmp.close && _editState.bgState._refineBgBmp.close(); } catch(_){} _editState.bgState._refineBgBmp = null; }
    if (_editState.bgState._refineOrigBmp){ try { _editState.bgState._refineOrigBmp.close && _editState.bgState._refineOrigBmp.close(); } catch(_){} _editState.bgState._refineOrigBmp = null; }
  }
  _editState.bgState = null;
  if (_editState._pxBitmap){
    try { _editState._pxBitmap.close && _editState._pxBitmap.close(); } catch(_){}
    _editState._pxBitmap = null;
  }
  if (_editState._pxBaseUrl){ try { URL.revokeObjectURL(_editState._pxBaseUrl); } catch(_){} _editState._pxBaseUrl = null; _editState._pxBaseBlob = null; }
  if (_editState._txBitmap){
    try { _editState._txBitmap.close && _editState._txBitmap.close(); } catch(_){}
    _editState._txBitmap = null;
  }
  if (_editState._txBaseUrl){ try { URL.revokeObjectURL(_editState._txBaseUrl); } catch(_){} _editState._txBaseUrl = null; _editState._txBaseBlob = null; _editState._txBaseSig = null; }
  _updateEditHistoryUI();
  _reRenderEditTab();
}
function _reRenderEditTab(){
  const active = document.querySelector('.edit-modal .edit-tab.active');
  if (active) _switchEditTab(active.dataset.tab);
}
function _hasEdits(){
  /* R61 — real dirty check. The previous impl counted any pendingEdits
     key as "edited", but renderers populate default state objects
     (e.g. pendingEdits.photoAdjust gets initialized at neutral values
     just to drive the UI). A fresh-opened editor would lie and report
     "Save" required. Now we look at the actual dirty flags / non-default
     values. */
  const pe = _editState.pendingEdits || {};
  const rs = _editState.rotateState  || {};
  if (rs.deg !== 0 || rs.flipH || rs.flipV || rs.angle !== 0) return true;
  if (pe.photoAdjust) {
    const a = pe.photoAdjust;
    if (a._dirty) return true;
    if (a.brightness !== 100 || a.contrast !== 100 || a.saturation !== 100) return true;
    if (a.preset && a.preset !== 'none') return true;
    if (a.globalBlur && a.globalBlur > 0) return true;
  }
  if (pe.vignette && pe.vignette._dirty) return true;
  if (pe.photoCrop) return true;
  if (pe.blur && ((pe.blur.strokes && pe.blur.strokes.length) || pe.blur.full)) return true;
  if (pe.autoEnhanced) return true;
  return false;
}
function _updateEditHistoryUI(){
  const resetBtn = document.getElementById('editResetBtn');
  const hasEdits = _hasEdits();
  if (resetBtn) resetBtn.disabled = !hasEdits && !_editState._undoStack.length;
  const undoBtn = document.getElementById('editUndoBtn');
  if (undoBtn) undoBtn.disabled = !_editState._undoStack.length;
  const redoBtn = document.getElementById('editRedoBtn');
  if (redoBtn) redoBtn.disabled = !_editState._redoStack.length;
  /* R60 — dynamic Save/Done label. */
  const saveTop = document.getElementById('editSaveBtnTop');
  if (saveTop) {
    if (hasEdits) {
      saveTop.textContent = 'Save';
      saveTop.title = 'Save edits';
      saveTop.classList.add('has-edits');
    } else {
      saveTop.textContent = 'Done';
      saveTop.title = 'Close editor';
      saveTop.classList.remove('has-edits');
    }
  }
  _updateEditSizeInfo();
}
function _updateEditSizeInfo(){
  const el = document.getElementById('editSizeInfo');
  if (!el || !_editState.active || typeof FILES === 'undefined') return;
  const f = FILES[_editState.idx];
  if (!f) return;
  let txt = fmtSize(f.file.size) + ' original';
  if (typeof ENCODE !== 'undefined' && ENCODE.encoded && ENCODE.encoded.has(_editState.idx)){
    const e = ENCODE.encoded.get(_editState.idx);
    if (e && e.size) txt += ' → ~' + fmtSize(e.size) + ' ' + (e.format || '').toUpperCase();
  }
  el.textContent = txt;
}
/* ---- Round 10 — Before/After split-slider ---- */

/* R47 — Adjust tab tap-to-disable. Injects a small dot inside each
   modified chip; click toggles the section's enabled flag (preserves
   values), click elsewhere on the chip opens its dropdown as before. */
function _r47WireSectionToggles(){
  const pe = _editState.pendingEdits;
  if (!pe || !pe.photoAdjust || !pe.vignette) return;
  const adj = pe.photoAdjust;
  const vig = pe.vignette;
  const slidDirty   = !(adj.brightness === 100 && adj.contrast === 100 && adj.saturation === 100);
  const filterDirty = (adj.preset !== 'none');
  const vigDirty    = !!vig._dirty;
  function wire(triggerId, isDirty, isEnabled, onToggle){
    const trig = document.getElementById(triggerId);
    if (!trig) return;
    /* Clean any existing dot before re-inserting */
    const old = trig.querySelector('.edit-section-toggle');
    if (old) old.remove();
    if (!isDirty) return;
    const dot = document.createElement('span');
    dot.className = 'edit-section-toggle' + (isEnabled ? ' on' : ' off');
    dot.title = isEnabled ? 'Disable this adjustment (values kept)' : 'Re-enable this adjustment';
    dot.setAttribute('role', 'switch');
    dot.setAttribute('aria-checked', isEnabled ? 'true' : 'false');
    dot.setAttribute('aria-label', dot.title);
    dot.addEventListener('click', function(e){
      e.stopPropagation();
      e.preventDefault();
      onToggle();
    });
    /* Insert as the FIRST child of the trigger so the dot sits left of
       the label, matching the iPhone Photos icon-on-the-left convention. */
    trig.insertBefore(dot, trig.firstChild);
    trig.classList.toggle('section-disabled', !isEnabled);
  }
  wire('editAdjustTrigger', slidDirty, adj.sliderEnabled !== false, function(){
    adj.sliderEnabled = adj.sliderEnabled === false ? true : false;
    /* Re-render the Adjust tab so chip state + preview update together. */
    _reRenderEditTab();
  });
  wire('editFilterTrigger', filterDirty, adj.filterEnabled !== false, function(){
    adj.filterEnabled = adj.filterEnabled === false ? true : false;
    _reRenderEditTab();
  });
  wire('editVignetteTrigger', vigDirty, vig.enabled !== false, function(){
    vig.enabled = vig.enabled === false ? true : false;
    _reRenderEditTab();
  });
}

function _editHasAnyEdit(){
  if (!_editState) return false;
  const r = _editState.rotateState || {};
  if (r.deg || r.angle || r.flipH || r.flipV) return true;
  const pe = _editState.pendingEdits || {};
  if (pe.bgRemoved || pe.bgRefine) return true;
  /* photoAdjust seeds itself with neutral values (100/100/100 + preset:'none'); the canonical
   * dirty signal is the ._dirty flag the adjust tab maintains via the same predicate. */
  if (pe.photoAdjust && pe.photoAdjust._dirty) return true;
  if (pe.photoCrop) return true;
  if (pe.rotate) return true;
  if (pe.autoEnhanced) return true;
  if (pe.pixelate && Array.isArray(pe.pixelate.strokes) && pe.pixelate.strokes.length) return true;
  if (pe.blur && ((Array.isArray(pe.blur.strokes) && pe.blur.strokes.length) || pe.blur.full)) return true;
  if (pe.vignette && pe.vignette._dirty) return true;
  if (pe.textOverlays && Array.isArray(pe.textOverlays) && pe.textOverlays.length) return true;
  /* GIF: frame-level mutation surfaces as pendingEdits.gifEdit. */
  if (pe.gifEdit) return true;
  if (_editState.framesState && _editState.framesState.dirty) return true;
  return false;
}
function _ensureSplitUi(){
  const col = document.getElementById('editPreviewCol');
  if (!col) return;
  /* R60 — floating action pill removed; history controls live in the
     top chrome now. Compare chip + zoom chip still get anchored to
     editPreviewCol. */
  if (!col.querySelector('.edit-compare-chip')){
    const cc = document.createElement('button');
    cc.type = 'button';
    cc.className = 'edit-compare-chip'; cc.id = 'editCompareChip';
    cc.innerHTML = '<svg class="ico" aria-hidden="true" style="width:13px;height:13px"><use href="#i-arrow-left-right"/></svg>Compare';
    cc.title = 'Compare original vs edited — drag the divider';
    cc.addEventListener('click', _toggleSplitCompare);
    col.appendChild(cc);
  }
  if (!col.querySelector('.edit-zoom-chip')){
    const zc = document.createElement('div');
    zc.className = 'edit-zoom-chip'; zc.id = 'editZoomChip';
    col.appendChild(zc);
  }
  if (!col.querySelector('.edit-split-overlay')){
    const ov = document.createElement('div');
    ov.className = 'edit-split-overlay';
    ov.id = 'editSplitOverlay';
    ov.style.setProperty('--split-x', '50%');
    ov.style.setProperty('--split-right', '50%');
    ov.innerHTML = ''
      + '<span class="edit-split-label before">Original</span>'
      + '<span class="edit-split-label after">Edited</span>'
      + '<img id="editSplitImg" alt="Original">'
      + '<div class="edit-split-handle" id="editSplitHandle" role="slider" aria-label="Compare original vs edited"></div>';
    col.appendChild(ov);
    _initSplitDrag(ov.querySelector('.edit-split-handle'));
  }
  /* Restore active state when re-rendering the same tab while split was on. */
  const ov = col.querySelector('.edit-split-overlay');
  const btn = col.querySelector('.edit-split-btn');
  if (_editState._splitActive){
    ov.classList.add('active');
    if (btn) btn.classList.add('active');
    const img = ov.querySelector('#editSplitImg');
    if (img && _editState.originalUrl) img.src = _editState.originalUrl;
  } else {
    ov.classList.remove('active');
    if (btn) btn.classList.remove('active');
  }
  /* One-shot delegated listeners on #editBody so the Compare button enables/disables
   * after the user mutates state via clicks, slider input/change, or programmatic changes. */
  const eb = document.getElementById('editBody');
  if (eb && eb.dataset.splitBound !== '1'){
    eb.dataset.splitBound = '1';
    const refresh = () => { try { queueMicrotask(_updateSplitBtnState); } catch(_) { _updateSplitBtnState(); } };
    eb.addEventListener('click', refresh, true);
    eb.addEventListener('input', refresh, true);
    eb.addEventListener('change', refresh, true);
  }
  _updateSplitBtnState();
  try { _updateSplitBtnPos(); } catch(_) {}
}
/* R33 — reposition the floating split-compare button so it always clears
   the card. The card (edit-menu-wrap) is position:absolute bottom:16px,
   so the button should sit card_height + 16 + 12px gap above the screen
   bottom. Called on every tab switch and on window resize. */
function _updateMenuCardH(){
  /* R67 — expose .edit-menu-card height as --menu-card-h on the modal
     so the floating tool surface can anchor directly above it. */
  const card = document.querySelector('.edit-modal .edit-menu-card');
  const modal = document.querySelector('.edit-modal');
  if (!card || !modal) return;
  const h = Math.round(card.getBoundingClientRect().height);
  if (h > 0) modal.style.setProperty('--menu-card-h', h + 'px');
}
function _updateSplitBtnPos(){
  _updateMenuCardH();
  /* R45 — anchor the pill above the WHOLE menu-card, not just the
     tab-bar. R43 anchored to tabBar.top which works only when the
     options strip above the tabs is short. On tabs with tall content
     (Adjust: Auto-enhance + ADJUST + FILTER + VIGNETTE dropdowns), the
     options strip pushes the card top way up while the tab-bar stays
     at the card bottom — so anchoring 32px above the tab-bar landed
     the pill INSIDE the options strip, overlapping content. Now we
     anchor 12px above the menu-card's top edge regardless of how
     tall the strip grows. */
  const menuCard = document.querySelector('.edit-modal .edit-menu-card');
  const modal    = document.querySelector('.edit-modal');
  if (!menuCard || !modal) return;
  const cardTop  = menuCard.getBoundingClientRect().top;
  const modalBot = modal.getBoundingClientRect().bottom;
  modal.style.setProperty('--split-btn-bottom', (modalBot - cardTop + 12) + 'px');
}
function _updateSplitBtnState(){
  /* R37 — compare chip replaces the split-btn in the pill. */
  const chip = document.getElementById('editCompareChip');
  const onCrop = !!document.querySelector('.edit-modal .edit-tab.active[data-tab="crop"]')
              || !!document.querySelector('.edit-modal .edit-subtab.active[data-subtab="crop"]');
  if (onCrop){
    if (chip) chip.classList.remove('visible');
    if (_editState._splitActive){ _editState._splitActive = false; _ensureSplitUi(); }
    return;
  }
  const has = _editHasAnyEdit();
  if (chip){ chip.classList.toggle('visible', has); chip.classList.toggle('active', !!_editState._splitActive); }
}
function _toggleSplitCompare(){
  if (!_editState || _editState.idx < 0) return;
  /* If the full View-original overlay is currently shown, dismiss it first. */
  const fullOv = document.getElementById('editCompareOverlay');
  if (fullOv && fullOv.style.display === 'flex') _toggleEditCompare();
  _editState._splitActive = !_editState._splitActive;
  _ensureSplitUi();
}
function _initSplitDrag(handle){
  if (!handle || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';
  let dragging = false;
  const move = (clientX) => {
    const col = document.getElementById('editPreviewCol');
    if (!col) return;
    const r = col.getBoundingClientRect();
    const pct = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
    const ov = document.getElementById('editSplitOverlay');
    if (!ov) return;
    ov.style.setProperty('--split-x', pct.toFixed(2) + '%');
    ov.style.setProperty('--split-right', (100 - pct).toFixed(2) + '%');
  };
  handle.addEventListener('pointerdown', (e) => {
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch(_){}
    move(e.clientX);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    move(e.clientX);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch(_){}
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
  /* Keyboard: ArrowLeft/Right nudges the divider 2% */
  handle.tabIndex = 0;
  handle.addEventListener('keydown', (e) => {
    const ov = document.getElementById('editSplitOverlay');
    if (!ov) return;
    const cur = parseFloat(ov.style.getPropertyValue('--split-x')) || 50;
    let next = cur;
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 2);
    else if (e.key === 'ArrowRight') next = Math.min(100, cur + 2);
    else return;
    ov.style.setProperty('--split-x', next.toFixed(2) + '%');
    ov.style.setProperty('--split-right', (100 - next).toFixed(2) + '%');
    e.preventDefault();
  });
}

/* ---- EDIT COMPARE (View Original) ---- */
function _toggleEditCompare(){
  const overlay = document.getElementById('editCompareOverlay');
  if (!overlay) return;
  const showing = overlay.style.display === 'flex';
  if (!showing){
    /* Round 10: mutex with split-compare. */
    if (_editState && _editState._splitActive){ _editState._splitActive = false; try { _ensureSplitUi(); } catch(_){} }
    const img = overlay.querySelector('#editCompareImg');
    if (img && _editState.originalUrl) img.src = _editState.originalUrl;
    overlay.style.display = 'flex';
    const btn = document.getElementById('editCompareBtn');
    if (btn){ btn.textContent = 'Hide original'; btn.classList.add('active'); }
  } else {
    overlay.style.display = 'none';
    const btn = document.getElementById('editCompareBtn');
    if (btn){ btn.textContent = 'View original'; btn.classList.remove('active'); }
  }
}
document.addEventListener('keydown', e => {
  if (document.body.dataset.editOpen !== 'true') return;
  if (e.key === 'Escape'){
    const overlay = document.getElementById('editCompareOverlay');
    if (overlay && overlay.style.display === 'flex'){
      _toggleEditCompare(); e.preventDefault(); return;
    }
    if (_editState && _editState._splitActive){
      _editState._splitActive = false; try { _ensureSplitUi(); } catch(_){}
      e.preventDefault(); return;
    }
    cancelEdit(); e.preventDefault(); return;
  }
  const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT';
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z') && !isInput){
    _editUndo(); e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey) || (e.key === 'Z' && e.shiftKey)) && !isInput){
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
  /* R22 — number keys 1-N jump to Edit modal tabs. Adobe convention.
     R107 — derive tab IDs from the live DOM rather than a hard-coded
     list. R88 reduced the editor to 4 tabs (adjust, filters, rotate,
     crop); the old hard-coded list still referenced removed tabs
     (transform, retouch, add, bg), so keys 2-5 silently no-op'd.
     Querying the DOM keeps the shortcut wired to whatever tabs are
     actually visible. */
  else if (/^[1-9]$/.test(e.key) && !isInput && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey){
    const tabs = document.querySelectorAll('.edit-modal .edit-tab[data-tab]');
    const idx = parseInt(e.key, 10) - 1;
    const target = tabs[idx];
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
document.addEventListener('pointercancel', () => { document.body.dataset.editDragging = ''; }, true);
/* ---- ROTATE TAB ---- */
function _renderRotateTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  const previewCol = _editPreviewEl();
  if (previewCol) {
    previewCol.innerHTML = `<div class="edit-rotate-preview" id="editRotatePreview" style="background-image:url('${_editState.originalUrl || f.url}');"></div>`;
  }
  /* R53 — Angle is now a circular icon + tick-ruler scrubber below
     (Apple-Photos style). Disable toggle replaces Reset; values persist. */
  const _rotAng = _editState.rotateState.angle;
  const _angleMod = _rotAng !== 0;
  const _rotEnabled = (_editState.rotateState.enabled !== false);
  const _anglePct = ((_rotAng - (-180)) / 360) * 100;
  body.innerHTML = `
    <div class="edit-tool-toolbar edit-rotate-toolbar adj-tab-r50">
      <div class="ed-func-row${_rotEnabled ? '' : ' row-disabled'}" id="editRotateRow">
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="cw" title="Rotate 90° clockwise" aria-label="Rotate 90° clockwise">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-rotate-cw"/></svg></span>
        </button>
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="ccw" title="Rotate 90° counter-clockwise" aria-label="Rotate 90° counter-clockwise">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-rotate-ccw"/></svg></span>
        </button>
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="fh" title="Flip horizontal" aria-label="Flip horizontal">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-flip-horizontal"/></svg></span>
        </button>
        <button type="button" class="ed-circle-btn edit-rotate-btn" data-rot="fv" title="Flip vertical" aria-label="Flip vertical">
          <span class="ed-circle-ring" aria-hidden="true"></span>
          <span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-flip-vertical"/></svg></span>
        </button>
      </div>
      <div class="adj-tick-ruler" id="editAngleRuler" style="--range:360;">
        <div class="adj-tick-ticks" aria-hidden="true"></div>
        <div class="adj-tick-center" aria-hidden="true"></div>
        <div class="adj-tick-dot" id="editAngleTickDot" style="left:${_anglePct.toFixed(2)}%;" aria-hidden="true"></div>
        <input type="range" id="editAngleSlider" class="adj-tick-input" min="-180" max="180" step="1" value="${_editState.rotateState.angle}" aria-label="Angle">
      </div>
    </div>
  `;
  /* R53 — show floating ANGLE pill over photo. */
  try {
    const _val = _angleMod ? (_rotAng > 0 ? '+' + _rotAng + '°' : _rotAng + '°') : '';
    _ensureAdjSectionPill('Angle', _val);
  } catch(_){}
  /* R65 — populate ticks for the Angle ruler. */
  try { _buildRulerTicks(document.getElementById('editAngleRuler')); } catch(_){}
  const preview = document.getElementById('editRotatePreview');
  function _updateRot(){
    const rs = _editState.rotateState;
    const enabled = (rs.enabled !== false);
    /* R66 — feed the RAW combined angle to CSS rotate so dragging the
       slider across 0 doesn't snap modulo and trigger a 360° spin. The
       encoded payload (used by the bake step) still normalizes to 0–360. */
    const totalRaw = rs.deg + rs.angle;
    const totalNorm = ((totalRaw % 360) + 360) % 360;
    const tx = enabled
      ? `rotate(${totalRaw}deg) scaleX(${rs.flipH ? -1 : 1}) scaleY(${rs.flipV ? -1 : 1})`
      : 'none';
    preview.style.transform = tx;
    const dirty = enabled && (rs.deg !== 0 || rs.flipH || rs.flipV || rs.angle !== 0);
    _editState.pendingEdits.rotate = dirty ? { deg: totalNorm, flipH: rs.flipH, flipV: rs.flipV } : null;
  }
  /* R53 — discrete rotate icons (CW/CCW/Flip H/Flip V) + angle slider. */
  document.querySelectorAll('#editBody .edit-rotate-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _editPushUndo();
      const rs = _editState.rotateState;
      switch (btn.dataset.rot) {
        case 'cw':    rs.deg = (rs.deg + 90) % 360; break;
        case 'ccw':   rs.deg = (rs.deg + 270) % 360; break;
        case 'fh':    rs.flipH = !rs.flipH; break;
        case 'fv':    rs.flipV = !rs.flipV; break;
        case 'angle':
          /* R63 — tap-on-icon when angle !== 0 resets to 0. When already
             at 0, give the user a small visual nudge instead of silent
             no-op: briefly pulse the selected ring via a one-off class. */
          if (rs.angle !== 0) {
            rs.angle = 0;
            const sl = document.getElementById('editAngleSlider');
            const dot = document.getElementById('editAngleTickDot');
            if (sl) sl.value = 0;
            if (dot) dot.style.left = '50%';
          } else {
            btn.classList.remove('pulse');
            void btn.offsetWidth;  /* restart animation */
            btn.classList.add('pulse');
            setTimeout(() => btn.classList.remove('pulse'), 360);
          }
          break;
      }
      _updateRot();
      _r53SyncAngleUI();
    });
  });
  const slider = document.getElementById('editAngleSlider');
  const tickDot = document.getElementById('editAngleTickDot');
  function _r53UpdatePill(v){
    const lbl = document.getElementById('adjSectionPillLabel');
    const val = document.getElementById('adjSectionPillVal');
    if (lbl) lbl.textContent = 'ANGLE';
    if (val) val.textContent = (v === 0) ? '' : (v > 0 ? '+' + v + '°' : v + '°');
  }
  function _r53SyncAngleUI(){
    const v = _editState.rotateState.angle;
    if (slider) slider.value = String(v);
    if (tickDot) tickDot.style.left = (((v + 180) / 360) * 100).toFixed(2) + '%';
    /* Update the angle icon's modified/value display. */
    const angBtn = document.querySelector('#editBody .edit-rotate-btn[data-rot="angle"]');
    if (angBtn) {
      angBtn.classList.toggle('modified', v !== 0);
      const valEl = angBtn.querySelector('.adj-circle-val');
      if (valEl) valEl.textContent = (v === 0) ? '' : (v > 0 ? '+' + v : String(v));
      const dot = angBtn.querySelector('.adj-icon-dot');
      if (dot) {
        const mag = Math.min(180, Math.abs(v));
        const deg = (mag / 180) * 180;
        if (v >= 0) dot.style.setProperty('--r48-arc-from', '-90deg');
        else dot.style.setProperty('--r48-arc-from', (-90 - deg) + 'deg');
        dot.style.setProperty('--r48-arc-deg', deg + 'deg');
      }
    }
    _r53UpdatePill(v);
  }
  if (slider) {
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value, 10);
      _editState.rotateState.angle = v;
      _updateRot();
      _r53SyncAngleUI();
    });
    slider.addEventListener('change', () => { _editPushUndo(); });
  }
  /* Disable toggle for Rotate. */
  const _rotDisable = document.getElementById('editRotateDisable');
  if (_rotDisable) {
    _rotDisable.addEventListener('click', () => {
      const rs = _editState.rotateState;
      rs.enabled = (rs.enabled === false);  /* flip — default true means click sets false */
      _rotDisable.classList.toggle('tab-disabled', rs.enabled === false);
      _rotDisable.setAttribute('aria-pressed', rs.enabled === false ? 'true' : 'false');
      _rotDisable.title = rs.enabled === false ? 'Enable rotate' : 'Disable rotate';
      const row = document.getElementById('editRotateRow');
      if (row) row.classList.toggle('row-disabled', rs.enabled === false);
      _updateRot();
    });
  }
  _r53SyncAngleUI();
}
async function _applyRotation(file, rotation){
  const bmp = await createImageBitmap(file);
  const w = bmp.width, h = bmp.height;
  const deg = rotation.deg || 0;
  const rad = deg * Math.PI / 180;
  const sinA = Math.abs(Math.sin(rad));
  const cosA = Math.abs(Math.cos(rad));
  const newW = Math.round(w * cosA + h * sinA);
  const newH = Math.round(w * sinA + h * cosA);
  const canvas = document.createElement('canvas');
  canvas.width = newW;
  canvas.height = newH;
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.scale(rotation.flipH ? -1 : 1, rotation.flipV ? -1 : 1);
  ctx.drawImage(bmp, -w / 2, -h / 2);
  ctx.restore();
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('rotation encode failed')), mime, 0.95);
  });
}
/* ---- FRAMES TAB (GIF frame editor) ---- */
async function _renderFramesTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  body.innerHTML = '<p style="color:rgba(255,255,255,.6);">Decoding frames\u2026</p>';
  if (typeof ImageDecoder !== 'function') {
    body.innerHTML = '<p style="color:rgba(255,200,120,.85);">Your browser doesn\u2019t support the ImageDecoder API. Frame editing requires a recent Chrome/Edge/Firefox.</p>';
    return;
  }
  /* Show original GIF as preview in left col */
  const framesPreviewCol = _editPreviewEl();
  if (framesPreviewCol) {
    framesPreviewCol.innerHTML = `<img class="edit-frames-preview-img" src="${f.url}" alt="GIF" draggable="false">`;
  }
  if (!_editState.framesState) {
    try {
      _editState.framesState = await _decodeGifFramesForEdit(f.file);
    } catch (err) {
      body.innerHTML = `<p style="color:rgba(255,120,120,.85);">Couldn\u2019t decode frames: ${err.message || err}</p>`;
      return;
    }
  }
  const fs = _editState.framesState;
  /* Initialize optimize state if missing (first time opening this tab
     for this file). Defaults match gifenc's defaults so toggling on
     the optimize panel without changing anything is a no-op. */
  if (!fs.opt) fs.opt = { paletteSize: 256, colorFormat: 'rgb565', dedupe: false };
  body.innerHTML = `
    <div class="edit-frames-actions">
      <button type="button" class="edit-frames-action-btn" data-act="reverse"><svg class="ico" aria-hidden="true"><use href="#i-rotate-cw"/></svg>Reverse all frames</button>
      <button type="button" class="edit-frames-action-btn" data-act="resetDelays">Reset delays to original</button>
    </div>
    <div class="edit-frames-strip" id="editFramesStrip"></div>
    <div class="edit-frames-controls">
      <label>Set all frames to
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="number" id="editFramesUniformMs" min="20" max="65535" value="${Math.round(1000/fs.fps)}" style="flex:1;">
          <span style="font-size:.7rem;color:rgba(255,255,255,.5);">ms</span>
          <button type="button" class="edit-frames-action-btn" id="editFramesUniformApply" style="padding:4px 10px;">Apply</button>
        </div>
      </label>
      <label>Loop count <span style="color:rgba(255,255,255,.45);font-weight:400;">(0 = forever)</span>
        <input type="number" id="editFramesLoop" min="0" max="999" value="${fs.loop}">
      </label>
      <label>Trim start (frame)
        <input type="range" id="editFramesTrimStart" min="0" max="${fs.frames.length - 1}" value="${fs.trimStart}">
        <span id="editFramesTrimStartVal" style="font-size:.78rem;color:rgba(255,255,255,.7);">${fs.trimStart}</span>
      </label>
      <label>Trim end (frame)
        <input type="range" id="editFramesTrimEnd" min="0" max="${fs.frames.length - 1}" value="${fs.trimEnd}">
        <span id="editFramesTrimEndVal" style="font-size:.78rem;color:rgba(255,255,255,.7);">${fs.trimEnd}</span>
      </label>
    </div>
    <p style="margin-top:14px;font-size:.78rem;color:rgba(255,255,255,.55);">Drag frames to reorder. Hover a frame for delete (\u00d7) and duplicate (\u2756) buttons. The remaining frames are encoded into a new GIF on Save.</p>
    <div class="edit-frames-optimize">
      <h4>Optimize \u2014 reduce file size on Save</h4>
      <div class="opt-row">
        <span>Palette size</span>
        <input type="range" id="editFramesPalette" min="16" max="256" step="8" value="${fs.opt.paletteSize}">
        <span class="opt-val" id="editFramesPaletteVal">${fs.opt.paletteSize}</span>
      </div>
      <div class="opt-row">
        <span>Color precision</span>
        <select id="editFramesColorFormat">
          <option value="rgb565" ${fs.opt.colorFormat==='rgb565'?'selected':''}>RGB 5-6-5 (best balance)</option>
          <option value="rgb444" ${fs.opt.colorFormat==='rgb444'?'selected':''}>RGB 4-4-4 (smaller)</option>
          <option value="rgba4444" ${fs.opt.colorFormat==='rgba4444'?'selected':''}>RGBA 4-4-4-4 (alpha)</option>
        </select>
        <span></span>
      </div>
      <div class="opt-row">
        <span>Dedupe duplicates</span>
        <label style="display:flex;align-items:center;gap:6px;">
          <input type="checkbox" id="editFramesDedupe" ${fs.opt.dedupe?'checked':''}>
          <span style="font-size:.72rem;color:rgba(255,255,255,.55);">Merge near-identical adjacent frames</span>
        </label>
        <span></span>
      </div>
    </div>
  `;
  const strip = body.querySelector('#editFramesStrip');
  function _renderStrip(){
    strip.innerHTML = '';
    fs.frames.forEach((frame, i) => {
      const div = document.createElement('div');
      div.className = 'edit-frame-thumb' + (frame.deleted ? ' deleted' : ' kept');
      div.dataset.fi = String(i);
      div.draggable = true;
      const wrap = document.createElement('div');
      wrap.className = 'frame-canvas-wrap';
      const c = document.createElement('canvas');
      c.width = 80; c.height = 80;
      const cx = c.getContext('2d');
      const rb = Math.min(80 / frame.bitmap.width, 80 / frame.bitmap.height);
      const dw = frame.bitmap.width * rb, dh = frame.bitmap.height * rb;
      cx.drawImage(frame.bitmap, (80 - dw) / 2, (80 - dh) / 2, dw, dh);
      wrap.appendChild(c);
      const num = document.createElement('span');
      num.className = 'frame-num';
      num.textContent = String(i + 1);
      wrap.appendChild(num);
      const del = document.createElement('button');
      del.className = 'frame-del';
      del.textContent = '\u00d7';
      del.title = 'Delete frame';
      del.addEventListener('click', e => {
        e.stopPropagation();
        _editPushUndo();
        frame.deleted = !frame.deleted;
        div.classList.toggle('deleted', frame.deleted);
        div.classList.toggle('kept', !frame.deleted);
        _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
      });
      wrap.appendChild(del);
      const dup = document.createElement('button');
      dup.className = 'frame-dup';
      dup.textContent = '\u2756';
      dup.title = 'Duplicate frame';
      dup.addEventListener('click', e => {
        e.stopPropagation();
        _editPushUndo();
        /* Clone the frame — shares the bitmap reference (no need to
           re-decode), copies delay + deleted flag. Insert immediately
           after the source, matching ezgif's per-frame Copy behavior. */
        const clone = { bitmap: frame.bitmap, delay: frame.delay, deleted: false, originalIdx: frame.originalIdx };
        fs.frames.splice(i + 1, 0, clone);
        _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
        _renderStrip();
      });
      wrap.appendChild(dup);
      div.appendChild(wrap);
      /* Per-frame delay input — ms (gifenc native unit). Show a hint
         in centiseconds for ezgif veterans via tooltip. */
      const delay = document.createElement('input');
      delay.type = 'number';
      delay.className = 'frame-delay-input';
      delay.min = '20'; delay.max = '65535'; delay.step = '10';
      delay.value = String(Math.max(20, Math.round(frame.delay)));
      delay.title = `Delay in milliseconds (\u2248 ${Math.round(frame.delay/10)}/100 s)`;
      delay.addEventListener('input', e => {
        const v = parseInt(e.target.value, 10);
        if (isFinite(v) && v >= 20) {
          frame.delay = v;
          _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
        }
      });
      div.appendChild(delay);
      /* Drag-reorder events — HTML5 DnD. Mobile fallback: long-press
         not shipped this round (deferred to round 2 of frames work
         since touch already lets users tap delete/dup/delay). */
      div.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
        div.classList.add('dragging');
      });
      div.addEventListener('dragend', () => {
        strip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
        div.classList.remove('dragging');
      });
      div.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = div.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const before = e.clientX < mid;
        strip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
        div.classList.add(before ? 'drop-before' : 'drop-after');
      });
      div.addEventListener('drop', e => {
        e.preventDefault();
        _editPushUndo();
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const toRect = div.getBoundingClientRect();
        const before = e.clientX < (toRect.left + toRect.width / 2);
        let toIdx = parseInt(div.dataset.fi, 10);
        if (!before) toIdx++;
        /* Splice: remove from source, re-insert at target (account for
           index shift if source < target). */
        if (fromIdx === toIdx || fromIdx === toIdx - 1) {
          strip.querySelectorAll('.drop-before, .drop-after').forEach(el => el.classList.remove('drop-before','drop-after'));
          return;
        }
        const [moved] = fs.frames.splice(fromIdx, 1);
        const realTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
        fs.frames.splice(realTo, 0, moved);
        _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
        _renderStrip();
      });
      strip.appendChild(div);
    });
  }
  _renderStrip();
  /* Action buttons: Reverse all / Reset delays. */
  body.querySelectorAll('.edit-frames-action-btn[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      _editPushUndo();
      const act = btn.dataset.act;
      if (act === 'reverse') {
        /* Reverse the frames array — preserves per-frame delay + deleted
           per ezgif's contract. */
        fs.frames = fs.frames.slice().reverse();
        _renderStrip();
      } else if (act === 'resetDelays') {
        fs.frames.forEach(fr => { fr.delay = fr.originalDelay || fr.delay; });
        _renderStrip();
      }
      _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
    });
  });
  /* Set-all-frames uniform delay applier. */
  const uniformBtn = body.querySelector('#editFramesUniformApply');
  const uniformInp = body.querySelector('#editFramesUniformMs');
  uniformBtn.addEventListener('click', () => {
    const ms = parseInt(uniformInp.value, 10);
    if (isFinite(ms) && ms >= 20) {
      _editPushUndo();
      fs.frames.forEach(fr => { fr.delay = ms; });
      fs.fps = Math.max(1, Math.min(60, Math.round(1000 / ms)));
      _renderStrip();
      _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
    }
  });
  /* Loop + trim handlers unchanged from prior shipment. */
  body.querySelector('#editFramesLoop').addEventListener('input', e => {
    fs.loop = Math.max(0, parseInt(e.target.value, 10) || 0);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  const tsEl = body.querySelector('#editFramesTrimStart');
  const teEl = body.querySelector('#editFramesTrimEnd');
  tsEl.addEventListener('input', e => {
    fs.trimStart = Math.min(parseInt(e.target.value, 10), fs.trimEnd);
    tsEl.value = String(fs.trimStart);
    body.querySelector('#editFramesTrimStartVal').textContent = String(fs.trimStart);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  teEl.addEventListener('input', e => {
    fs.trimEnd = Math.max(parseInt(e.target.value, 10), fs.trimStart);
    teEl.value = String(fs.trimEnd);
    body.querySelector('#editFramesTrimEndVal').textContent = String(fs.trimEnd);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  /* Optimize panel handlers. */
  const paletteEl = body.querySelector('#editFramesPalette');
  const paletteValEl = body.querySelector('#editFramesPaletteVal');
  paletteEl.addEventListener('input', e => {
    fs.opt.paletteSize = parseInt(e.target.value, 10) || 256;
    paletteValEl.textContent = String(fs.opt.paletteSize);
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  body.querySelector('#editFramesColorFormat').addEventListener('change', e => {
    fs.opt.colorFormat = e.target.value || 'rgb565';
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  body.querySelector('#editFramesDedupe').addEventListener('change', e => {
    fs.opt.dedupe = !!e.target.checked;
    _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
  });
  _editState.pendingEdits.gifEdit = _gifEditPayload(fs);
}
function _gifEditPayload(fs){
  /* keepIndices reflects the CURRENT order of fs.frames (post-reorder /
     duplicate). Trim is applied as a positional window over the
     reordered array. Per-frame delays live on fs.frames[i].delay; the
     legacy `delay` field is kept as a fallback for older code paths. */
  const len = fs.frames.length;
  const trimStart = Math.max(0, Math.min(fs.trimStart, len - 1));
  const trimEnd = Math.max(trimStart, Math.min(fs.trimEnd, len - 1));
  const keepIndices = [];
  for (let i = trimStart; i <= trimEnd; i++) {
    if (!fs.frames[i].deleted) keepIndices.push(i);
  }
  return {
    keepIndices,
    delays: keepIndices.map(i => Math.max(20, Math.round(fs.frames[i].delay || 100))),
    delay: Math.round(1000 / Math.max(1, fs.fps)),  /* legacy fallback */
    loop: fs.loop,
    width: fs.width, height: fs.height,
    opt: fs.opt || { paletteSize: 256, colorFormat: 'rgb565', dedupe: false },
  };
}
async function _decodeGifFramesForEdit(file){
  const buf = await file.arrayBuffer();
  const dec = new ImageDecoder({ data: buf, type: 'image/gif' });
  await dec.tracks.ready;
  await dec.completed;
  const track = dec.tracks.selectedTrack;
  const count = track.frameCount;
  if (!count || count < 1) throw new Error('No frames in GIF');
  const frames = [];
  let delaySum = 0, delayN = 0;
  for (let i = 0; i < count; i++) {
    const r = await dec.decode({ frameIndex: i });
    const w = r.image.displayWidth, h = r.image.displayHeight;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(r.image, 0, 0);
    const bmp = await createImageBitmap(c);
    const dur = (r.image.duration || 0) / 1000;
    if (dur > 0) { delaySum += dur; delayN++; }
    frames.push({ bitmap: bmp, delay: dur || 100, originalDelay: dur || 100, deleted: false, originalIdx: i });
    try { r.image.close && r.image.close(); } catch(_){}
  }
  try { dec.close && dec.close(); } catch(_){}
  const avgDelay = delayN > 0 ? delaySum / delayN : 100;
  const fps = Math.max(1, Math.min(60, Math.round(1000 / Math.max(20, avgDelay))));
  return {
    frames, fps, loop: 0,
    trimStart: 0, trimEnd: count - 1,
    width: frames[0].bitmap.width, height: frames[0].bitmap.height,
  };
}
let _gifencInlineMod = null;
async function _ensureGifencInline(){
  if (_gifencInlineMod) return _gifencInlineMod;
  _gifencInlineMod = await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm');
  return _gifencInlineMod;
}
async function _applyGifEdit(file, edits){
  const gifenc = await _ensureGifencInline();
  const GIFEncoder = gifenc.GIFEncoder, quantize = gifenc.quantize, applyPalette = gifenc.applyPalette;
  if (!GIFEncoder || !quantize || !applyPalette) throw new Error('gifenc not available');
  const fs = _editState.framesState;
  if (!fs) throw new Error('frame state missing');
  const keep = edits.keepIndices;
  if (!keep || !keep.length) throw new Error('No frames left after edits');
  const w = edits.width, h = edits.height;
  const opt = edits.opt || { paletteSize: 256, colorFormat: 'rgb565', dedupe: false };
  const paletteSize = Math.max(16, Math.min(256, opt.paletteSize || 256));
  const colorFormat = opt.colorFormat || 'rgb565';
  /* Pre-rasterize every kept frame to {data, delay}. Optional dedupe
     pass collapses near-identical adjacent frames into one and sums
     their delays. Threshold: mean per-pixel absolute diff < 4 (subtle
     compression-level variations get merged; visible motion preserved). */
  const rastered = [];
  for (let k = 0; k < keep.length; k++) {
    const idx = keep[k];
    const fr = fs.frames[idx];
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(fr.bitmap, 0, 0, w, h);
    const data = cx.getImageData(0, 0, w, h).data;
    const delay = edits.delays && edits.delays[k] ? edits.delays[k] : Math.max(20, edits.delay);
    rastered.push({ data, delay });
  }
  /* Dedupe — merge adjacent frames whose mean per-pixel absolute diff
     in RGB is below threshold. Combined frame keeps the EARLIER pixel
     data + the SUM of their delays. Walks linearly; safe even after
     reorder. */
  let frames = rastered;
  if (opt.dedupe && rastered.length > 1) {
    const merged = [rastered[0]];
    const THRESHOLD = 4;  /* empirical: catches LZW noise, leaves real motion */
    for (let i = 1; i < rastered.length; i++) {
      const prev = merged[merged.length - 1];
      const cur = rastered[i];
      let sum = 0;
      const len = Math.min(prev.data.length, cur.data.length);
      for (let j = 0; j < len; j += 16) {
        sum += Math.abs(prev.data[j] - cur.data[j]);
        sum += Math.abs(prev.data[j+1] - cur.data[j+1]);
        sum += Math.abs(prev.data[j+2] - cur.data[j+2]);
      }
      const avg = sum / (len / 16 * 3);
      if (avg < THRESHOLD) {
        prev.delay = Math.min(65535, prev.delay + cur.delay);
      } else {
        merged.push(cur);
      }
    }
    frames = merged;
  }
  const enc = GIFEncoder();
  for (const fr of frames) {
    const palette = quantize(fr.data, paletteSize, { format: colorFormat });
    const indexed = applyPalette(fr.data, palette, colorFormat);
    enc.writeFrame(indexed, w, h, {
      palette, delay: Math.max(20, fr.delay),
      dispose: 2, transparent: false, repeat: edits.loop,
    });
  }
  enc.finish();
  return new Blob([enc.bytes()], { type: 'image/gif' });
}
/* ---- BACKGROUND REMOVAL TAB (scaffold; inference lands next batch) ---- */
/* ---- BACKGROUND REMOVAL TAB (Round 3 — BEN2-ONNX via transformers.js) ----
 * Licenses: transformers.js Apache-2.0 (https://github.com/huggingface/transformers.js/blob/main/LICENSE)
 *           onnx-community/BEN2-ONNX MIT (https://huggingface.co/onnx-community/BEN2-ONNX)
 * WebGPU first (dtype fp32 to avoid fp16 casting bug), WASM q8 fallback (~56 MB).
 * The pipeline singleton persists across modal open/close cycles so the model stays warm.
 */
/* Round 9: Multi-model singleton.
 * 'std' = BEN2-ONNX (Apache-2.0/MIT) — fast, default.
 * 'hq'  = BiRefNet_lite-ONNX (MIT code https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE,
 *         MIT weights https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) — finer edges, ~110 MB fp16 / ~214 MB fp32.
 * Each mode warms independently so toggling between them doesn't re-download.
 */

/* R142 — MEASURED: the BEN2 'std' path has never worked. Verified in a real
   browser against pinned library versions:
     transformers.js 3.1.0 -> "Unsupported pipeline: background-removal"
                              (the task did not exist yet)
     transformers.js 3.7.5 -> "Unsupported model type: ben"
                              (task exists; BEN2's model_type is not in the
                               library's model registry)
   onnx-community/BEN2-ONNX declares model_type "ben", which @huggingface/
   transformers has no implementation for, so pipeline('background-removal',
   'onnx-community/BEN2-ONNX') can only ever throw. This is why the tab is
   hidden (see _editTabsForType, R76/R86) — the note there was accurate.

   Until the engine is validated on real hardware, both modes resolve to
   BiRefNet_lite-ONNX (MIT, and actually supported via AutoModel) so there is
   no silently-broken default. The import is now version-pinned; the previous
   floating @3 meant the dependency could change under us without a deploy.

   STILL TO VALIDATE before this feature is exposed: cutout quality on real
   photos, peak memory (a WASM fp32 run attempted a ~140 MB allocation and
   failed in a constrained browser), and first-run download time. */



/* ---- ROUND 8: BACKGROUND REFINE BRUSHES (erase / restore over BEN2 alpha) ---- */
function _bgRingCursor(diameterPx){
  const d = Math.max(8, Math.min(220, Math.round(diameterPx)));
  const r = Math.max(2, d / 2 - 1);
  const cx = d / 2;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + d + '" height="' + d + '">'
    + '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="white" stroke-width="1.6" />'
    + '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="black" stroke-width="1" stroke-dasharray="3 3" />'
    + '</svg>';
  return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '") ' + cx + ' ' + cx + ', crosshair';
}


/* R30c — File-level helpers for tool dropdowns. Hoisted out of
   _renderAdjustTab so Rotate / Pixelate / Blur / BG-refine can use the
   same open/close/portal machinery without duplicating code. */
function _editPositionMenu(trig, menu){
  const r = trig.getBoundingClientRect();
  const menuW = menu.offsetWidth || 140;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
  menu.style.left = left + 'px';
  menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  menu.style.top = 'auto';
}
function _editPortalMenu(menu){
  if (menu.parentNode !== document.body) document.body.appendChild(menu);
}
function _editCloseAllToolDropdowns(){
  document.querySelectorAll('.edit-filter-dd.open, .edit-vignette-dd.open, .edit-adjust-dd.open, .edit-tool-dd.open')
    .forEach(dd => dd.classList.remove('open'));
  document.querySelectorAll('.edit-filter-dd-menu.open, .edit-vignette-dd-menu.open, .edit-adjust-dd-menu.open, .edit-tool-dd-menu.open')
    .forEach(m => m.classList.remove('open'));
  document.querySelectorAll('[id^="edit"][id$="Trigger"]')
    .forEach(t => { if (t.hasAttribute('aria-expanded')) t.setAttribute('aria-expanded', 'false'); });
}
const _editCloseAdjustDropdowns = _editCloseAllToolDropdowns;
function _editWireDropdown(ddId, trigId, menuId){
  const dd = document.getElementById(ddId);
  const trig = document.getElementById(trigId);
  const menu = document.getElementById(menuId);
  if (!dd || !trig || !menu) return;
  trig.addEventListener('click', e => {
    e.stopPropagation();
    const willOpen = !dd.classList.contains('open');
    _editCloseAllToolDropdowns();
    if (willOpen){
      dd.classList.add('open');
      menu.classList.add('open');
      trig.setAttribute('aria-expanded', 'true');
      _editPortalMenu(menu);
      _editPositionMenu(trig, menu);
    }
  });
  if (menu.querySelector('input,textarea')){
    menu.addEventListener('click', e => e.stopPropagation());
    menu.addEventListener('mousedown', e => e.stopPropagation());
  }
}
if (!window._editToolDropdownGlobalAttached){
  document.addEventListener('click', () => _editCloseAllToolDropdowns());
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _editCloseAllToolDropdowns(); });
  window.addEventListener('resize', () => _editCloseAllToolDropdowns());
  window._editToolDropdownGlobalAttached = true;
}

/* ---- ADJUST TAB (photo: brightness / contrast / saturation / filter presets) ---- */
function _renderAdjustTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.pendingEdits.photoAdjust) {
    /* R47 — sliderEnabled + filterEnabled let users tap-to-disable each
       section while preserving the slider/preset values. iPhone Photos pattern. */
    /* R48 — `selected` tracks which adjustment the shared scrubber
       controls. iPhone Photos pattern: one slider, many icons. */
    _editState.pendingEdits.photoAdjust = { brightness: 100, contrast: 100, saturation: 100, globalBlur: 0, preset: 'none', presetCss: '', _dirty: false, sliderEnabled: true, filterEnabled: true, selected: 'brightness' };
  }
  const adj = _editState.pendingEdits.photoAdjust;
  /* R47 — back-fill flags for state restored from older sessions/undo snapshots. */
  if (adj.sliderEnabled === undefined) adj.sliderEnabled = true;
  if (adj.filterEnabled === undefined) adj.filterEnabled = true;
  if (adj.selected === undefined) adj.selected = 'brightness';  /* R48 */
  if (adj.globalBlur === undefined) adj.globalBlur = 0;          /* R59 */
  if (!_editState.pendingEdits.vignette) {
    _editState.pendingEdits.vignette = { amount: 0, midpoint: 50, _dirty: false, enabled: true };
  }
  if (_editState.pendingEdits.vignette.enabled === undefined) _editState.pendingEdits.vignette.enabled = true;
  const vig = _editState.pendingEdits.vignette;
  const PRESETS = [
    { id: 'none',    label: 'Original', css: '' },
    { id: 'bw',      label: 'B&W',      css: 'grayscale(100%)' },
    { id: 'sepia',   label: 'Sepia',    css: 'sepia(100%)' },
    { id: 'vintage', label: 'Vintage',  css: 'sepia(40%) contrast(110%) brightness(90%) saturate(130%)' },
    { id: 'invert',  label: 'Invert',   css: 'invert(100%)' },
    { id: 'cool',    label: 'Cool',     css: 'hue-rotate(200deg) saturate(140%) brightness(105%)' },
    { id: 'warm',    label: 'Warm',     css: 'sepia(30%) saturate(180%) brightness(105%)' },
  ];
  const fmt = v => { const d = v - 100; return d > 0 ? ('+' + d) : ('' + d); };
  const adjPreviewCol = _editPreviewEl();
  if (adjPreviewCol) {
    const _adjSrcUrl = _editState.pendingEdits.autoEnhancedUrl || _editState.originalUrl || f.url;
    adjPreviewCol.innerHTML = `<div class="edit-adjust-preview-wrap"><div class="edit-adjust-img-frame"><img id="editAdjPreview" src="${_adjSrcUrl}" class="edit-adjust-preview" draggable="false" alt=""><div class="edit-vignette-overlay" id="editAdjVignette"></div></div></div>`;
  }
  const _aeOn = !!_editState.pendingEdits.autoEnhanced;
  /* R30 — Adjust tab now mirrors home toolbar density:
     - Auto enhance pill (unchanged)
     - 3 sliders inline (unchanged — sliders need live exploration)
     - FILTER as dropdown chip (was: 7-pill horizontal-scroll strip)
     - VIGNETTE as dropdown chip (was: always-visible amount + midpoint).
     Both dropdowns mirror home .resize-presets-trigger pattern. */
  const _currentPresetLabel = (PRESETS.find(p => p.id === adj.preset) || PRESETS[0]).label;
  const _vigSummary = vig.amount === 0 ? 'Off' : (vig.amount > 0 ? '+' + vig.amount : String(vig.amount));
  /* R30b — Adjust trigger summary. Mirrors iOS Photos' modified indicator:
     "Default" when untouched, "Modified" + accent dot when any slider has
     been moved off 100. */
  const _adjModified = !(adj.brightness === 100 && adj.contrast === 100 && adj.saturation === 100);
  const _adjSummary = _adjModified ? 'Modified' : 'Default';
  const _chev = '<svg class="chev" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 7 6 4 9 7"/></svg>';
  /* R46 — Adjust controls now flow inline in a single toolbar row,
     mirroring home .adjust-panel density. The 4 chips (auto-enhance,
     ADJUST▾, FILTER▾, VIGNETTE▾) used to stack into 4 vertical rows
     because each chip had width:100%. Wrapping them in
     .edit-tool-toolbar forces horizontal flex; per-chip CSS in R46
     drops the 100% width to content-width. */
    /* R49b — restore missing const declarations consumed by the flat
     carousel template. The first R49 transform's OLD_BLOCK match
     silently failed (a whitespace mismatch I didn't catch), so the
     consts never made it into the file. _renderAdjustTab threw
     ReferenceError on render, leaving the Adjust tab blank. */
  const _fmtV = (val, def) => { const d = val - def; return d > 0 ? ('+' + d) : ('' + d); };
  const _adjVignetteVal = (vig.amount === 0) ? '' : (vig.amount > 0 ? '+' + vig.amount : String(vig.amount));
  const _FILTER_SWATCH = {
    none:    '#888',
    bw:      'linear-gradient(135deg, #fff 0%, #fff 50%, #1a1a1a 50%, #1a1a1a 100%)',
    sepia:   '#a87a5c',
    vintage: '#b8a47c',
    invert:  'radial-gradient(circle, #fff 30%, #111 70%)',
    cool:    '#6090d8',
    warm:    '#d89060',
  };
  /* R50 — Apple Photos pattern. Section-label pill floats over the
     photo; circular icons sit in a horizontal row; tick-mark ruler
     drives the currently-selected adjustment. Filters live in their
     own tab (see _renderFiltersTab). */
  const _scrubKey = adj.selected || 'brightness';
  const _scrubMin = (_scrubKey === 'vignette') ? -100 : 0;
  const _scrubMax = (_scrubKey === 'vignette') ?  100 : 200;
  const _scrubDef = (_scrubKey === 'vignette') ?    0 : 100;
  const _scrubVal = (_scrubKey === 'vignette') ? (vig.amount || 0) : adj[_scrubKey];
  const _scrubDelta = _scrubVal - _scrubDef;
  const _scrubLabel = ({brightness:'BRIGHTNESS',contrast:'CONTRAST',saturation:'SATURATION',vignette:'VIGNETTE'})[_scrubKey];
  const _scrubPct = ((_scrubVal - _scrubMin) / (_scrubMax - _scrubMin)) * 100;
  const _scrubValDisplay = (_scrubKey === 'vignette')
    ? (_scrubVal === 0 ? '0' : (_scrubVal > 0 ? '+' + _scrubVal : String(_scrubVal)))
    : fmt(_scrubVal);
  body.innerHTML = `
    <div class="edit-tool-toolbar edit-adjust-toolbar adj-tab-r50">
      <div class="adj-flat-carousel adj-carousel-r50" role="tablist" aria-label="Adjustments">
        <button type="button" class="adj-flat-btn adj-circle-btn adj-auto-btn${_aeOn?' active':''}" data-adj-action="auto" title="Auto enhance" aria-label="Auto enhance" aria-pressed="${_aeOn}">
          <span class="adj-circle-ring" aria-hidden="true"></span>
          <span class="adj-circle-inner"><svg class="ico" aria-hidden="true"><use href="#${_aeOn?'i-check':'i-wand-sparkles'}"/></svg></span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='brightness'?' selected':''}${adj.brightness!==100?' modified':''}" data-adj-key="brightness" title="Brightness (double-click to reset)" aria-label="Brightness" role="tab" aria-selected="${_scrubKey==='brightness'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-sun"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="brightness">${adj.brightness !== 100 ? _fmtV(adj.brightness, 100) : ''}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='contrast'?' selected':''}${adj.contrast!==100?' modified':''}" data-adj-key="contrast" title="Contrast (double-click to reset)" aria-label="Contrast" role="tab" aria-selected="${_scrubKey==='contrast'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-contrast"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="contrast">${adj.contrast !== 100 ? _fmtV(adj.contrast, 100) : ''}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='saturation'?' selected':''}${adj.saturation!==100?' modified':''}" data-adj-key="saturation" title="Saturation (double-click to reset)" aria-label="Saturation" role="tab" aria-selected="${_scrubKey==='saturation'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-droplets"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="saturation">${adj.saturation !== 100 ? _fmtV(adj.saturation, 100) : ''}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='vignette'?' selected':''}${vig.amount!==0?' modified':''}" data-adj-key="vignette" title="Vignette (double-click to reset)" aria-label="Vignette" role="tab" aria-selected="${_scrubKey==='vignette'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-aperture"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="vignette">${_adjVignetteVal}</span>
          </span>
        </button>
        <button type="button" class="adj-flat-btn adj-circle-btn adj-icon-btn${_scrubKey==='globalBlur'?' selected':''}${adj.globalBlur!==0?' modified':''}" data-adj-key="globalBlur" title="Blur (whole image)" aria-label="Blur" role="tab" aria-selected="${_scrubKey==='globalBlur'}">
          <span class="adj-circle-ring adj-icon-dot" aria-hidden="true"></span>
          <span class="adj-circle-inner">
            <svg class="ico" aria-hidden="true"><use href="#i-droplets"/></svg>
            <span class="adj-circle-val adj-icon-val" data-key="globalBlur">${adj.globalBlur ? '+' + adj.globalBlur : ''}</span>
          </span>
        </button>
      </div>
      <div class="adj-tick-ruler" id="adjScrubberWrap" data-scrub-key="${_scrubKey}" style="--range:${(_scrubMax - _scrubMin)};">
        <div class="adj-tick-ticks" aria-hidden="true"></div>
        <div class="adj-tick-center" aria-hidden="true"></div>
        <div class="adj-tick-dot" id="adjTickDot" style="left:${_scrubPct.toFixed(2)}%;" aria-hidden="true"></div>
        <input type="range" id="adjScrubSlider" class="adj-tick-input" min="${_scrubMin}" max="${_scrubMax}" step="1" value="${_scrubVal}" aria-label="Adjustment value">
      </div>
    </div>
  `;
  /* R65 — populate ticks for the Adjust scrubber. */
  try { _buildRulerTicks(document.getElementById('adjScrubberWrap')); } catch(_){}
  /* R71b — ensure section pill is created on initial render. The pill
     is created lazily by _syncScrubberToSelected; queue a microtask call
     after the scrubber wiring finishes so the pill exists on first paint.
     Plus directly call _ensureAdjSectionPill upfront so the pill renders
     even if scrubber wiring is short-circuited. */
  try {
    const _initKey = (adj.selected || 'brightness');
    const _initLabel = ({brightness:'Brightness',contrast:'Contrast',saturation:'Saturation',vignette:'Vignette',globalBlur:'Blur'})[_initKey] || _initKey;
    let _initVal = '';
    if (_initKey === 'vignette') {
      const v = vig.amount || 0;
      _initVal = v === 0 ? '' : (v > 0 ? '+' + v : String(v));
    } else if (_initKey === 'globalBlur') {
      _initVal = (adj.globalBlur && adj.globalBlur > 0) ? '+' + adj.globalBlur : '';
    } else {
      const d = adj[_initKey] - 100;
      _initVal = d === 0 ? '' : (d > 0 ? '+' + d : String(d));
    }
    _ensureAdjSectionPill(_initLabel, _initVal);
  } catch(_){}
  const previewImg = document.getElementById('editAdjPreview');
  function _getAdjFilter(){
    const a = _editState.pendingEdits.photoAdjust;
    /* R54 — per-key enabled flags (brightnessEnabled, contrastEnabled,
       saturationEnabled). Disabled keys are skipped from the filter
       composition so their value is visually nullified while preserved
       in state. */
    const filterOn = a.filterEnabled !== false;
    const sliderOn = a.sliderEnabled !== false;
    const pre = (filterOn && a.preset !== 'none' && a.presetCss) ? a.presetCss + ' ' : '';
    let sliders = '';
    if (sliderOn) {
      if (a.brightnessEnabled !== false) sliders += `brightness(${a.brightness}%) `;
      if (a.contrastEnabled   !== false) sliders += `contrast(${a.contrast}%) `;
      if (a.saturationEnabled !== false) sliders += `saturate(${a.saturation}%) `;
      /* R59 — global Blur as part of the CSS filter chain. */
      if (a.globalBlurEnabled !== false && a.globalBlur > 0) sliders += `blur(${a.globalBlur}px) `;
    }
    return (pre + sliders.trim()) || 'none';
  }
  function _markDirty(){
    const a = _editState.pendingEdits.photoAdjust;
    a._dirty = !(a.brightness === 100 && a.contrast === 100 && a.saturation === 100 && a.preset === 'none' && !(a.globalBlur > 0));
    previewImg.style.filter = _getAdjFilter();
    /* R48 — old ADJUST chip is gone; just sync the icon row's modified
       state. Filter chip + Vignette chip still have their own modified
       dot wiring from R47 (no change needed). */
    if (typeof _syncIconStates === 'function') _syncIconStates();
  }
  _markDirty();
  /* R48 — single scrubber routes input to the currently-selected
     adjustment. Icon clicks switch which key the scrubber controls. */
  /* R50 — scrubber drives tick ruler + floating section pill. */
  const _adjLabels = { brightness: 'BRIGHTNESS', contrast: 'CONTRAST', saturation: 'SATURATION', vignette: 'VIGNETTE', globalBlur: 'BLUR' };
  const scrubSlider = document.getElementById('adjScrubSlider');
  const scrubRuler  = document.getElementById('adjScrubberWrap');
  const scrubDot    = document.getElementById('adjTickDot');
  const pillLabel   = document.getElementById('adjSectionPillLabel');
  const pillVal     = document.getElementById('adjSectionPillVal');
  function _scrubRange(key){
    if (key === 'vignette')   return { min: -100, max: 100, def: 0 };
    if (key === 'globalBlur') return { min: 0,    max: 40,  def: 0 };
    return { min: 0, max: 200, def: 100 };
  }
  function _scrubValueFor(key){
    if (key === 'vignette') return _editState.pendingEdits.vignette.amount || 0;
    if (key === 'globalBlur') return _editState.pendingEdits.photoAdjust.globalBlur || 0;
    return _editState.pendingEdits.photoAdjust[key];
  }
  function _scrubDisplay(key, v){
    if (key === 'vignette') return v === 0 ? '0' : (v > 0 ? '+' + v : String(v));
    return fmt(v);
  }
  function _syncTickPos(){
    if (!scrubSlider || !scrubDot) return;
    const k = (_editState.pendingEdits.photoAdjust.selected || 'brightness');
    const r = _scrubRange(k);
    const v = _scrubValueFor(k);
    const pct = ((v - r.min) / (r.max - r.min)) * 100;
    scrubDot.style.left = pct.toFixed(2) + '%';
  }
  function _syncScrubberToSelected(){
    const a = _editState.pendingEdits.photoAdjust;
    const key = a.selected || 'brightness';
    const r = _scrubRange(key);
    const v = _scrubValueFor(key);
    if (scrubSlider) {
      scrubSlider.min = String(r.min);
      scrubSlider.max = String(r.max);
      scrubSlider.value = String(v);
    }
    if (scrubRuler) {
      scrubRuler.dataset.scrubKey = key;
      scrubRuler.style.setProperty('--range', String(r.max - r.min));
      try { _buildRulerTicks(scrubRuler); } catch(_){}
    }
    /* R51 — the pill now lives in editPreviewCol; resolve refs lazily so
       re-rendering the tab picks them up. */
    const _pillEl = document.getElementById('adjSectionPill') || _ensureAdjSectionPill(_adjLabels[key] || key.toUpperCase(), '');
    const _lbl = document.getElementById('adjSectionPillLabel');
    const _val = document.getElementById('adjSectionPillVal');
    if (_lbl) _lbl.textContent = _adjLabels[key] || key.toUpperCase();
    if (_val) _val.textContent = (v === r.def) ? '' : _scrubDisplay(key, v);
    if (_pillEl) _pillEl.hidden = false;
    _syncTickPos();
  }
  function _syncIconStates(){
    const a = _editState.pendingEdits.photoAdjust;
    const v = _editState.pendingEdits.vignette;
    document.querySelectorAll('#editBody .adj-icon-btn').forEach(btn => {
      const k = btn.dataset.adjKey;
      let val, defVal, mag, delta, disabled;
      if (k === 'vignette') {
        val = v.amount; defVal = 0; delta = val; mag = Math.min(100, Math.abs(val));
        disabled = (v.enabled === false);
      } else if (k === 'globalBlur') {
        val = a.globalBlur || 0; defVal = 0; delta = val; mag = Math.min(40, val) / 40 * 100;
        disabled = (a.globalBlurEnabled === false);
      } else {
        val = a[k]; defVal = 100; delta = val - defVal; mag = Math.min(100, Math.abs(delta));
        disabled = (a[k + 'Enabled'] === false);
      }
      btn.classList.toggle('selected', a.selected === k);
      btn.classList.toggle('modified', val !== defVal);
      btn.classList.toggle('icon-disabled', disabled);
      btn.setAttribute('aria-selected', a.selected === k ? 'true' : 'false');
      const valEl = btn.querySelector('.adj-icon-val');
      if (valEl) {
        valEl.textContent = (val !== defVal) ? (delta > 0 ? '+'+delta : String(delta)) : '';
      }
      const dot = btn.querySelector('.adj-icon-dot');
      if (dot) {
        const deg = (mag / 100) * 180;
        if (delta >= 0) dot.style.setProperty('--r48-arc-from', '-90deg');
        else dot.style.setProperty('--r48-arc-from', (-90 - deg) + 'deg');
        dot.style.setProperty('--r48-arc-deg', deg + 'deg');
      }
    });
  }
  /* R57 — iOS-style center detent.
     When the value crosses the default, brief resistance + haptic feedback
     before continuing. State held on the slider element so we don't leak
     between renders. */
  function _applyDetent(slider, newV, prevV, defV){
    /* Only act if we just crossed the default in either direction. */
    const crossed = (prevV < defV && newV > defV) || (prevV > defV && newV < defV) || (prevV !== defV && newV === defV);
    if (!crossed) return newV;
    /* Snap to default and require the user to drag the slider in this
       direction once more to leave. We mark a "sticky" state on the
       element; the next input that goes past default by >= 2 units is
       allowed through, otherwise we clamp back to default. */
    if (newV === defV) {
      slider._detentSticky = true;
      try { if (navigator.vibrate) navigator.vibrate(8); } catch(_){}
      return defV;
    }
    /* Crossed past default in one event — snap to default for this tick. */
    slider._detentSticky = true;
    slider._detentDir = newV > defV ? 1 : -1;
    slider._detentMomentum = 0;
    try { if (navigator.vibrate) navigator.vibrate(8); } catch(_){}
    return defV;
  }
  function _checkDetentRelease(slider, newV, defV){
    /* If sticky and user is dragging away again, count momentum until 2 units */
    if (!slider._detentSticky) return newV;
    if (newV === defV) { slider._detentMomentum = 0; return defV; }
    const dir = newV > defV ? 1 : -1;
    /* If user reversed past default, allow through immediately. */
    if (slider._detentDir && dir !== slider._detentDir && Math.abs(newV - defV) >= 1) {
      slider._detentSticky = false;
      return newV;
    }
    slider._detentMomentum = (slider._detentMomentum || 0) + 1;
    if (slider._detentMomentum >= 2) {
      slider._detentSticky = false;
      return newV;
    }
    return defV;
  }
  if (scrubSlider) {
    scrubSlider.addEventListener('input', () => {
      /* R74 — dropped during-drag detent. User feedback was that it
         felt sluggish (had to drag past zero an extra tick to release).
         Visual gold center mark already gives the "where zero is" cue
         and the on-release snap below handles the final detent. */
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const key = a.selected || 'brightness';
      const r = _scrubRange(key);
      let v = parseInt(scrubSlider.value, 10);
      if (key === 'vignette') {
        v_.amount = v;
        _vigMarkDirty();
      } else if (key === 'globalBlur') {
        a.globalBlur = v;
        a._dirty = a._dirty || v !== 0;
      } else {
        a[key] = v;
      }
      const _val = document.getElementById('adjSectionPillVal');
      if (_val) _val.textContent = (v === r.def) ? '' : _scrubDisplay(key, v);
      _syncTickPos();
      _syncIconStates();
      _markDirty();
    });
    /* R50 — soft snap-to-default on release. */
    scrubSlider.addEventListener('change', () => {
      /* R57 — reset detent on release so next drag starts fresh. */
      scrubSlider._detentSticky = false;
      scrubSlider._detentMomentum = 0;
      scrubSlider._detentDir = 0;
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const key = a.selected || 'brightness';
      const r = _scrubRange(key);
      const cur = _scrubValueFor(key);
      /* R74 — moderate release snap: ±2 around default snaps on lift.
         Lets users land deliberately at ±1, ±2 with a confident grip
         (release while clearly off-center); but a sloppy lift near 0
         confirms 0. Tested feel: "responsive snap" the user asked for. */
      if (Math.abs(cur - r.def) <= 2 && cur !== r.def) {
        if (key === 'vignette') { v_.amount = r.def; _vigMarkDirty(); }
        else { a[key] = r.def; }
        scrubSlider.value = String(r.def);
        const _val = document.getElementById('adjSectionPillVal');
        if (_val) _val.textContent = '';
        _syncTickPos();
        _syncIconStates();
        _markDirty();
      }
      _editPushUndo();
    });
  }
  document.querySelectorAll('#editBody .adj-icon-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const k = btn.dataset.adjKey;
      if (!k) return;
      if (a.selected === k) {
        /* R64 — toggle disable ONLY when the value is non-default.
           Default state already pre-selects 'brightness'; without this
           guard, the very first click on Brightness was treated as
           "selected → toggle" and set brightnessEnabled=false, leaving
           subsequent scrubber drags invisible because brightness was
           silently disabled. */
        const r = _scrubRange(k);
        const v = _scrubValueFor(k);
        if (v !== r.def) {
          if (k === 'vignette') {
            v_.enabled = (v_.enabled === false);
          } else {
            const flag = k + 'Enabled';
            a[flag] = (a[flag] === false);
          }
          _editPushUndo();
          _syncScrubberToSelected();
          _syncIconStates();
          _markDirty();
          return;
        }
        /* Selected + unmodified — give a pulse so the click isn't silent. */
        btn.classList.remove('pulse');
        void btn.offsetWidth;
        btn.classList.add('pulse');
        setTimeout(() => btn.classList.remove('pulse'), 360);
        return;
      }
      a.selected = k;
      _syncScrubberToSelected();
      _syncIconStates();
    });
    /* R48b — double-click resets that adjustment to default (100).
       Apple Photos has no per-section reset gesture on touch; this is
       the Lightroom Mobile convention adapted for desktop where
       double-click is free. */
    btn.addEventListener('dblclick', () => {
      const a = _editState.pendingEdits.photoAdjust;
      const v_ = _editState.pendingEdits.vignette;
      const k = btn.dataset.adjKey;
      if (!k) return;
      const r = _scrubRange(k);
      const cur = _scrubValueFor(k);
      if (cur === r.def) return;
      _editPushUndo();
      if (k === 'vignette') { v_.amount = r.def; _vigMarkDirty(); }
      else { a[k] = r.def; }
      if (a.selected === k && scrubSlider) {
        scrubSlider.value = String(r.def);
        const _val = document.getElementById('adjSectionPillVal');
        if (_val) _val.textContent = '';
        _syncTickPos();
      }
      _syncIconStates();
      _markDirty();
    });
  });
  /* R49 — old filter popover handler removed; new flat .adj-filter-btn handler is wired above. */
  /* R30c — Helpers are file-level now; just wire the three dropdowns. */
  _editWireDropdown('editFilterDD','editFilterTrigger','editFilterMenu');
  _editWireDropdown('editVignetteDD','editVignetteTrigger','editVignetteMenu');
  _editWireDropdown('editAdjustDD','editAdjustTrigger','editAdjustMenu');
  /* R30b — Reset button inside Adjust popover */
  const _adjReset = document.getElementById('adjResetBtn');
  if (_adjReset){
    _adjReset.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = _editState.pendingEdits.photoAdjust;
      if (a.brightness === 100 && a.contrast === 100 && a.saturation === 100) return;
      _editPushUndo();
      a.brightness = 100; a.contrast = 100; a.saturation = 100;
      const map = [['adjBrightness','adjBrightnessVal',100],
                   ['adjContrast','adjContrastVal',100],
                   ['adjSaturation','adjSaturationVal',100]];
      map.forEach(([id,vid,v]) => {
        const sl = document.getElementById(id); if (sl) sl.value = v;
        const lb = document.getElementById(vid); if (lb) lb.textContent = '0';
      });
      _markDirty();
      _updateEditHistoryUI();
    });
  }
  /* R50 — Auto enhance is the first circle in the carousel. Click toggles. */
  const aeBtn = body.querySelector('[data-adj-action="auto"]');
  if (aeBtn) {
    aeBtn.addEventListener('click', async () => {
      if (aeBtn.disabled) return;
      if (_editState.pendingEdits.autoEnhanced) {
        _editPushUndo();
        if (_editState.pendingEdits.autoEnhancedUrl) {
          try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
        }
        delete _editState.pendingEdits.autoEnhanced;
        delete _editState.pendingEdits.autoEnhancedUrl;
        _updateEditHistoryUI();
        _reRenderEditTab();
        return;
      }
      aeBtn.disabled = true;
      aeBtn.classList.add('busy');
      _editPushUndo();
      try {
        const enhanced = await _runAutoEnhance(_editState.originalFile);
        if (_editState.pendingEdits.autoEnhancedUrl) {
          try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
        }
        _editState.pendingEdits.autoEnhanced = enhanced;
        _editState.pendingEdits.autoEnhancedUrl = URL.createObjectURL(enhanced);
        _updateEditHistoryUI();
        _reRenderEditTab();
      } catch (err) {
        console.warn('[auto-enhance]', err);
        (window.imgreadyToast||alert)('Auto enhance failed: ' + (err.message || err));
        aeBtn.disabled = false;
        aeBtn.classList.remove('busy');
      }
    });
  }
  const aeUndo = document.getElementById('adjAutoEnhanceUndo');
  if (aeUndo) {
    aeUndo.addEventListener('click', () => {
      _editPushUndo();
      if (_editState.pendingEdits.autoEnhancedUrl) {
        try { URL.revokeObjectURL(_editState.pendingEdits.autoEnhancedUrl); } catch(_){}
      }
      delete _editState.pendingEdits.autoEnhanced;
      delete _editState.pendingEdits.autoEnhancedUrl;
      _updateEditHistoryUI();
      _reRenderEditTab();
    });
  }
  /* Vignette wiring */
  const _vigEl = document.getElementById('editAdjVignette');
  function _vigBuildBg(){
    const v = _editState.pendingEdits.vignette;
    if (!v || v.amount === 0) return 'transparent';
    /* R47 — respect tap-to-disable */
    if (v.enabled === false) return 'transparent';
    const amt = Math.abs(v.amount) / 100;
    const start = Math.max(0, Math.min(100, v.midpoint));
    const col = v.amount > 0 ? '0,0,0' : '255,255,255';
    return `radial-gradient(ellipse at center, rgba(${col},0) ${start}%, rgba(${col},${amt.toFixed(3)}) 100%)`;
  }
  function _vigPaintPreview(){
    if (_vigEl) _vigEl.style.background = _vigBuildBg();
  }
  function _vigMarkDirty(){
    const v = _editState.pendingEdits.vignette;
    v._dirty = v.amount !== 0;
    _vigPaintPreview();
    _updateEditHistoryUI();
  }
  _vigPaintPreview();
  const vigReset = document.getElementById('vigReset');
  /* R48b — reset-all button: zeros brightness/contrast/saturation in
     one click. Distinct from the global Reset in the action pill —
     that one clears every edit (rotate, crop, etc.); this one only
     touches the 3 adjustment values, like a per-tab revert. */
  /* R47 — wire tap-to-disable dots on the 3 modified-able chips */
  try { _r47WireSectionToggles(); } catch(_){}
  function _vigUpdateResetState(){
    if (vigReset) vigReset.disabled = !(_editState.pendingEdits.vignette._dirty);
  }
  _vigUpdateResetState();
  /* R30 — keep the vignette dropdown trigger label in sync with amount.
     Shows "Off" when 0, "+30"/"-15" otherwise. */
  function _updateVigTriggerValue(){
    const el = document.getElementById('editVignetteValue');
    if (!el) return;
    const a = _editState.pendingEdits.vignette.amount;
    el.textContent = a === 0 ? 'Off' : (a > 0 ? '+' + a : String(a));
  }
  [['vigAmount','amount','vigAmountVal', v => (v>0?'+'+v:String(v))],
   ['vigMid','midpoint','vigMidVal', v => String(v)]].forEach(([id, key, valId, fmtFn]) => {
    const sl = document.getElementById(id);
    const vl = document.getElementById(valId);
    if (!sl) return;
    sl.addEventListener('input', () => {
      const val = parseInt(sl.value, 10);
      _editState.pendingEdits.vignette[key] = val;
      if (vl) vl.textContent = fmtFn(val);
      _vigMarkDirty();
      _vigUpdateResetState();
      if (key === 'amount') _updateVigTriggerValue();
    });
    sl.addEventListener('change', () => { _editPushUndo(); });
  });
  if (vigReset){
    vigReset.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = _editState.pendingEdits.vignette;
      if (!v._dirty) return;
      _editPushUndo();
      v.amount = 0; v.midpoint = 50; v._dirty = false;
      const a = document.getElementById('vigAmount'); if (a) a.value = '0';
      const av = document.getElementById('vigAmountVal'); if (av) av.textContent = '0';
      const m = document.getElementById('vigMid'); if (m) m.value = '50';
      const mv = document.getElementById('vigMidVal'); if (mv) mv.textContent = '50';
      _vigPaintPreview();
      _updateEditHistoryUI();
      _vigUpdateResetState();
      _updateVigTriggerValue();
    });
  }
}

/* R50 — Filters tab. Split out of Adjust. VSCO/Apple Photos pattern. */


/* R65 — Build tick DOM elements inside a .adj-tick-ticks container.
   range, minorStep, majorEvery are derived from the ruler's --range
   CSS variable. */
function _buildRulerTicks(rulerEl){
  /* R73 — fixed visual density. 40 minor ticks total, major every 5
     (9 majors visible). Same visual on every scrubber, independent of
     the underlying unit range. Apple Photos uses constant density too. */
  if (!rulerEl) return;
  const ticksEl = rulerEl.querySelector('.adj-tick-ticks');
  if (!ticksEl) return;
  const MINOR_COUNT = 40;
  const MAJOR_EVERY = 5;
  const frag = document.createDocumentFragment();
  for (let i = 0; i <= MINOR_COUNT; i++) {
    const pct = (i / MINOR_COUNT) * 100;
    const tick = document.createElement('span');
    tick.className = 'adj-tick' + ((i % MAJOR_EVERY === 0) ? ' major' : '');
    tick.style.left = pct.toFixed(4) + '%';
    frag.appendChild(tick);
  }
  ticksEl.innerHTML = '';
  ticksEl.appendChild(frag);
}

/* R51 — floating section-label pill (BRIGHTNESS, SATURATION, etc.).
   Lives in editPreviewCol so it floats OVER the photo, above the action
   pill, matching Apple Photos. _renderAdjustTab + _renderFiltersTab call
   this to set the label; _switchEditTab clears it on other tabs. */
function _ensureAdjSectionPill(label, value){
  /* R71 — host the pill INSIDE the floating tool surface as its first
     child. That way it stacks above the icons naturally (in flow) and
     can't drift over the icon row. Falls back to editPreviewCol if
     the tool surface isn't present yet. */
  const surface = document.getElementById('editBody');
  const host = surface || document.getElementById('editPreviewCol');
  if (!host) return null;
  let pill = host.querySelector(':scope > .adj-section-pill');
  if (!pill) {
    pill = document.createElement('div');
    pill.className = 'adj-section-pill';
    pill.innerHTML = '<span class="adj-section-pill-label"></span><span class="adj-section-pill-val"></span>';
    /* Insert at top so it's the first floating element above the toolbar. */
    if (host.firstChild) host.insertBefore(pill, host.firstChild);
    else host.appendChild(pill);
  }
  const lblEl = pill.querySelector('.adj-section-pill-label');
  const valEl = pill.querySelector('.adj-section-pill-val');
  if (lblEl) lblEl.textContent = (label || '').toUpperCase();
  if (valEl) valEl.textContent = value || '';
  pill.hidden = !label;
  pill.id = 'adjSectionPill';
  if (lblEl) lblEl.id = 'adjSectionPillLabel';
  if (valEl) valEl.id = 'adjSectionPillVal';
  return pill;
}
function _hideAdjSectionPill(){
  const col = document.getElementById('editPreviewCol');
  if (!col) return;
  const pill = col.querySelector('.adj-section-pill');
  if (pill) pill.hidden = true;
}

function _renderFiltersTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  /* R75 — pill creation moved AFTER body.innerHTML below (was wiped). */
  if (!_editState.pendingEdits.photoAdjust) {
    _editState.pendingEdits.photoAdjust = { brightness: 100, contrast: 100, saturation: 100, globalBlur: 0, preset: 'none', presetCss: '', _dirty: false, sliderEnabled: true, filterEnabled: true, selected: 'brightness' };
  }
  const adj = _editState.pendingEdits.photoAdjust;
  if (adj.filterEnabled === undefined) adj.filterEnabled = true;
  const PRESETS = [
    { id: 'none',    label: 'Original', css: '' },
    { id: 'bw',      label: 'B&W',      css: 'grayscale(100%)' },
    { id: 'sepia',   label: 'Sepia',    css: 'sepia(100%)' },
    { id: 'vintage', label: 'Vintage',  css: 'sepia(40%) contrast(110%) brightness(90%) saturate(130%)' },
    { id: 'invert',  label: 'Invert',   css: 'invert(100%)' },
    { id: 'cool',    label: 'Cool',     css: 'hue-rotate(200deg) saturate(140%) brightness(105%)' },
    { id: 'warm',    label: 'Warm',     css: 'sepia(30%) saturate(180%) brightness(105%)' },
  ];
  const adjPreviewCol = _editPreviewEl();
  if (adjPreviewCol) {
    const _src = _editState.pendingEdits.autoEnhancedUrl || _editState.originalUrl || f.url;
    adjPreviewCol.innerHTML = '<div class="edit-adjust-preview-wrap"><div class="edit-adjust-img-frame"><img id="editAdjPreview" src="' + _src + '" class="edit-adjust-preview" draggable="false" alt=""><div class="edit-vignette-overlay" id="editAdjVignette"></div></div></div>';
    const _img = document.getElementById('editAdjPreview');
    if (_img) {
      const filterOn = adj.filterEnabled !== false;
      const pre = (filterOn && adj.preset !== 'none' && adj.presetCss) ? adj.presetCss + ' ' : '';
      const sliders = (adj.sliderEnabled !== false) ? 'brightness(' + adj.brightness + '%) contrast(' + adj.contrast + '%) saturate(' + adj.saturation + '%)' : '';
      _img.style.filter = (pre + sliders) || 'none';
    }
  }
  const _previewSrc = _editState.pendingEdits.autoEnhancedUrl || _editState.originalUrl || f.url;
  body.innerHTML = `
    <div class="edit-tool-toolbar filters-tab-r50">
      <div class="filters-thumb-row" role="tablist" aria-label="Filters">
        ${PRESETS.map(p => `
          <button type="button" class="filter-thumb${p.id === adj.preset ? ' active' : ''}" data-preset="${p.id}" data-css="${p.css}" title="${p.label}" aria-pressed="${p.id === adj.preset}">
            <span class="filter-thumb-img" style="background-image:url('${_previewSrc}');${p.css ? 'filter:' + p.css + ';' : ''}"></span>
            <span class="filter-thumb-name">${p.label}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  /* R75 — create pill AFTER innerHTML so it persists. */
  try { _ensureAdjSectionPill('Filters', ''); } catch(_){}
  body.querySelectorAll('.filter-thumb').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.preset;
      const css = btn.dataset.css || '';
      const a = _editState.pendingEdits.photoAdjust;
      if (a.preset === id) return;
      _editPushUndo();
      a.preset = id;
      a.presetCss = css;
      a._dirty = !(a.brightness === 100 && a.contrast === 100 && a.saturation === 100 && a.preset === 'none' && !(a.globalBlur > 0));
      body.querySelectorAll('.filter-thumb').forEach(b => {
        const on = b.dataset.preset === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      const _img = document.getElementById('editAdjPreview');
      if (_img) {
        const filterOn = a.filterEnabled !== false;
        const pre = (filterOn && a.preset !== 'none' && a.presetCss) ? a.presetCss + ' ' : '';
        const sliders = (a.sliderEnabled !== false) ? 'brightness(' + a.brightness + '%) contrast(' + a.contrast + '%) saturate(' + a.saturation + '%)' : '';
        _img.style.filter = (pre + sliders) || 'none';
      }
      _updateEditHistoryUI();
    });
  });
}

async function _applyPhotoAdjust(file, adjInfo){
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width; canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  /* R47 — honor per-section enables. If both disabled the function
     would have been skipped by the saveEdit gate; defensive only. */
  const _filtOn = adjInfo.filterEnabled !== false;
  const _slidOn = adjInfo.sliderEnabled !== false;
  const pre = (_filtOn && adjInfo.preset !== 'none' && adjInfo.presetCss) ? adjInfo.presetCss + ' ' : '';
  let slid = '';
  if (_slidOn) {
    if (adjInfo.brightnessEnabled !== false) slid += `brightness(${adjInfo.brightness}%) `;
    if (adjInfo.contrastEnabled   !== false) slid += `contrast(${adjInfo.contrast}%) `;
    if (adjInfo.saturationEnabled !== false) slid += `saturate(${adjInfo.saturation}%) `;
    if (adjInfo.globalBlurEnabled !== false && adjInfo.globalBlur > 0) slid += `blur(${adjInfo.globalBlur}px) `;
  }
  ctx.filter = (pre + slid.trim()) || 'none';
  ctx.drawImage(bmp, 0, 0);
  ctx.filter = 'none';
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('adjust encode failed')), mime, 0.95);
  });
}

/* Round 14 — Vignette: radial gradient composited on top of the photo.
   info = { amount: -100..+100, midpoint: 0..100, _dirty }
   Positive amount = darken corners; negative = lighten corners.
   Ellipse follows the image aspect ratio so the falloff feels natural. */
async function _applyVignette(file, info){
  if (!info || !info._dirty || info.amount === 0) return file;
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const cx = W / 2, cy = H / 2;
  const minHalf = Math.min(W, H) / 2;
  /* Build an elliptical gradient by scaling the canvas before drawing a circular one. */
  const sx = (W / 2) / minHalf;
  const sy = (H / 2) / minHalf;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(sx, sy);
  ctx.translate(-cx, -cy);
  const inner = minHalf * (Math.max(0, Math.min(100, info.midpoint)) / 100);
  const outer = minHalf;
  const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
  const amt = Math.abs(info.amount) / 100;
  if (info.amount > 0){
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${amt})`);
  } else {
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, `rgba(255,255,255,${amt})`);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  /* Preserve transparency where present (PNG/WEBP); else stick with input mime. */
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('vignette encode failed')), mime, 0.95);
  });
}

/* ---- CROP TAB (photo: aspect presets + drag handles) ---- */
async function _renderCropTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  const cropPreviewCol = _editPreviewEl();
  if (cropPreviewCol) {
    cropPreviewCol.innerHTML = `<div class="edit-crop-canvas-wrap" id="editCropWrap"><canvas id="editCropCanvas"></canvas></div>`;
  }
  body.innerHTML = `
    <div class="edit-crop-presets" id="editCropPresets">
      <span style="font-size:.76rem;font-weight:600;color:rgba(255,255,255,.5);margin-right:4px;letter-spacing:.04em;text-transform:uppercase;">Ratio</span>
      ${[{l:'Free',v:'free'},{l:'1:1',v:'1:1'},{l:'4:3',v:'4:3'},{l:'3:2',v:'3:2'},{l:'16:9',v:'16:9'}]
        .map(p=>`<button type="button" class="edit-preset-btn${p.v==='free'?' active':''}" data-aspect="${p.v}">${p.l}</button>`).join('')}
    </div>
    <p style="font-size:.7rem;color:rgba(255,255,255,.35);margin:0;">Drag the corners or edges to crop</p>
    <button type="button" class="edit-frames-action-btn" id="editCropApplyBtn" style="width:100%;margin-top:auto;">Apply</button>
  `;
  const canvas = document.getElementById('editCropCanvas');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('editCropWrap');
  let bmp;
  try { bmp = await createImageBitmap(_editState.originalFile || f.file); }
  catch(e) { body.innerHTML = '<p style="color:rgba(255,120,120,.85);">Could not load image for crop.</p>'; return; }
  const imgW = bmp.width, imgH = bmp.height;
  const pcEl = _editPreviewEl();
  const maxW = Math.min(((pcEl ? pcEl.clientWidth : 640) || 640) - 8, 1600);
  const maxH = Math.min(((pcEl ? pcEl.clientHeight : 500) || 500) - 8, 1000);
  const scale = Math.min(maxW / imgW, maxH / imgH, 1);
  const dispW = Math.round(imgW * scale), dispH = Math.round(imgH * scale);
  canvas.width = dispW; canvas.height = dispH;
  canvas.style.cssText = `width:${dispW}px;height:${dispH}px;display:block;cursor:crosshair;`;
  const HSIZE = 9;
  const pad = 12;
  let crop = { x: pad, y: pad, w: dispW - pad*2, h: dispH - pad*2, aspect: null };
  if (_editState.pendingEdits.photoCrop) {
    const pc = _editState.pendingEdits.photoCrop;
    crop = { x: Math.round(pc.x * scale), y: Math.round(pc.y * scale),
              w: Math.round(pc.w * scale), h: Math.round(pc.h * scale), aspect: pc.aspect };
  }
  function drawCrop(){
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(bmp, 0, 0, dispW, dispH);
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, dispW, dispH);
    // Clear and redraw image inside crop box
    ctx.save();
    ctx.beginPath(); ctx.rect(crop.x, crop.y, crop.w, crop.h); ctx.clip();
    ctx.drawImage(bmp, 0, 0, dispW, dispH);
    ctx.restore();
    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(crop.x + 0.5, crop.y + 0.5, crop.w, crop.h);
    // Rule-of-thirds
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 0.5;
    for (let i = 1; i <= 2; i++){
      const gx = crop.x + crop.w * i / 3, gy = crop.y + crop.h * i / 3;
      ctx.beginPath(); ctx.moveTo(gx, crop.y); ctx.lineTo(gx, crop.y + crop.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(crop.x, gy); ctx.lineTo(crop.x + crop.w, gy); ctx.stroke();
    }
    // Handles
    const { x, y, w, h } = crop;
    const cx = x + w/2, cy = y + h/2;
    [[x,y],[cx,y],[x+w,y],[x,cy],[x+w,cy],[x,y+h],[cx,y+h],[x+w,y+h]].forEach(([hx,hy]) => {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.stroke();
    });
  }
  function getZone(mx, my){
    const { x, y, w, h } = crop;
    const cx = x+w/2, cy = y+h/2;
    const pts = {nw:[x,y],n:[cx,y],ne:[x+w,y],w:[x,cy],e:[x+w,cy],sw:[x,y+h],s:[cx,y+h],se:[x+w,y+h]};
    for (const [name,[hx,hy]] of Object.entries(pts)){
      if (Math.abs(mx-hx)<=HSIZE+2 && Math.abs(my-hy)<=HSIZE+2) return name;
    }
    if (mx>x && mx<x+w && my>y && my<y+h) return 'move';
    return null;
  }
  const CMAP = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};
  function clamp(c){
    const MIN=20;
    if (c.w < MIN) c.w = MIN; if (c.h < MIN) c.h = MIN;
    if (c.x < 0) c.x = 0; if (c.y < 0) c.y = 0;
    if (c.x + c.w > dispW) { if (c.w < dispW) c.x = dispW - c.w; else c.w = dispW - c.x; }
    if (c.y + c.h > dispH) { if (c.h < dispH) c.y = dispH - c.h; else c.h = dispH - c.y; }
    return c;
  }
  let dragZ = null, dsx = 0, dsy = 0, dsc = null;
  function getEvtXY(e){
    const r = canvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return [src.clientX - r.left, src.clientY - r.top];
  }
  canvas.addEventListener('mousemove', e => {
    const [mx,my] = getEvtXY(e);
    if (dragZ) {
      const dx = mx-dsx, dy = my-dsy;
      const sc = Object.assign({},dsc);
      if (dragZ==='move'){sc.x+=dx;sc.y+=dy;}
      else if (dragZ==='se'){sc.w+=dx;sc.h+=dy;}
      else if (dragZ==='nw'){sc.x+=dx;sc.y+=dy;sc.w-=dx;sc.h-=dy;}
      else if (dragZ==='ne'){sc.w+=dx;sc.y+=dy;sc.h-=dy;}
      else if (dragZ==='sw'){sc.x+=dx;sc.w-=dx;sc.h+=dy;}
      else if (dragZ==='n'){sc.y+=dy;sc.h-=dy;}
      else if (dragZ==='s'){sc.h+=dy;}
      else if (dragZ==='e'){sc.w+=dx;}
      else if (dragZ==='w'){sc.x+=dx;sc.w-=dx;}
      if (crop.aspect && dragZ!=='move'){sc.h=Math.round(sc.w/crop.aspect);}
      crop=clamp(sc); drawCrop();
    } else {
      const z=getZone(mx,my); canvas.style.cursor=CMAP[z]||'crosshair';
    }
  });
  canvas.addEventListener('mousedown', e => {
    const [mx,my]=getEvtXY(e); dragZ=getZone(mx,my);
    if (dragZ){dsx=mx;dsy=my;dsc=Object.assign({},crop);e.preventDefault();}
  });
  const stopDrag = () => { dragZ = null; };
  document.addEventListener('mouseup', stopDrag);
  // Clean up listener when tab switches
  const obs = new MutationObserver(() => { if (!canvas.isConnected){ document.removeEventListener('mouseup',stopDrag); obs.disconnect(); try{bmp.close&&bmp.close();}catch(_){} } });
  obs.observe(_editPreviewEl() || body, {childList:true,subtree:true});
  document.querySelectorAll('#editBody [data-aspect]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#editBody [data-aspect]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const v = btn.dataset.aspect;
      if (v === 'free') { crop.aspect = null; }
      else { const [a,b2]=v.split(':').map(Number); crop.aspect=a/b2; crop.h=Math.round(crop.w/crop.aspect); crop=clamp(crop); }
      drawCrop();
    });
  });
  document.getElementById('editCropApplyBtn').addEventListener('click', () => {
    _editPushUndo();
    _editState.pendingEdits.photoCrop = {
      x: Math.round(crop.x / scale), y: Math.round(crop.y / scale),
      w: Math.max(1,Math.round(crop.w / scale)), h: Math.max(1,Math.round(crop.h / scale)),
      aspect: crop.aspect
    };
    const btn = document.getElementById('editCropApplyBtn');
    if (btn){ btn.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#i-check"/></svg>Crop applied'; btn.style.background='rgba(60,160,60,.2)'; btn.style.borderColor='rgba(60,200,60,.3)'; }
  });
  drawCrop();
}
async function _applyPhotoCrop(file, cropInfo){
  const bmp = await createImageBitmap(file);
  const sx=Math.max(0,cropInfo.x), sy=Math.max(0,cropInfo.y);
  const sw=Math.min(cropInfo.w, bmp.width-sx), sh=Math.min(cropInfo.h, bmp.height-sy);
  const canvas = document.createElement('canvas');
  canvas.width = sw; canvas.height = sh;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res,rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('crop encode failed')), mime, 0.95);
  });
}

/* ---- ROUND 6: AUTO-ENHANCE (gray-world WB + percentile auto-levels + sat) ---- */
async function _runAutoEnhance(file){
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const imgData = ctx.getImageData(0, 0, W, H);
  _autoEnhanceData(imgData);
  ctx.putImageData(imgData, 0, 0);
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('auto-enhance encode failed')), mime, 0.95);
  });
}
function _autoEnhanceData(imgData){
  const d = imgData.data, n = d.length, px = (n >> 2) || 1;
  /* 1. Gray-world white balance (tamed) */
  let sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < n; i += 4){ sumR += d[i]; sumG += d[i+1]; sumB += d[i+2]; }
  const mR = sumR / px, mG = sumG / px, mB = sumB / px;
  const gray = (mR + mG + mB) / 3;
  const tame = v => Math.min(1.45, Math.max(0.70, v));
  const cR = tame(gray / Math.max(mR, 1e-3));
  const cG = tame(gray / Math.max(mG, 1e-3));
  const cB = tame(gray / Math.max(mB, 1e-3));
  for (let i = 0; i < n; i += 4){
    let r = d[i] * cR, g = d[i+1] * cG, b = d[i+2] * cB;
    d[i]   = r < 0 ? 0 : (r > 255 ? 255 : r);
    d[i+1] = g < 0 ? 0 : (g > 255 ? 255 : g);
    d[i+2] = b < 0 ? 0 : (b > 255 ? 255 : b);
  }
  /* 2. Per-channel auto-levels (0.5% / 99.5% percentile clip) */
  const histR = new Uint32Array(256), histG = new Uint32Array(256), histB = new Uint32Array(256);
  for (let i = 0; i < n; i += 4){ histR[d[i]]++; histG[d[i+1]]++; histB[d[i+2]]++; }
  function pct(hist){
    const lo = px * 0.005, hi = px * 0.995;
    let cum = 0, loV = 0, hiV = 255, foundLo = false;
    for (let v = 0; v < 256; v++){
      cum += hist[v];
      if (!foundLo && cum >= lo){ loV = v; foundLo = true; }
      if (cum >= hi){ hiV = v; break; }
    }
    if (hiV <= loV) hiV = loV + 1;
    return [loV, hiV];
  }
  const [rLo, rHi] = pct(histR);
  const [gLo, gHi] = pct(histG);
  const [bLo, bHi] = pct(histB);
  const lutR = new Uint8ClampedArray(256), lutG = new Uint8ClampedArray(256), lutB = new Uint8ClampedArray(256);
  const rS = 255 / (rHi - rLo), gS = 255 / (gHi - gLo), bS = 255 / (bHi - bLo);
  for (let v = 0; v < 256; v++){
    lutR[v] = (v - rLo) * rS;
    lutG[v] = (v - gLo) * gS;
    lutB[v] = (v - bLo) * bS;
  }
  for (let i = 0; i < n; i += 4){
    d[i] = lutR[d[i]]; d[i+1] = lutG[d[i+1]]; d[i+2] = lutB[d[i+2]];
  }
  /* 3. Modest saturation bump (+15%) via luma-preserving scale */
  const sat = 1.15;
  for (let i = 0; i < n; i += 4){
    const r = d[i], g = d[i+1], b = d[i+2];
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let nr = Y + (r - Y) * sat;
    let ng = Y + (g - Y) * sat;
    let nb = Y + (b - Y) * sat;
    d[i]   = nr < 0 ? 0 : (nr > 255 ? 255 : nr);
    d[i+1] = ng < 0 ? 0 : (ng > 255 ? 255 : ng);
    d[i+2] = nb < 0 ? 0 : (nb > 255 ? 255 : nb);
  }
  return imgData;
}

/* ---- ROUND 6: PIXELATE TAB (brush-based mosaic redaction) ---- */
async function _pxBaseBlob(){
  /* Build the snapshot that pixelate is layered on top of:
     applies auto-enhance + rotate + adjust + crop to the original file.
     Cached on _editState until upstream edits change. */
  const pe = _editState.pendingEdits;
  const sig = JSON.stringify({
    a: !!pe.autoEnhanced,
    r: pe.rotate || null,
    j: pe.photoAdjust && pe.photoAdjust._dirty ? pe.photoAdjust : null,
    c: pe.photoCrop || null,
    v: pe.vignette && pe.vignette._dirty ? pe.vignette : null
  });
  if (_editState._pxBaseSig === sig && _editState._pxBaseBlob){
    return _editState._pxBaseBlob;
  }
  let blob = _editState.originalFile;
  if (pe.autoEnhanced) blob = pe.autoEnhanced;
  if (pe.rotate) blob = await _applyRotation(blob, pe.rotate);
  if (pe.photoAdjust && pe.photoAdjust._dirty) blob = await _applyPhotoAdjust(blob, pe.photoAdjust);
  if (pe.photoCrop) blob = await _applyPhotoCrop(blob, pe.photoCrop);
  if (pe.vignette && pe.vignette._dirty) blob = await _applyVignette(blob, pe.vignette);
  if (_editState._pxBaseUrl){ try { URL.revokeObjectURL(_editState._pxBaseUrl); } catch(_){} }
  _editState._pxBaseBlob = blob;
  _editState._pxBaseUrl = URL.createObjectURL(blob);
  _editState._pxBaseSig = sig;
  if (_editState._pxBitmap){ try { _editState._pxBitmap.close && _editState._pxBitmap.close(); } catch(_){} }
  _editState._pxBitmap = null;
  return blob;
}

/* ============================================================
   BLUR TAB (Round 13)
   - Brush-based blur over a pre-rendered ctx.filter='blur(Npx)' canvas
   - "Apply to all" toggle for full-image gaussian blur (DoF aesthetic)
   - Same architecture as Pixelate (Round 6): strokes stored as normalized
     [0..1] coords + per-stroke mode/radius, so they replay at full source
     resolution on save via _applyBlur(blob, blurInfo)
   - Zero new external deps; Canvas2D ctx.filter is browser-native:
     https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/filter
   - Cross-browser support: Chrome 52+, Firefox 49+, Safari 16.4+. For older
     Safari (iOS <16.4) ctx.filter returns undefined; the apply path falls
     back to downsample-upsample bilinear approximation (cheap, acceptable
     visual fidelity for redaction use cases).
   ============================================================ */
async function _blurBaseBlob(){
  /* Compose upstream edits (auto-enhance + rotate + adjust + crop + pixelate)
     so the blur brush previews land on the same image the user will save. */
  const pe = _editState.pendingEdits;
  const sig = JSON.stringify({
    a: !!pe.autoEnhanced,
    r: pe.rotate || null,
    j: pe.photoAdjust && pe.photoAdjust._dirty ? pe.photoAdjust : null,
    c: pe.photoCrop || null,
    v: pe.vignette && pe.vignette._dirty ? pe.vignette : null,
    p: pe.pixelate && pe.pixelate.strokes && pe.pixelate.strokes.length ? pe.pixelate : null
  });
  if (_editState._blurBaseSig === sig && _editState._blurBaseBlob){
    return _editState._blurBaseBlob;
  }
  let blob = _editState.originalFile;
  if (pe.autoEnhanced) blob = pe.autoEnhanced;
  if (pe.rotate) blob = await _applyRotation(blob, pe.rotate);
  if (pe.photoAdjust && pe.photoAdjust._dirty) blob = await _applyPhotoAdjust(blob, pe.photoAdjust);
  if (pe.photoCrop) blob = await _applyPhotoCrop(blob, pe.photoCrop);
  if (pe.vignette && pe.vignette._dirty) blob = await _applyVignette(blob, pe.vignette);
  _editState._blurBaseBlob = blob;
  _editState._blurBaseSig = sig;
  if (_editState._blurBitmap){ try { _editState._blurBitmap.close && _editState._blurBitmap.close(); } catch(_){} }
  _editState._blurBitmap = null;
  return blob;
}
async function _renderBlurTab(body){
  const f = FILES[_editState.idx];
  if (!f) return;
  if (!_editState.pendingEdits.blur){
    _editState.pendingEdits.blur = { strokes: [], radius: 14, brushPx: 50, mode: 'paint', full: false, enabled: true };
  }
  const bl = _editState.pendingEdits.blur;
  const previewCol = _editPreviewEl();
  if (previewCol){
    previewCol.innerHTML = '<div class="edit-blur-wrap"><canvas id="editBlurCanvas" class="edit-blur-canvas"></canvas></div>';
  }
  /* R54 — unified Blur layout. */
  if (bl.selected === undefined) bl.selected = 'brush';
  const _blKey = bl.selected;
  const _blR = (_blKey === 'amount') ? { min:2, max:40 } : { min:6, max:160 };
  const _blV = (_blKey === 'amount') ? bl.radius : bl.brushPx;
  const _blPct = ((_blV - _blR.min) / (_blR.max - _blR.min)) * 100;
  body.innerHTML = ''
    + '<div class="edit-blur-controls adj-tab-r50">'
    +   '<div class="ed-func-row' + (bl.enabled === false ? ' row-disabled' : '') + '" id="blRow">'
    +     '<button type="button" class="ed-circle-btn' + (bl.mode==="paint"?" active":"") + '" data-bl-mode="paint" title="Paint" aria-pressed="' + (bl.mode==="paint") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-brush"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn' + (bl.mode==="erase"?" active":"") + '" data-bl-mode="erase" title="Erase" aria-pressed="' + (bl.mode==="erase") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-eraser"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn' + (bl.full ? " active" : "") + '" id="blApplyAll" title="' + (bl.full ? "Brush only" : "Whole image") + '" aria-pressed="' + (bl.full?"true":"false") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-globe"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn adj-circle-btn' + (_blKey==="brush"?" selected":"") + '" data-bl-key="brush" title="Brush size" aria-pressed="' + (_blKey==="brush") + '">'
    +       '<span class="ed-circle-ring" aria-hidden="true"></span>'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-aperture"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn adj-circle-btn' + (_blKey==="amount"?" selected":"") + '" data-bl-key="amount" title="Blur amount" aria-pressed="' + (_blKey==="amount") + '">'
    +       '<span class="ed-circle-ring" aria-hidden="true"></span>'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-droplets"/></svg></span>'
    +     '</button>'
    +     '<button type="button" class="ed-circle-btn ed-circle-sm ed-disable-btn' + (bl.enabled === false ? " tab-disabled" : "") + '" id="blDisable" title="' + (bl.enabled === false ? "Enable blur" : "Disable blur") + '" aria-pressed="' + (bl.enabled === false ? "true" : "false") + '">'
    +       '<span class="ed-circle-inner"><svg class="ico" aria-hidden="true"><use href="#i-power"/></svg></span>'
    +     '</button>'
    +   '</div>'
    +   '<div class="adj-tick-ruler" id="blRuler" style="--range:' + (_blR.max - _blR.min) + ';">'
    +     '<div class="adj-tick-ticks" aria-hidden="true"></div>'
    +     '<div class="adj-tick-center" aria-hidden="true"></div>'
    +     '<div class="adj-tick-dot" id="blTickDot" style="left:' + _blPct.toFixed(2) + '%;" aria-hidden="true"></div>'
    +     '<input type="range" id="blScrub" class="adj-tick-input" min="' + _blR.min + '" max="' + _blR.max + '" step="1" value="' + _blV + '" aria-label="Blur scrubber">'
    +   '</div>'
    + '</div>';
  try {
    const _lbl = _blKey === 'amount' ? 'AMOUNT' : 'BRUSH';
    _ensureAdjSectionPill('Blur · ' + _lbl, String(_blV));
  } catch(_){}
  /* R65 — populate ticks for Blur ruler. */
  try { _buildRulerTicks(document.getElementById('blRuler')); } catch(_){}
  /* Build preview source */
  await _blurBaseBlob();
  let bmp = _editState._blurBitmap;
  if (!bmp){
    bmp = await createImageBitmap(_editState._blurBaseBlob);
    _editState._blurBitmap = bmp;
  }
  const canvas = document.getElementById('editBlurCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  function fitDims(){
    const cw = (wrap.clientWidth || 800);
    const ch = (wrap.clientHeight || 600);
    const ratio = bmp.width / bmp.height;
    let dw = cw, dh = cw / ratio;
    if (dh > ch){ dh = ch; dw = ch * ratio; }
    return { dw: Math.max(1, Math.floor(dw)), dh: Math.max(1, Math.floor(dh)) };
  }
  const dims = fitDims();
  const dw = dims.dw, dh = dims.dh;
  canvas.width = dw; canvas.height = dh;
  canvas.style.width = dw + 'px'; canvas.style.height = dh + 'px';
  /* Round 15 — show a sized ring cursor so the brush footprint is visible */
  function _blRefreshCursor(){ canvas.style.cursor = _bgRingCursor(bl.brushPx); }
  _blRefreshCursor();
  /* R30c — keep Brush ▾ trigger summary in sync */
  function _blRefreshSummary(){
    const el = document.getElementById('editBlSummary');
    if (el) el.textContent = 'Brush ' + bl.brushPx + ' · Amt ' + bl.radius;
  }
  _editWireDropdown('editBlDD','editBlTrigger','editBlMenu');
  /* Pre-render a fully blurred copy (preview-resolution). Use ctx.filter when
     available; fall back to nearest-neighbour downsample-upsample for old Safari. */
  let blurCache = null, blurCacheR = -1;
  function buildBlurredPreview(radiusSrc){
    /* Scale the source-resolution radius to preview pixels so brush-preview
       blur strength matches what _applyBlur produces at full res. */
    const sx = dw / bmp.width;
    const radius = Math.max(1, radiusSrc * sx);
    const out = document.createElement('canvas');
    out.width = dw; out.height = dh;
    const octx = out.getContext('2d');
    if (typeof octx.filter !== 'undefined'){
      octx.filter = 'blur(' + radius.toFixed(2) + 'px)';
      octx.drawImage(bmp, 0, 0, dw, dh);
      octx.filter = 'none';
    } else {
      /* Fallback: scale-down then scale-up (cheap pseudo-gaussian). */
      const k = Math.max(2, Math.floor(radius));
      const tw = Math.max(1, Math.floor(dw / k));
      const th = Math.max(1, Math.floor(dh / k));
      const tiny = document.createElement('canvas');
      tiny.width = tw; tiny.height = th;
      const tctx = tiny.getContext('2d');
      tctx.imageSmoothingEnabled = true;
      tctx.drawImage(bmp, 0, 0, tw, th);
      octx.imageSmoothingEnabled = true;
      octx.drawImage(tiny, 0, 0, tw, th, 0, 0, dw, dh);
    }
    return out;
  }
  function getBlur(){
    if (blurCache && blurCacheR === bl.radius) return blurCache;
    blurCache = buildBlurredPreview(bl.radius);
    blurCacheR = bl.radius;
    return blurCache;
  }
  const mask = document.createElement('canvas');
  mask.width = dw; mask.height = dh;
  const mctx = mask.getContext('2d');
  function drawStrokeAt(ctxM, stk, scaleX, scaleY){
    ctxM.fillStyle = '#fff';
    ctxM.strokeStyle = '#fff';
    ctxM.globalCompositeOperation = (stk.mode === 'erase') ? 'destination-out' : 'source-over';
    const minD = Math.min(scaleX, scaleY);
    for (let i = 0; i < stk.pts.length; i++){
      const p = stk.pts[i];
      const x = p.x * scaleX, y = p.y * scaleY, r = p.r * minD;
      ctxM.beginPath(); ctxM.arc(x, y, r, 0, Math.PI * 2); ctxM.fill();
      if (i > 0){
        const prev = stk.pts[i-1];
        const px0 = prev.x * scaleX, py0 = prev.y * scaleY;
        ctxM.lineWidth = r * 2; ctxM.lineCap = 'round';
        ctxM.beginPath(); ctxM.moveTo(px0, py0); ctxM.lineTo(x, y); ctxM.stroke();
      }
    }
    ctxM.globalCompositeOperation = 'source-over';
  }
  function replay(){
    mctx.clearRect(0, 0, dw, dh);
    if (bl.full){
      /* full-image: fill the entire mask so the blurred copy is composited everywhere */
      mctx.fillStyle = '#fff';
      mctx.fillRect(0, 0, dw, dh);
      /* but still respect erase strokes (let user punch sharp holes) */
      bl.strokes.forEach(stk => {
        if (stk.mode === 'erase') drawStrokeAt(mctx, stk, dw, dh);
      });
    } else {
      bl.strokes.forEach(stk => drawStrokeAt(mctx, stk, dw, dh));
    }
  }
  const ctx = canvas.getContext('2d');
  function render(){
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(bmp, 0, 0, dw, dh);
    replay();
    const bcanvas = getBlur();
    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(bcanvas, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(mask, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }
  render();
  let painting = false, curStroke = null;
  function ptFromEv(ev){
    const rect = canvas.getBoundingClientRect();
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
    const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
    return { x: cx / dw, y: cy / dh, r: (bl.brushPx / 2) / Math.min(dw, dh) };
  }
  function down(ev){
    ev.preventDefault();
    _editPushUndo();
    painting = true;
    curStroke = { mode: bl.mode, pts: [ptFromEv(ev)] };
    bl.strokes.push(curStroke);
    render();
    _updateEditHistoryUI();
  }
  function move(ev){
    if (!painting) return;
    ev.preventDefault();
    curStroke.pts.push(ptFromEv(ev));
    render();
  }
  function up(){ painting = false; curStroke = null; }
  canvas.addEventListener('mousedown', down);
  canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('touchstart', down, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  window.addEventListener('touchend', up);
  /* R54 — Disable toggle for Blur. */
  const _blDisable = document.getElementById('blDisable');
  if (_blDisable) {
    _blDisable.addEventListener('click', () => {
      const b = _editState.pendingEdits.blur;
      b.enabled = (b.enabled === false);
      _blDisable.classList.toggle('tab-disabled', b.enabled === false);
      _blDisable.setAttribute('aria-pressed', b.enabled === false ? 'true' : 'false');
      _blDisable.title = b.enabled === false ? 'Enable blur' : 'Disable blur';
      const row = document.getElementById('blRow');
      if (row) row.classList.toggle('row-disabled', b.enabled === false);
      try { if (typeof render === 'function') render(); } catch(_){}
    });
  }
  /* R54 — selectable param icons drive the scrubber. */
  const _blScrub = document.getElementById('blScrub');
  const _blTickDot = document.getElementById('blTickDot');
  function _blRange(k){ return (k === 'amount') ? { min:2, max:40 } : { min:6, max:160 }; }
  function _blVal(k){ return (k === 'amount') ? bl.radius : bl.brushPx; }
  function _blSetVal(k, v){ if (k === 'amount') bl.radius = v; else bl.brushPx = v; }
  function _blSyncUI(){
    const k = bl.selected || 'brush';
    const r = _blRange(k);
    const v = _blVal(k);
    if (_blScrub){ _blScrub.min = String(r.min); _blScrub.max = String(r.max); _blScrub.value = String(v); }
    if (_blTickDot) _blTickDot.style.left = (((v - r.min)/(r.max - r.min))*100).toFixed(2) + '%';
    const ruler = document.getElementById('blRuler');
    if (ruler) {
      ruler.style.setProperty('--range', String(r.max - r.min));
      try { _buildRulerTicks(ruler); } catch(_){}
    }
    const lbl = document.getElementById('adjSectionPillLabel');
    const val = document.getElementById('adjSectionPillVal');
    if (lbl) lbl.textContent = ('BLUR · ' + (k === 'amount' ? 'AMOUNT' : 'BRUSH'));
    if (val) val.textContent = String(v);
  }
  document.querySelectorAll('#editBody [data-bl-key]').forEach(b => {
    b.addEventListener('click', () => {
      bl.selected = b.dataset.blKey;
      document.querySelectorAll('#editBody [data-bl-key]').forEach(o => {
        const sel = o.dataset.blKey === bl.selected;
        o.classList.toggle('selected', sel);
        o.setAttribute('aria-pressed', sel ? 'true' : 'false');
      });
      _blSyncUI();
    });
  });
  if (_blScrub){
    _blScrub.addEventListener('input', () => {
      const k = bl.selected || 'brush';
      const v = parseInt(_blScrub.value, 10);
      _blSetVal(k, v);
      _blSyncUI();
      if (typeof _blRefreshCursor === 'function') _blRefreshCursor();
      if (typeof render === 'function') render();
    });
    _blScrub.addEventListener('change', () => { _editPushUndo(); });
  }
  document.querySelectorAll('#editBody [data-bl-mode]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#editBody [data-bl-mode]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      bl.mode = b.dataset.blMode;
    });
  });
  /* R54 — legacy Blur sliders removed; their values are now driven by
     the unified scrubber. Guard lookups. */
  const brushSl = document.getElementById('blBrush');
  const brushVal = document.getElementById('blBrushVal');
  if (brushSl) {
    brushSl.addEventListener('input', () => {
      bl.brushPx = parseInt(brushSl.value, 10);
      if (brushVal) brushVal.textContent = bl.brushPx;
      if (typeof _blRefreshCursor === 'function') _blRefreshCursor();
      if (typeof _blRefreshSummary === 'function') _blRefreshSummary();
    });
  }
  const radiusSl = document.getElementById('blRadius');
  const radiusVal = document.getElementById('blRadiusVal');
  if (radiusSl) {
    radiusSl.addEventListener('input', () => {
      bl.radius = parseInt(radiusSl.value, 10);
      if (radiusVal) radiusVal.textContent = bl.radius;
      blurCache = null;
      render();
      if (typeof _blRefreshSummary === 'function') _blRefreshSummary();
    });
    radiusSl.addEventListener('change', () => { _editPushUndo(); });
  }
  /* R54 — blApplyAll is now a circular icon (no textContent label). */
  const _blApplyAll = document.getElementById('blApplyAll');
  if (_blApplyAll) {
    _blApplyAll.addEventListener('click', () => {
      _editPushUndo();
      bl.full = !bl.full;
      _blApplyAll.classList.toggle('active', bl.full);
      _blApplyAll.setAttribute('aria-pressed', bl.full ? 'true' : 'false');
      _blApplyAll.title = bl.full ? 'Brush only' : 'Whole image';
      render();
      _updateEditHistoryUI();
    });
  }
  /* R54 — Clear replaced by Disable; guard null. */
  const _blClearBtn = document.getElementById('blClear');
  if (_blClearBtn) {
    _blClearBtn.addEventListener('click', () => {
      if (!bl.strokes.length && !bl.full) return;
      _editPushUndo();
      bl.strokes = [];
      bl.full = false;
      render();
      _updateEditHistoryUI();
    });
  }
}
async function _applyBlur(file, blurInfo){
  if (!blurInfo) return file;
  const hasStrokes = blurInfo.strokes && blurInfo.strokes.length;
  if (!hasStrokes && !blurInfo.full) return file;
  const bmp = await createImageBitmap(file);
  const W = bmp.width, H = bmp.height;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const radius = Math.max(1, blurInfo.radius | 0);
  /* Pre-render a fully blurred copy at full resolution. */
  const blurC = document.createElement('canvas');
  blurC.width = W; blurC.height = H;
  const bctx = blurC.getContext('2d');
  if (typeof bctx.filter !== 'undefined'){
    bctx.filter = 'blur(' + radius + 'px)';
    bctx.drawImage(bmp, 0, 0);
    bctx.filter = 'none';
  } else {
    /* Fallback for old Safari: scale-down then scale-up (pseudo-gaussian). */
    const k = Math.max(2, Math.floor(radius));
    const tw = Math.max(1, Math.floor(W / k));
    const th = Math.max(1, Math.floor(H / k));
    const tiny = document.createElement('canvas');
    tiny.width = tw; tiny.height = th;
    const tctx = tiny.getContext('2d');
    tctx.imageSmoothingEnabled = true;
    tctx.drawImage(bmp, 0, 0, tw, th);
    bctx.imageSmoothingEnabled = true;
    bctx.drawImage(tiny, 0, 0, tw, th, 0, 0, W, H);
  }
  /* Build mask at full resolution */
  const mask = document.createElement('canvas');
  mask.width = W; mask.height = H;
  const mctx = mask.getContext('2d');
  if (blurInfo.full){
    mctx.fillStyle = '#fff';
    mctx.fillRect(0, 0, W, H);
    /* respect erase strokes */
    (blurInfo.strokes || []).forEach(stk => {
      if (stk.mode !== 'erase') return;
      mctx.fillStyle = '#fff';
      mctx.strokeStyle = '#fff';
      mctx.globalCompositeOperation = 'destination-out';
      const minD = Math.min(W, H);
      for (let i = 0; i < stk.pts.length; i++){
        const p = stk.pts[i];
        const x = p.x * W, y = p.y * H, r = p.r * minD;
        mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
        if (i > 0){
          const prev = stk.pts[i-1];
          const px0 = prev.x * W, py0 = prev.y * H;
          mctx.lineWidth = r * 2; mctx.lineCap = 'round';
          mctx.beginPath(); mctx.moveTo(px0, py0); mctx.lineTo(x, y); mctx.stroke();
        }
      }
      mctx.globalCompositeOperation = 'source-over';
    });
  } else {
    (blurInfo.strokes || []).forEach(stk => {
      mctx.fillStyle = '#fff';
      mctx.strokeStyle = '#fff';
      mctx.globalCompositeOperation = (stk.mode === 'erase') ? 'destination-out' : 'source-over';
      const minD = Math.min(W, H);
      for (let i = 0; i < stk.pts.length; i++){
        const p = stk.pts[i];
        const x = p.x * W, y = p.y * H, r = p.r * minD;
        mctx.beginPath(); mctx.arc(x, y, r, 0, Math.PI * 2); mctx.fill();
        if (i > 0){
          const prev = stk.pts[i-1];
          const px0 = prev.x * W, py0 = prev.y * H;
          mctx.lineWidth = r * 2; mctx.lineCap = 'round';
          mctx.beginPath(); mctx.moveTo(px0, py0); mctx.lineTo(x, y); mctx.stroke();
        }
      }
      mctx.globalCompositeOperation = 'source-over';
    });
  }
  /* Composite: blurred-copy masked by mask, drawn on top of original. */
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const ttctx = tmp.getContext('2d');
  ttctx.drawImage(blurC, 0, 0);
  ttctx.globalCompositeOperation = 'destination-in';
  ttctx.drawImage(mask, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  try { bmp.close && bmp.close(); } catch(_){}
  const mime = (file.type === 'image/jpeg') ? 'image/jpeg' : 'image/png';
  return await new Promise((res, rej) => {
    canvas.toBlob(b => b ? res(b) : rej(new Error('blur encode failed')), mime, 0.95);
  });
}

/* ============================================================
   TEXT OVERLAY + WATERMARK (Round 7)
   - System-font stack only (zero new deps, zero license risk)
   - Canvas2D + Pointer Events
   - Stroke-then-fill for readable outlined captions
   - Snap-to-center guides at 6px tolerance
   - 9-anchor quick-position grid (corners + edges + center)
   - Image logo (watermark): FileReader -> dataURL, drawn via drawImage
   - Cited: MDN strokeText/fillText/CanvasRenderingContext2D, Canva default-text,
     WaterMarquee 30% watermark opacity, Adobe Express 9-anchor grid.
   ============================================================ */
const _TX_FONTS = [
  { label: 'Sans',     value: 'Arial, system-ui, sans-serif' },
  { label: 'Helvetica',value: 'Helvetica, Arial, sans-serif' },
  { label: 'Impact',   value: 'Impact, "Arial Black", sans-serif' },
  { label: 'Serif',    value: 'Georgia, "Times New Roman", serif' },
  { label: 'Mono',     value: '"Courier New", Courier, monospace' },
  { label: 'Verdana',  value: 'Verdana, Tahoma, sans-serif' },
  { label: 'Trebuchet',value: '"Trebuchet MS", Verdana, sans-serif' },
  { label: 'Comic',    value: '"Comic Sans MS", "Trebuchet MS", sans-serif' },
];







function piDelete(){
  const idx = CFLOW.selected;
  const f = FILES[idx];
  if (!f) return;
  try { URL.revokeObjectURL(f.url); } catch(_){}
  /* Drop encoded + multi-output bundles for this idx, then reindex
     remaining entries below. allEncoded is a parallel sidecar that also
     needs reindexing (was missed before this fix). */
  const e = ENCODE.encoded.get(idx);
  if (e) { try { URL.revokeObjectURL(e.url); } catch(_){} }
  ENCODE.encoded.delete(idx);
  const bundle = ENCODE.allEncoded.get(idx);
  if (bundle) { bundle.forEach(b => { try { URL.revokeObjectURL(b.url); } catch(_){} }); }
  ENCODE.allEncoded.delete(idx);
  /* shift down indices > idx */
  const newMap = new Map();
  ENCODE.encoded.forEach((v, k) => { if (k > idx) newMap.set(k - 1, v); else newMap.set(k, v); });
  ENCODE.encoded = newMap;
  FILES.splice(idx, 1);
  buildThumbs();
  if (FILES.length === 0) { setState('empty'); return; }
  if (CFLOW.selected >= FILES.length) CFLOW.selected = FILES.length - 1;
  if (CFLOW.selected < 0) CFLOW.selected = 0;
  /* If we deleted the last file, transition to empty state instead of
     leaving the workspace stuck with a stale CFLOW.selected. */
  if (FILES.length === 0) {
    setState('empty');
    return;
  }
  document.body.dataset.piActions = 'closed';
  /* Always use multi state when files exist. The solo state's legacy
     UI (pills + slider, no Multi toggle, no format/quality dropdowns)
     was a parallel-implementation branch that lost user config on
     state transition. Cover-flow handles a single thumb just fine. */
  document.body.dataset.state = 'multi';
  /* wireZoom is idempotent (data-zoomWired guard) so calling on every drop is safe */
  if (typeof wireZoom === 'function') wireZoom();
  layoutCoverFlow();
  CFLOW.prevSelected = -1;
  syncMainImage();
}


/* HOME_EDITOR_EOF */
