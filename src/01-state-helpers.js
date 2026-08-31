(function(){
"use strict";
function G(id){return document.getElementById(id);}

/* ========================================
   QUALITY HINT TEXT
   ======================================== */
var QUALITY_HINTS=[
  {max:55,text:'Smaller file with noticeable quality loss — good for thumbnails.'},
  {max:70,text:'Smaller file with some quality loss — good for web thumbnails.'},
  {max:89,text:'Great quality with significant file size savings.'},
  {max:99,text:'Near-lossless quality — minimal file size savings over original.'},
  {max:100,text:'Lossless mode — no quality loss, largest file size.'}
];
var QUALITY_HINTS_JPG=[
  {max:55,text:'Smaller file with noticeable quality loss — good for thumbnails.'},
  {max:70,text:'Smaller file with some quality loss — good for web thumbnails.'},
  {max:89,text:'Great quality with significant file size savings.'},
  {max:99,text:'High quality — minimal savings. JPG cannot be truly lossless.'},
  {max:100,text:'Max quality — JPG is always lossy by design, even at 100.'}
];
var QUALITY_HINTS_PNG=[
  {max:55,text:'PNG-8 with few colors — dramatic file size reduction, visible banding.'},
  {max:70,text:'PNG-8 with moderate colors — good savings, minor color shifts.'},
  {max:89,text:'PNG-8 with 256 colors — excellent balance of quality and file size.'},
  {max:99,text:'PNG-8 with 256 colors — near-original quality, still significantly smaller.'},
  {max:100,text:'Lossless PNG — every pixel preserved exactly, largest file size.'}
];
/* AVIF behaves quite differently from JPG — quality 50 in AVIF looks
   roughly comparable to quality 80 in JPG, so the same slider position
   means very different things. Calibrated copy lets users skip the
   "wait, why is q=82 already huge" surprise. */
var QUALITY_HINTS_AVIF=[
  {max:35,text:'Heavy AVIF compression — visible blur, very small files.'},
  {max:55,text:'AVIF sweet spot — typically half the size of JPG at the same visible quality.'},
  {max:75,text:'High-quality AVIF — savings narrow as quality rises.'},
  {max:99,text:'Near-lossless AVIF — minimal savings over the source.'},
  {max:100,text:'Lossless AVIF — files often larger than the lossy versions; AVIF is designed for lossy.'}
];
function getQualityHint(v,jpgOnly,pngOnly,avifOnly){
  var hints=avifOnly?QUALITY_HINTS_AVIF:(jpgOnly?QUALITY_HINTS_JPG:(pngOnly?QUALITY_HINTS_PNG:QUALITY_HINTS));
  for(var i=0;i<hints.length;i++){if(v<=hints[i].max)return hints[i].text;}
  return hints[hints.length-1].text;
}
function isJpgOnly(){var af=getActiveFormats();return af.length===1&&af[0]==='jpg';}
function isPngOnly(){var af=getActiveFormats();return af.length===1&&af[0]==='png';}
function isAvifOnly(){var af=getActiveFormats();return af.length===1&&af[0]==='avif';}
window.onQualityInput=function(v){
  G('qVal').textContent=v;
  var h=G('qualityHint');
  if(h)h.textContent=getQualityHint(parseInt(v),isJpgOnly(),isPngOnly(),isAvifOnly());
  /* Trigger the action-bar recompute so Reprocess can appear when the
     user drags the slider after a batch has already finished. The recompute
     compares live settings to the post-batch snapshot (_lastAppliedSettings)
     and shows Reprocess only when they differ. */
  if(typeof updateChargePreview==='function')updateChargePreview();
};

/* ========================================
   iOS DETECTION
   ======================================== */
var isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
/* Mobile detection used for AVIF speed warning (AVIF is CPU-heavy; mobile cores run it 3-6× slower) */
var isMobileDevice=isIOS||/Android/i.test(navigator.userAgent);

/* ========================================
   jsquash ENCODER HELPERS
   ======================================== */

function waitForEncoder(type){
  return new Promise(function(resolve,reject){
    var flag=type==='webp'?'_jsquashWebpReady':'_jsquashAvifReady';
    if(window[flag]){resolve();return;}
    var elapsed=0;
    var interval=setInterval(function(){
      elapsed+=100;
      if(window[flag]){clearInterval(interval);resolve();}
      else if(elapsed>=15000){clearInterval(interval);reject(new Error(type.toUpperCase()+' encoder failed to load'));}
    },100);
  });
}

async function encodeWithJsquash(canvas,fmt,quality){
  var ctx=canvas.getContext('2d');
  var imageData=ctx.getImageData(0,0,canvas.width,canvas.height);

  if(fmt==='webp'){
    await waitForEncoder('webp');
    var encode=window._jsquashWebpEncode;
    if(!encode)throw new Error('WebP encoder not available');
    var q=quality===undefined?82:Math.round(quality*100);
    var arrayBuf=await encode(imageData,{quality:q});
    return new Blob([arrayBuf],{type:'image/webp'});
  }

  if(fmt==='avif'){
    await waitForEncoder('avif');
    var encode=window._jsquashAvifEncode;
    if(!encode)throw new Error('AVIF encoder not available');
    var q=quality===undefined?50:Math.round(quality*100);
    var arrayBuf=await encode(imageData,{quality:q});
    return new Blob([arrayBuf],{type:'image/avif'});
  }

  throw new Error('encodeWithJsquash: unsupported format '+fmt);
}

/* ========================================
   STATE
   ======================================== */
/* Default = 'auto' so a fresh visitor lands at "drop and go" — input format is
   preserved (or promoted from HEIC/TIFF/BMP/SVG to a web equivalent). The
   format pill UI for picking a specific output lives in the Settings panel
   for users who want to convert deliberately. */
var selectedFormat='auto';
var selectedFormats=['auto'];
var multiOutputMode=false;
var images=[];
var libheifModule=null;
var currentCropRatio='none';
var CROP_RATIOS={'none':null,'1:1':1,'4:3':4/3,'3:4':3/4,'16:9':16/9,'9:16':9/16};
var LIBHEIF_URL='/vendor/libheif.js';
var FORMAT_INFO={
  auto:'Smart default — keep the input format. HEIC, TIFF and BMP become JPG; SVG becomes PNG.',
  webp:'Modern web standard — great quality, small files, all devices.',
  avif:'Best compression — high quality. Note: encoding takes longer than other formats.',
  png:'Optimized PNG — lossy at lower quality (PNG-8), lossless at 100.',
  jpg:'Universal — works everywhere, great for photos.',
  gif:'Simple animations and flat-colour graphics.',
  ico:'Multi-resolution Windows icon — for favicons and desktop icons. Auto-squares your image and packs the sizes you pick.'
};
var LOSSY_FORMATS={webp:true,avif:true,jpg:true};
var ALL_FMTS=['auto','webp','avif','png','jpg','gif','ico'];

/* Smart per-input format mapping for 'auto' mode.
   Web formats are preserved (re-encoded smaller in their own format); non-web
   formats are promoted to a useful web equivalent so the result is shareable
   on any platform. Quietly applies — the result row labels the change as
   "Converted to JPG" so the user isn't surprised. */
function pickAutoFormat(file){
  if(!file)return 'jpg';
  var t=file.type||'';
  var e=getFileExt(file.name);
  if(t==='image/jpeg'||e==='jpg'||e==='jpeg')return 'jpg';
  if(t==='image/png'||e==='png')return 'png';
  if(t==='image/webp'||e==='webp')return 'webp';
  if(t==='image/avif'||e==='avif')return 'avif';
  if(t==='image/gif'||e==='gif')return 'gif';
  if(e==='svg'||t==='image/svg+xml')return 'png'; /* rasterise SVG to PNG */
  /* HEIC, HEIF, TIFF, BMP, anything else exotic → JPG (universal). */
  return 'jpg';
}
var AVIF_SLOW_THRESHOLD=3000;

/* ========================================
   PLATFORM PRESETS
   ======================================== */
var PRESETS={
  'custom':{maxDim:'',crop:'none'},
  'ig-post':{maxDim:1080,crop:'1:1'},
  'ig-story':{maxDim:1080,crop:'9:16'},
  'yt-thumb':{maxDim:1280,crop:'16:9'},
  'twitter':{maxDim:1200,crop:'16:9'},
  'email':{maxDim:600,crop:'none'}
};
window.applyPreset=function(key){
  var p=PRESETS[key];if(!p)return;
  var r=G('resizeMax');if(r)r.value=p.maxDim;
  /* Presets are dimension-based; switch the mode back to dim when a
     preset fires so the value the user sees matches what will apply. */
  var rm=G('resizeMode');if(rm)rm.value='dim';
  if(typeof setResizeMode==='function')setResizeMode('dim');
  setCropRatio(p.crop);
  /* Surface Reprocess if a batch has already been processed and the
     preset shifts the resize/crop away from what was applied. */
  if(typeof updateChargePreview==='function')updateChargePreview();
};

/* Live Photo extraction state. Persisted to localStorage so power
   users don't have to re-tick the box every visit. The toggle is
   read at encode-time via livePhotoExtractEnabled() — that way late
   changes during a session pick up immediately without rebinding. */
window.onLivePhotoToggle=function(checked){
  try{localStorage.setItem('imgready_lp_extract', checked?'1':'0');}catch(_){}
  /* Surface Reprocess if a batch has already been processed and this
     change would re-encode (or extract videos that were skipped). */
  if(typeof updateChargePreview==='function')updateChargePreview();
  /* Re-render cards so the Live Photo chip's active state updates
     immediately ("Live Photo" → "Live Photo · MP4" or back). Cards
     without item.livePhoto are unaffected because the chip builder
     returns empty for them. */
  if(typeof renderAll==='function')renderAll();
};
function livePhotoExtractEnabled(){
  var el=G('livePhotoExtract');
  return el ? !!el.checked : false;
}
/* Restore toggle state on first load. Runs after DOM is ready since
   the checkbox itself is in HTML; the IIFE pattern below mirrors how
   other persisted prefs (settings panel open state) are restored. */
(function(){
  try{
    var saved=localStorage.getItem('imgready_lp_extract');
    if(saved==='1'){
      var el=G('livePhotoExtract');
      if(el) el.checked=true;
    }
  }catch(_){}
})();
function resetPresetToCustom(){
  var s=G('presetSelect');if(s&&s.value!=='custom')s.value='custom';
}

/* ========================================
   UPNG.js — PNG QUANTIZATION (LOSSY PNG-8)
   ======================================== */
function qualityToColorCount(q){
  if(q>=1.0)return 0;
  if(q>=0.85)return 256;
  if(q>=0.70)return 128;
  if(q>=0.55)return 64;
  if(q>=0.40)return 32;
  return 16;
}
function encodeWithUPNG(canvas,quality){
  var ctx=canvas.getContext('2d');
  var imageData=ctx.getImageData(0,0,canvas.width,canvas.height);
  var rgbaBuffer=imageData.data.buffer;
  var cnum=qualityToColorCount(quality);
  var pngArrayBuf=UPNG.encode([rgbaBuffer],canvas.width,canvas.height,cnum);
  return new Blob([pngArrayBuf],{type:'image/png'});
}

/* ========================================
   CLEAR ALL — TWO-STEP CONFIRMATION
   ======================================== */
var clearConfirmTimer=null;
window.clearAllClick=function(){
  var btn=G('clearBtn');
  /* Cancel mode: if we're in the middle of a batch, the button reads "Cancel" */
  if(btn.dataset.mode==='cancel'){
    _processingCancelled=true;
    btn.disabled=true;btn.textContent='Cancelling…';
    /* Hard-stop in-flight worker encodes — without this, AVIF on a big
       photo could keep the user staring at "Cancelling…" for 10–15 s.
       cancelAll terminates the workers, rejects every pending promise
       with the 'Cancelled' sentinel, and nulls out the pool so the next
       processAll call lazily spawns a fresh set. Wrapped in try because
       _workerPool may legitimately be null (e.g. on a main-thread-only
       fallback path) and we don't want to break the cancel UX. */
    try { if(_workerPool && _workerPool.cancelAll) _workerPool.cancelAll(); } catch(_){}
    /* Mirror the state on the Process button so the user gets immediate
       feedback. With worker cancellation the loop now sees `_processingCancelled`
       within a tick or two of the workers' rejection — so 'Cancelling…' is
       brief, not the multi-second pause it used to be. */
    var pb=G('processBtn');
    if(pb){pb.textContent='Cancelling…';pb.disabled=true;}
    return;
  }
  if(btn.dataset.confirm==='1'){
    clearTimeout(clearConfirmTimer);
    btn.dataset.confirm='0';
    btn.textContent='Clear All';
    /* Revoke every ObjectURL we hold before zeroing the array. Clearing 100
       processed images × 5 formats = 500+ leaked URLs without this. */
    for(var ii=0;ii<images.length;ii++){
      var it=images[ii];
      if(it.origUrl)URL.revokeObjectURL(it.origUrl);
      for(var jj=0;jj<it.results.length;jj++){
        /* _releaseNamedResultURL handles both named-URL (SW release-blob)
           and plain blob URL (URL.revokeObjectURL) cases. */
        _releaseNamedResultURL(it.results[jj]);
      }
    }
    images.length=0;
    renderAll();
    return;
  }
  btn.dataset.confirm='1';
  btn.textContent='Are you sure?';
  clearConfirmTimer=setTimeout(function(){
    if(btn.dataset.confirm==='1'){
      btn.dataset.confirm='0';
      btn.textContent='Clear All';
    }
  },3000);
};

/* ========================================
   TIP NUDGE — dynamic messaging
   ======================================== */
var NUDGE_MB_THRESHOLD=5*1048576;
var NUDGE_COUNT_THRESHOLD=20;

function maybeShowNudge(){
  try{if(localStorage.getItem('imgready_nudge_shown')==='true')return;}catch(e){}
  var saved=0,count=0;
  for(var i=0;i<images.length;i++){
    var hasBlob=false;
    for(var j=0;j<images[i].results.length;j++){
      var r=images[i].results[j];
      if(r.blob){saved+=Math.max(0,images[i].file.size-r.blob.size);hasBlob=true;}
    }
    if(hasBlob)count++;
  }
  var bigSave=saved>=NUDGE_MB_THRESHOLD;
  var bigCount=count>=NUDGE_COUNT_THRESHOLD;
  if(!bigSave&&!bigCount)return;
  var savedStr=saved>1048576?(saved/1048576).toFixed(1)+' MB':(Math.round(saved/1024))+' KB';
  var msg='';
  var kofi='<a href="https://ko-fi.com/imgready" target="_blank" rel="noopener">buy me a coffee ♥</a>';
  if(bigSave&&bigCount){msg=count+' images, <strong>'+savedStr+'</strong> saved — all without touching a server. If imgready helped, '+kofi;}
  else if(bigSave){msg='You just saved <strong>'+savedStr+'</strong> — that\'s real bandwidth. imgready is free and always will be. '+kofi+' if it helped.';}
  else{msg='You just blasted through <strong>'+count+' images</strong> — all processed locally. If imgready saved you time, '+kofi;}
  var txt=G('nudgeText');
  if(txt)txt.innerHTML=msg;
  setTimeout(function(){
    var b=G('nudgeBanner');if(b)b.classList.add('show');
    try{localStorage.setItem('imgready_nudge_shown','true');}catch(e){}
  },800);
}
window.dismissNudge=function(){var b=G('nudgeBanner');if(b)b.classList.remove('show');};

/* ========================================
   BOOKMARK TIP — replaces PWA install prompt.
   Shown once after first successful run.
   Native beforeinstallprompt is suppressed.
   ======================================== */
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();});
window.dismissInstall=function(){
  var b=G('installBanner');if(b)b.classList.remove('show');
  try{localStorage.setItem('imgready_bk_shown','true');}catch(e){}
};
window.maybeShowInstallPrompt=function(){
  try{if(localStorage.getItem('imgready_bk_shown')==='true')return;}catch(e){}
  setTimeout(function(){var b=G('installBanner');if(b)b.classList.add('show');},1200);
};

/* ========================================
   TIP JAR MODAL
   ======================================== */
window.openSupModal=function(){G('supModalOverlay').classList.add('show');};
window.closeSupModal=function(){G('supModalOverlay').classList.remove('show');};

/* ========================================
   MULTI-FORMAT
   ======================================== */
window.handleMultiOutputToggle=function(){
  multiOutputMode=G('multiOutputCheck').checked;
  if(!multiOutputMode){selectedFormats=[selectedFormat];}
  /* Visual signal: body class makes format buttons render as checkboxes,
     toggle wrap gets the active treatment */
  document.body.classList.toggle('multi-mode',multiOutputMode);
  var wrap=G('multiOutputWrap');if(wrap)wrap.classList.toggle('on',multiOutputMode);
  updateFormatUI();
};

/* ========================================
   FORMAT SELECTION
   ======================================== */
window.selectFormat=function(f){
  /* 'auto' is mutually exclusive with multi-format. Picking Auto switches
     multi-format off; picking any specific format while multi-format is on
     toggles selection on that format only (Auto isn't a "format" you can mix
     with WebP+AVIF). */
  if(f==='auto'){
    multiOutputMode=false;
    var mc=G('multiOutputCheck');if(mc)mc.checked=false;
    document.body.classList.remove('multi-mode');
    var wrap=G('multiOutputWrap');if(wrap)wrap.classList.remove('on');
    selectedFormat='auto';
    selectedFormats=['auto'];
    updateFormatUI();
    return;
  }
  if(multiOutputMode){
    /* Switching from auto to a specific format in multi mode — drop auto. */
    if(selectedFormats.length===1&&selectedFormats[0]==='auto'){selectedFormats=[];}
    var idx=selectedFormats.indexOf(f);
    if(idx===-1){selectedFormats.push(f);}
    else if(selectedFormats.length>1){selectedFormats.splice(idx,1);}
    selectedFormat=f;
  } else {
    selectedFormat=f;
    selectedFormats=[f];
  }
  /* Body class drives ICO-only UI (size-set dropdown). The CSS rule
     body.fmt-ico .adv-group-ico { display: flex } toggles visibility. */
  document.body.classList.toggle('fmt-ico', f==='ico');
  updateFormatUI();
};

/* ICO size set state. Default = favicon (16/32/48). User can switch
   to "Full Windows" or "Custom"; Custom reveals individual checkboxes
   and the user picks any combination. Reads back via getIcoSizes(). */
window.applyIcoSizeSet=function(value){
  var grp=G('adv-group-ico');
  if(!grp)return;
  var checks=grp.querySelectorAll('.ico-size-checks input[type=checkbox]');
  if(value==='favicon'){
    grp.classList.remove('show-custom');
    checks.forEach(function(cb){
      var s=parseInt(cb.dataset.size,10);
      cb.checked = (s===16 || s===32 || s===48);
    });
  } else if(value==='windows'){
    grp.classList.remove('show-custom');
    checks.forEach(function(cb){cb.checked=true;});
  } else { /* custom */
    grp.classList.add('show-custom');
    /* Leave checkbox state as-is so user keeps their last selection. */
  }
};

function getIcoSizes(){
  var grp=G('adv-group-ico');if(!grp)return [16,32,48]; /* fallback */
  var sizes=[];
  grp.querySelectorAll('.ico-size-checks input[type=checkbox]').forEach(function(cb){
    if(cb.checked) sizes.push(parseInt(cb.dataset.size,10));
  });
  /* Sanity: if user unchecked everything, fall back to favicon set so we
     never produce a 0-entry ICO file. */
  if(!sizes.length) sizes=[16,32,48];
  return sizes.sort(function(a,b){return a-b;});
}
function getActiveFormats(){
  return multiOutputMode?selectedFormats:[selectedFormat];
}
/* Resolve an "active format" string to a concrete output format for a given
   input file. Specific formats pass through untouched; 'auto' resolves to
   the smart-mapped format (preserve web formats, promote others). Used by
   the encoding loop to handle 'auto' uniformly with the explicit cases. */
function resolveFormatForFile(activeFmt,file){
  return activeFmt==='auto'?pickAutoFormat(file):activeFmt;
}
function updateFormatUI(){
  for(var i=0;i<ALL_FMTS.length;i++){
    var b=G('btn'+ALL_FMTS[i].charAt(0).toUpperCase()+ALL_FMTS[i].slice(1));
    if(!b)continue;
    if(multiOutputMode){b.classList.toggle('active',selectedFormats.indexOf(ALL_FMTS[i])!==-1);}
    else{b.classList.toggle('active',ALL_FMTS[i]===selectedFormat);}
  }
  var tl=G('fmtTagline');
  if(tl){
    var active=getActiveFormats();
    /* On mobile, AVIF encodes 3-6× slower than desktop — warn proactively so users
       aren't left wondering if the app is frozen. Show before they hit Process. */
    var mobileAvifWarn=(active.indexOf('avif')!==-1&&isMobileDevice)
      ?' <span style="color:var(--warn);font-style:normal;font-weight:600;font-size:.76rem;">Mobile tip: AVIF takes 15–30s per image — try WebP for speed.</span>'
      :'';
    if(active.length===1){tl.innerHTML='<span style="font-style:italic">'+FORMAT_INFO[active[0]]+'</span>'+mobileAvifWarn;}
    else{tl.innerHTML=(active.length+' formats selected — each image will produce '+active.length+' outputs.')+mobileAvifWarn;}
  }
  /* Update count badge next to Multi-format toggle */
  var moc=G('moCount');if(moc)moc.textContent=getActiveFormats().length;
  var anyLossy=false;
  var onlyGif=true;
  var af=getActiveFormats();
  for(var j=0;j<af.length;j++){if(LOSSY_FORMATS[af[j]]||af[j]==='png'){anyLossy=true;}if(af[j]!=='gif')onlyGif=false;}
  var qg=G('qualityGroup'),qh=G('qualityHint');
  if(qg)qg.classList.toggle('disabled-group',onlyGif);
  if(qh){
    if(onlyGif){qh.textContent='GIF uses a fixed 256-color palette — quality slider has no effect.';}
    else{qh.textContent=getQualityHint(parseInt((G('qualitySlider')||{value:82}).value),isJpgOnly(),isPngOnly(),isAvifOnly());}
  }
  updateChargePreview();
}
/* Mobile hamburger nav. The dropdown menu has class `.open` toggled.
   Closes on Escape and on click outside. Desktop never sees the menu —
   .nav-links uses display:contents and hamburger is display:none. */
window.toggleNavMenu=function(){
  var menu=G('navMenu'),btn=G('navHamburger');
  if(!menu||!btn)return;
  var open=menu.classList.toggle('open');
  btn.setAttribute('aria-expanded',open?'true':'false');
};
window.closeNavMenu=function(){
  var menu=G('navMenu'),btn=G('navHamburger');
  if(!menu||!btn)return;
  menu.classList.remove('open');
  btn.setAttribute('aria-expanded','false');
};
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    var menu=G('navMenu');
    if(menu&&menu.classList.contains('open')){closeNavMenu();}
  }
});
document.addEventListener('click',function(e){
  var menu=G('navMenu'),btn=G('navHamburger');
  if(!menu||!btn||!menu.classList.contains('open'))return;
  /* Click inside the menu container or on the hamburger itself: ignore.
     Anywhere else: close the menu so a tap outside dismisses cleanly. */
  if(menu.contains(e.target)||btn.contains(e.target))return;
  closeNavMenu();
});

/* Resize mode toggle. The single Resize input swaps semantic between
   "longest side in pixels" (capped at 8000) and "percent of original"
   (capped at 100). The placeholder + min/max attributes change with
   the mode so the input self-documents. Persisted via localStorage so
   returning users see their preferred mode. */
window.setResizeMode=function(mode){
  if(mode!=='dim'&&mode!=='pct')mode='dim';
  var input=G('resizeMax');
  var hint=G('resizeHint');
  var sel=G('resizeMode');
  if(sel&&sel.value!==mode)sel.value=mode;
  if(input){
    if(mode==='pct'){
      input.placeholder='e.g. 50';
      input.min='1'; input.max='100';
      /* Cap the existing value at 100 if it was a px value */
      var v=parseInt(input.value)||0;
      if(v>100)input.value=100;
    } else {
      input.placeholder='e.g. 1200';
      input.min='10'; input.max='8000';
    }
  }
  if(hint){
    hint.textContent=mode==='pct'
      ? 'Scale to a percentage of the original size. Aspect ratio preserved.'
      : 'Aspect ratio is always preserved.';
  }
  try{localStorage.setItem('imgready_resize_mode',mode);}catch(_){}
  if(typeof updateChargePreview==='function')updateChargePreview();
};
/* Restore the persisted resize mode on load. */
(function restoreResizeMode(){
  try{
    var saved=localStorage.getItem('imgready_resize_mode');
    if(saved==='dim'||saved==='pct')window.setResizeMode(saved);
  }catch(_){}
})();

window.toggleAdvanced=function(){
  var t=G('advToggle'),p=G('advPanel');
  if(t)t.classList.toggle('open');
  if(p)p.classList.toggle('open');
  /* Sync aria-expanded for screen readers */
  var open=p&&p.classList.contains('open');
  if(t)t.setAttribute('aria-expanded',open?'true':'false');
  /* Remember the user's preference between visits */
  try{
    localStorage.setItem('imgready_settings_open',open?'1':'0');
    /* Also clear the first-visit pulse after first interaction */
    localStorage.setItem('imgready_seen_settings','1');
    if(t)t.classList.remove('pulse');
  }catch(e){}
};
/* Restore Settings panel state. First-visit policy: keep the panel CLOSED
   so the dropzone is the unambiguous focal point on first paint. The
   earlier auto-open default looked discoverable in isolation but in mobile
   viewport tests it pushed the dropzone below the fold — bad trade. To
   keep discoverability we add a one-time `pulse` class to the Settings
   toggle on first visit; the pulse is removed the first time the user
   opens the panel (or after a few seconds, whichever comes first). */
(function restoreSettingsPanel(){
  try{
    var saved=localStorage.getItem('imgready_settings_open');
    var seen=localStorage.getItem('imgready_seen_settings');
    var t=G('advToggle'),p=G('advPanel');
    if(saved==='1'){
      if(t){t.classList.add('open');t.setAttribute('aria-expanded','true');}
      if(p)p.classList.add('open');
    } else if(seen===null){
      /* First-time visitor — pulse the Settings button so they notice
         the panel exists without us forcing it open. */
      if(t)t.classList.add('pulse');
      /* Auto-stop the pulse after 8s so it never feels naggy. */
      setTimeout(function(){ if(t)t.classList.remove('pulse'); },8000);
    }
  }catch(e){}
})();

/* ========================================
   CROP
   ======================================== */
window.setCropRatio=function(r){
  currentCropRatio=r;
  var btns=G('cropToggle');
  if(btns){var bs=btns.getElementsByTagName('button');for(var i=0;i<bs.length;i++){var txt=bs[i].textContent;bs[i].classList.toggle('active',(r==='none'&&txt==='None')||txt===r);}}
  renderAll();
};

/* ========================================
   SETTINGS
   ======================================== */
function getSettings(fmt){
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
  /* R136 — pass a size ceiling through when the page/URL asked for one.
     The worker binary-searches quality and returns the best result at or
     under targetKb (WebP/AVIF/JPG only; PNG and GIF have no quality dial). */
  var tkb=parseInt(window.__IMGREADY_TARGET_KB||0,10)||0;
  var out={mime:mimeMap[fmt]||'image/webp',quality:fmt==='gif'?undefined:q,maxDim:maxDim,resizePct:resizePct,stripExif:stripExif};
  if(tkb>0&&(fmt==='webp'||fmt==='avif'||fmt==='jpg')) out.targetKb=tkb;
  /* R143 — exact output dimensions when the page/URL asked for them. */
  var exW=parseInt((window.__IMGREADY_EXACT||{}).w||0,10)||0;
  var exH=parseInt((window.__IMGREADY_EXACT||{}).h||0,10)||0;
  if(exW>0&&exH>0){ out.exactW=exW; out.exactH=exH; }
  return out;
}

/* ========================================
   JPEG quality estimation
   ----------------------------------------
   Parse the source JPG's quantization table to estimate the quality it was
   encoded at. We use this to pick a target quality below the source so the
   output is *guaranteed* smaller than the input — the alternative (re-encode
   at the user's default 82) frequently grows already-optimised CDN images
   because every JPG decode adds 8×8-block "noise" the next encoder spends
   bits preserving.

   Approach: at quality 50, libjpeg uses the standard luminance quant table
   below. For other qualities Q, every table entry is scaled by
     scale = (200 - 2Q) / 100   (when Q > 50)
   so a back-of-envelope estimate is `Q ≈ 100 - 50 * (T[i] / STD[i])` averaged
   across non-zero entries. Not exact (encoders round/clamp differently), but
   accurate to within ±5 for any standard JPG — plenty for "encode lower".
   ======================================== */
var _STD_LUMA_Q50=[
  16,11,10,16,24,40,51,61,
  12,12,14,19,26,58,60,55,
  14,13,16,24,40,57,69,56,
  14,17,22,29,51,87,80,62,
  18,22,37,56,68,109,103,77,
  24,35,55,64,81,104,113,92,
  49,64,78,87,103,121,120,101,
  72,92,95,98,112,100,103,99
];
function estimateJpegQuality(buf){
  if(!buf||buf.length<4||buf[0]!==0xFF||buf[1]!==0xD8)return null;
  var i=2;
  while(i<buf.length-3){
    if(buf[i]!==0xFF){i++;continue;}
    /* Skip fill bytes */
    while(i<buf.length&&buf[i]===0xFF)i++;
    var marker=buf[i++];
    if(marker===0xD8||marker===0xD9)continue;       /* SOI / EOI */
    if(marker>=0xD0&&marker<=0xD7)continue;         /* RST */
    if(i+2>buf.length)return null;
    var segLen=(buf[i]<<8)|buf[i+1];
    if(segLen<2||i+segLen>buf.length)return null;
    if(marker===0xDB){
      /* DQT — one or more quant tables */
      var segEnd=i+segLen,p=i+2;
      while(p<segEnd){
        var pqTq=buf[p++];
        var precision=(pqTq>>4)===1?2:1;
        var tableId=pqTq&0x0F;
        var entries=64;
        if(tableId===0&&precision===1&&p+entries<=segEnd){
          /* Luminance table, 8-bit precision — what we want */
          var sum=0,n=0;
          for(var j=0;j<entries;j++){
            var v=buf[p+j],s=_STD_LUMA_Q50[j];
            if(v>0&&s>0){sum+=v/s;n++;}
          }
          if(!n)return null;
          var avgScale=sum/n;
          var q=avgScale<=1?(100-50*avgScale):(50/avgScale);
          return Math.max(1,Math.min(100,Math.round(q)));
        }
        p+=entries*precision;
      }
    }
    i+=segLen;
  }
  return null;
}

/* Compute the actual quality we'll feed to the JPG encoder for a given input.
   When the input is itself a JPG, target one notch below the estimated source
   quality so the output reliably shrinks. If the user has explicitly lowered
   their slider below that target, respect their choice — don't force them
   to upscale quality. */
async function adjustJpgQualityForSource(file,userQuality){
  if(!file||file.type!=='image/jpeg')return userQuality;
  try{
    /* DQT lives near the start of the file — first 64 KB is more than enough. */
    var head=await file.slice(0,65536).arrayBuffer();
    var sourceQ=estimateJpegQuality(new Uint8Array(head));
    if(sourceQ==null)return userQuality;
    /* Target = source - 5. Floor at 0.4 (40) to avoid producing visibly
       awful output if the source was already aggressively compressed. */
    var target=Math.max(0.4,(sourceQ-5)/100);
    return Math.min(userQuality,target);
  }catch(_){
    return userQuality;
  }
}
/* Persist EXIF when stripExif is OFF: copy original APP1 segments (JPEG only) into the
   re-encoded output so GPS/camera info is preserved on the user's request. */
async function preserveExifIntoBlob(originalFile,outBlob){
  if(!originalFile||!outBlob)return outBlob;
  if(outBlob.type!=='image/jpeg')return outBlob;
  if(originalFile.type!=='image/jpeg')return outBlob;
  try{
    var origBuf=new Uint8Array(await originalFile.arrayBuffer());
    if(origBuf[0]!==0xFF||origBuf[1]!==0xD8)return outBlob;
    /* Find the EXIF (APP1) segment in the original */
    var p=2,exif=null;
    while(p<origBuf.length-1){
      if(origBuf[p]!==0xFF)break;
      var marker=origBuf[p+1];
      if(marker===0xE1){
        var len=(origBuf[p+2]<<8)|origBuf[p+3];
        exif=origBuf.subarray(p,p+2+len);break;
      }
      if(marker===0xDA||marker===0xD9)break;
      var seglen=(origBuf[p+2]<<8)|origBuf[p+3];
      p+=2+seglen;
    }
    if(!exif)return outBlob;
    var outBuf=new Uint8Array(await outBlob.arrayBuffer());
    if(outBuf[0]!==0xFF||outBuf[1]!==0xD8)return outBlob;
    /* Insert EXIF right after SOI in the new file */
    var combined=new Uint8Array(outBuf.length+exif.length);
    combined.set(outBuf.subarray(0,2),0);
    combined.set(exif,2);
    combined.set(outBuf.subarray(2),2+exif.length);
    return new Blob([combined],{type:'image/jpeg'});
  }catch(e){return outBlob;}
}

/* ========================================
   END OF CHUNK 01 — file helpers continue in 02
   ======================================== */
/* CHUNK_END:01-state-helpers v1 */
