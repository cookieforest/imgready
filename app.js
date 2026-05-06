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
function getQualityHint(v,jpgOnly,pngOnly){
  var hints=jpgOnly?QUALITY_HINTS_JPG:pngOnly?QUALITY_HINTS_PNG:QUALITY_HINTS;
  for(var i=0;i<hints.length;i++){if(v<=hints[i].max)return hints[i].text;}
  return hints[hints.length-1].text;
}
function isJpgOnly(){var af=getActiveFormats();return af.length===1&&af[0]==='jpg';}
function isPngOnly(){var af=getActiveFormats();return af.length===1&&af[0]==='png';}
window.onQualityInput=function(v){
  G('qVal').textContent=v;
  var h=G('qualityHint');
  if(h)h.textContent=getQualityHint(parseInt(v),isJpgOnly(),isPngOnly());
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
    else{qh.textContent=getQualityHint(parseInt((G('qualitySlider')||{value:82}).value),isJpgOnly(),isPngOnly());}
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
/* Restore Settings panel state. First-visit policy: open the panel by
   default so visitors discover format/quality/resize without hunting.
   Detection: imgready_seen_settings is set the first time toggleAdvanced
   runs, so if it's missing we know the user has never interacted with
   the panel — open it for them. After their first toggle, respect the
   explicit imgready_settings_open preference and never auto-open again. */
(function restoreSettingsPanel(){
  try{
    var saved=localStorage.getItem('imgready_settings_open');
    var seen=localStorage.getItem('imgready_seen_settings');
    var shouldOpen = (saved==='1') || (saved===null && seen===null);
    if(shouldOpen){
      var t=G('advToggle'),p=G('advPanel');
      if(t){t.classList.add('open');t.setAttribute('aria-expanded','true');}
      if(p)p.classList.add('open');
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
  var maxDim=parseInt((G('resizeMax')||{}).value)||0;
  var stripExifEl=G('stripExif');
  var stripExif=stripExifEl?!!stripExifEl.checked:true;
  var mimeMap={webp:'image/webp',avif:'image/avif',png:'image/png',jpg:'image/jpeg',gif:'image/gif'};
  return{mime:mimeMap[fmt]||'image/webp',quality:fmt==='gif'?undefined:q,maxDim:maxDim,stripExif:stripExif};
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
   FILE HELPERS
   ======================================== */
function getFileExt(n){return(n||'').split('.').pop().toLowerCase();}
function isHeic(f){var e=getFileExt(f.name);return e==='heic'||e==='heif'||f.type==='image/heic'||f.type==='image/heif';}
function isTiff(f){var e=getFileExt(f.name);return e==='tif'||e==='tiff'||f.type==='image/tiff';}
function isSvg(f){var e=getFileExt(f.name);return e==='svg'||f.type==='image/svg+xml';}
function isIco(f){var e=getFileExt(f.name);return e==='ico'||f.type==='image/x-icon'||f.type==='image/vnd.microsoft.icon';}

/* ============================================================
   LIVE PHOTO — HEIF box parser + detection
   ============================================================
   Apple Live Photos store a 3-second MOV alongside the still inside
   the HEIF container. iOS appends the MOV after the HEIC's mdat as a
   complete movie file (its own ftyp + moov + mdat). So a HEIC with a
   second top-level 'ftyp' box past offset 0 is reliably a Live Photo,
   and the MOV bytes run from that offset to EOF.

   This skips the more complex meta/iref/iloc parser path that would
   handle item-style Live Photos (rare in iOS 12+) and the modern
   "isomorphic" HEIF item structure used by some non-Apple cameras.
   The append-after-mdat pattern covers the iPhone/iPad audience —
   which is who has Live Photos to extract in the first place.

   The MOV bytes can be wrapped as `video/mp4` directly — the QuickTime
   .mov container shares enough structure with .mp4 that browsers and
   apps play either. We keep the .mp4 extension (more universal) and
   the bytes as-is. */

function _readU32BE(buf, offset){
  return (buf[offset]<<24>>>0) + (buf[offset+1]<<16) + (buf[offset+2]<<8) + buf[offset+3];
}
function _readU64BE(buf, offset){
  /* 64-bit big-endian read, returns a Number (loses precision past 2^53
     but real Live Photo MOVs are << 2GB so this is fine). */
  var hi=_readU32BE(buf, offset);
  var lo=_readU32BE(buf, offset+4);
  return hi*4294967296 + lo;
}
function _readBoxType(buf, offset){
  return String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3]);
}

async function detectLivePhotoVideo(file){
  /* Returns {offset, length} if the file appears to contain an Apple
     Live Photo MOV appended after the HEIC, or null otherwise.
     Reads the whole file into memory — Live Photos are typically
     <10 MB so this is cheap; the alternative (Range fetches) doesn't
     work for blob inputs anyway. */
  if(!isHeic(file)) return null;
  try {
    var buf=new Uint8Array(await file.arrayBuffer());
    if(buf.byteLength < 16) return null;

    /* Walk top-level boxes. Each box: 4-byte size + 4-byte type + payload.
       size===1 means real size is in the next 8 bytes. size===0 means
       box extends to EOF. */
    var offset=0;
    var foundFirstFtyp=false;
    while(offset + 8 <= buf.byteLength){
      var size=_readU32BE(buf, offset);
      var type=_readBoxType(buf, offset+4);
      var actualSize=size;
      if(size===1){
        if(offset+16 > buf.byteLength) break;
        actualSize=_readU64BE(buf, offset+8);
      } else if(size===0){
        actualSize=buf.byteLength-offset;
      }
      /* Sanity: refuse boxes that claim impossible sizes. */
      if(actualSize<8 || actualSize > buf.byteLength-offset) break;

      if(type==='ftyp'){
        if(foundFirstFtyp){
          /* Second ftyp = Live Photo MOV. Length runs from this offset
             to EOF — Apple appends the MOV as the final top-level
             content, no boxes after it. */
          return { offset: offset, length: buf.byteLength - offset };
        }
        foundFirstFtyp=true;
      }

      offset += actualSize;
    }
    return null;
  } catch(err){
    /* Any parse failure means we fall back gracefully — still encodes
       normally, video isn't extracted. The user sees the JPG output
       and never knows there might have been a video to find. */
    console.warn('[imgready] Live Photo detection failed:', err);
    return null;
  }
}

/* ============================================================
   ICO encoder + decoder (multi-resolution PNG-packed)
   ============================================================
   ICO is a container: one file holds N image entries at different
   resolutions. Modern Windows accepts PNG-encoded entries (Vista+,
   2007), which compress dramatically better than the older raw-BMP
   approach. We always emit PNG entries.

   Encoder: take a source canvas, auto-square via center-crop, generate
   a PNG-encoded entry for each requested size, pack into an ICO binary.
   Sizes larger than the source are skipped (avoids upscaling blur).

   Decoder: parse the ICO directory, find the largest entry, extract
   the entry bytes. PNG entries decode via createImageBitmap; older
   BMP entries throw a clear error (could be added later). 99% of
   modern .ico files in the wild are PNG-encoded.

   Both run on the main thread — ICO files are tiny (a few KB) and the
   work is canvas-based, so worker round-trips would be wasteful. */

async function encodeICO(sourceCanvas, sizes){
  if(!sizes||!sizes.length) sizes=[16,32,48];
  /* Auto-square the source via center-crop. ICO entries are always
     square; rendering a 4:3 photo as a square icon would distort. */
  var srcW=sourceCanvas.width, srcH=sourceCanvas.height;
  var minDim=Math.min(srcW, srcH);
  var sqCanvas=document.createElement('canvas');
  sqCanvas.width=minDim; sqCanvas.height=minDim;
  var sqCtx=sqCanvas.getContext('2d');
  sqCtx.drawImage(sourceCanvas,
    Math.floor((srcW-minDim)/2), Math.floor((srcH-minDim)/2), minDim, minDim,
    0, 0, minDim, minDim);

  /* Skip sizes larger than the squared source — upscaling icons looks
     worse than missing a size. The card-level note tells the user. */
  var validSizes=sizes.filter(function(s){return s<=minDim;});
  var skippedSizes=sizes.filter(function(s){return s>minDim;});
  if(!validSizes.length){
    /* Source is smaller than every requested size. Use the source size
       as the only entry rather than failing. */
    validSizes=[minDim];
  }

  /* For each valid size, downscale + PNG-encode. */
  var pngEntries=[];
  for(var i=0;i<validSizes.length;i++){
    var size=validSizes[i];
    var c=document.createElement('canvas');
    c.width=size; c.height=size;
    var ctx=c.getContext('2d');
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality='high';
    ctx.drawImage(sqCanvas, 0, 0, size, size);
    var pngBlob=await new Promise(function(resolve,reject){
      c.toBlob(function(b){b?resolve(b):reject(new Error('PNG encode failed'));},'image/png');
    });
    var bytes=new Uint8Array(await pngBlob.arrayBuffer());
    pngEntries.push({size:size, bytes:bytes});
  }

  /* Pack into ICO binary. Header (6 bytes) + N directory entries
     (16 bytes each) + concatenated PNG data. */
  var headerSize=6, entrySize=16;
  var dirSize=pngEntries.length*entrySize;
  var dataTotal=0;
  for(var p=0;p<pngEntries.length;p++) dataTotal+=pngEntries[p].bytes.byteLength;
  var totalSize=headerSize+dirSize+dataTotal;

  var buf=new Uint8Array(totalSize);
  var view=new DataView(buf.buffer);

  /* ICO header (little-endian throughout) */
  view.setUint16(0, 0, true); /* Reserved, must be 0 */
  view.setUint16(2, 1, true); /* Type: 1 = ICO, 2 = CUR */
  view.setUint16(4, pngEntries.length, true); /* Image count */

  /* Directory entries + image data */
  var dataOffset=headerSize+dirSize;
  var entryOffset=headerSize;
  for(var k=0;k<pngEntries.length;k++){
    var entry=pngEntries[k];
    /* Width/height byte: 0 means 256 (the byte field can't hold 256). */
    buf[entryOffset+0] = entry.size===256 ? 0 : entry.size;
    buf[entryOffset+1] = entry.size===256 ? 0 : entry.size;
    buf[entryOffset+2] = 0; /* Color count (0 if no palette) */
    buf[entryOffset+3] = 0; /* Reserved */
    view.setUint16(entryOffset+4, 0, true); /* Color planes (0 for PNG) */
    view.setUint16(entryOffset+6, 32, true); /* Bits per pixel */
    view.setUint32(entryOffset+8, entry.bytes.byteLength, true); /* Data size */
    view.setUint32(entryOffset+12, dataOffset, true); /* Data offset from file start */

    buf.set(entry.bytes, dataOffset);
    dataOffset += entry.bytes.byteLength;
    entryOffset += entrySize;
  }

  return {
    blob: new Blob([buf], {type:'image/x-icon'}),
    includedSizes: validSizes,
    skippedSizes: skippedSizes,
  };
}

async function decodeICO(file){
  var buf=new Uint8Array(await file.arrayBuffer());
  if(buf.byteLength < 6) throw new Error('ICO file too small');
  var view=new DataView(buf.buffer);
  var reserved=view.getUint16(0, true);
  var type=view.getUint16(2, true);
  var count=view.getUint16(4, true);
  if(reserved !== 0 || (type !== 1 && type !== 2) || count === 0){
    throw new Error('Not a valid ICO file');
  }

  /* Walk the directory, find the largest entry by pixel count. */
  var largest=null;
  for(var i=0;i<count;i++){
    var entryOff=6 + i*16;
    if(entryOff + 16 > buf.byteLength) break;
    var w=buf[entryOff+0]; if(w===0) w=256;
    var h=buf[entryOff+1]; if(h===0) h=256;
    var dataSize=view.getUint32(entryOff+8, true);
    var dataOff=view.getUint32(entryOff+12, true);
    var pixels=w*h;
    if(!largest || pixels>largest.pixels){
      largest={width:w, height:h, dataSize:dataSize, dataOffset:dataOff, pixels:pixels};
    }
  }
  if(!largest) throw new Error('ICO contains no usable entries');

  var entryBytes=buf.slice(largest.dataOffset, largest.dataOffset + largest.dataSize);

  /* Detect PNG entry by magic bytes. Modern ICOs (Vista+) use PNG
     for entries >= 256x256 and often for smaller sizes too. */
  var isPNG = entryBytes.length>=8 &&
              entryBytes[0]===0x89 && entryBytes[1]===0x50 &&
              entryBytes[2]===0x4E && entryBytes[3]===0x47 &&
              entryBytes[4]===0x0D && entryBytes[5]===0x0A &&
              entryBytes[6]===0x1A && entryBytes[7]===0x0A;
  if(isPNG){
    /* Re-wrap as a PNG file the browser can decode natively. We return
       a File so downstream code can treat this like any other image
       input — preDecodeFile is the only caller. */
    return new File([entryBytes], file.name.replace(/\.ico$/i,'')+'_'+largest.width+'x'+largest.height+'.png', {type:'image/png'});
  }

  /* Older BMP-encoded entry. Reconstructing the BMP file header from
     the BITMAPINFOHEADER inside requires more work (and the height in
     the header is doubled to account for the AND mask). Common in old
     Windows .ico files but rare in modern ones. Surface a clear error
     so the user knows what happened and can re-export the source. */
  throw new Error('This .ico uses an older BMP-based format that we don\'t decode yet. Try re-exporting from a modern tool, or save the source image as PNG instead.');
}
function isExotic(f){return isHeic(f)||isTiff(f)||isSvg(f)||isIco(f);}
function isAccepted(f){if(f.type&&f.type.startsWith('image/'))return true;return['heic','heif','tif','tiff','bmp','svg'].indexOf(getFileExt(f.name))!==-1;}
/* Friendly canonical name for the file's input format. Used by the result
   row's "Converted to X" label so we can compare apples-to-apples against
   the output format string. Returns 'jpg' (not 'jpeg'), 'tiff' (not 'tif'),
   etc. Returns empty string if we can't tell. */
function getInputFormatName(f){
  if(!f)return '';
  var t=(f.type||'').toLowerCase();
  var e=getFileExt(f.name);
  if(t==='image/jpeg'||e==='jpg'||e==='jpeg')return 'jpg';
  if(t==='image/png'||e==='png')return 'png';
  if(t==='image/webp'||e==='webp')return 'webp';
  if(t==='image/avif'||e==='avif')return 'avif';
  if(t==='image/gif'||e==='gif')return 'gif';
  if(t==='image/heic'||t==='image/heif'||e==='heic'||e==='heif')return 'heic';
  if(t==='image/tiff'||e==='tif'||e==='tiff')return 'tiff';
  if(t==='image/bmp'||e==='bmp')return 'bmp';
  if(t==='image/svg+xml'||e==='svg')return 'svg';
  return '';
}
function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';return(b/1048576).toFixed(2)+' MB';}
function getExt(bl){return{'image/webp':'webp','image/avif':'avif','image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/x-icon':'ico','image/vnd.microsoft.icon':'ico'}[bl.type]||'webp';}

/* ============================================================
   NAMED RESULT URLs — for right-click "Save image as" branding
   ============================================================
   Browsers can't suggest a filename for blob:// URLs. To make
   right-click → "Save image as..." default to "vacation_imgready.jpg"
   instead of a random hash, we route result blobs through the service
   worker via a /r/{id}/{filename} path. See sw.js for the receiving
   side (message handler + fetch route).

   Falls back to URL.createObjectURL when the SW isn't controlling the
   page yet (first load, incognito, or browsers without SW support) —
   functionality stays intact, the user just gets the blob hash on
   right-click for those cards. Subsequent results re-acquire the
   named-URL behavior once the SW activates.

   Cleanup: _releaseNamedResultURL is called by the same code paths
   that previously called URL.revokeObjectURL on result.url, so the
   in-SW Map stays bounded to the current batch. */
function _genNamedId(){
  return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
}

function _brandedFilename(originalName, outputExt){
  /* "vacation.heic" + "jpg" → "vacation_imgready.jpg".
     Suffix (not prefix) so files preserve alphabetical sort by their
     original name — useful when batch-saving into a folder. */
  var base = (originalName || 'image').replace(/\.[^.]+$/, '');
  /* Strip filesystem-unsafe chars (Windows + Unix combined) so the
     filename can't break the Content-Disposition header on any OS. */
  base = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'image';
  return base + '_imgready.' + (outputExt || 'bin');
}

function _createNamedResultURL(blob, originalName, outputFmt){
  var ext = (outputFmt === 'jpeg') ? 'jpg' : (outputFmt || getExt(blob) || 'bin');
  var filename = _brandedFilename(originalName, ext);
  var sw = navigator.serviceWorker;
  var ctrl = sw && sw.controller;
  if (!ctrl) {
    /* SW not active yet — graceful fallback. */
    return { url: URL.createObjectURL(blob), id: null, filename: filename };
  }
  var id = _genNamedId();
  try {
    ctrl.postMessage({ type: 'register-blob', id: id, blob: blob, filename: filename });
  } catch (e) {
    /* postMessage failure (huge blob, structured-clone limit) → fallback. */
    console.warn('[imgready] named-URL register failed, falling back:', e);
    return { url: URL.createObjectURL(blob), id: null, filename: filename };
  }
  return {
    url: '/r/' + id + '/' + encodeURIComponent(filename),
    id: id,
    filename: filename,
  };
}

function _releaseNamedResultURL(result){
  if (!result) return;
  if (result.namedId) {
    var ctrl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (ctrl) {
      try { ctrl.postMessage({ type: 'release-blob', id: result.namedId }); } catch (_) {}
    }
    result.namedId = null;
  } else if (result.url && typeof result.url === 'string' && result.url.indexOf('blob:') === 0) {
    URL.revokeObjectURL(result.url);
  }
}
/* Escape user-provided strings (filenames especially) before injecting them into
   innerHTML strings or attribute values. Filenames CAN contain " < > & ' on most
   filesystems — without this, dropping a file named `foo" onclick="alert(1)" .jpg`
   would self-XSS the page. Self-XSS is low-severity but still worth shutting down. */
function escHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function canvasToBlob(c,m){return new Promise(function(r,j){c.toBlob(function(b){b?r(b):j(new Error('Canvas failed'));},m);});}
function showLibToast(m){var t=G('libToast'),s=G('libToastMsg');if(s)s.textContent=m;if(t)t.classList.add('show');}
function hideLibToast(){var t=G('libToast');if(t)t.classList.remove('show');}

/* ========================================
   HEIC DECODER
   ======================================== */
/* Load libheif via a real <script> tag (CSP-safe, no eval). */
function loadLibheifScript(){
  return new Promise(function(res,rej){
    if(window.libheif)return res();
    var existing=document.querySelector('script[data-libheif]');
    if(existing){existing.addEventListener('load',res);existing.addEventListener('error',function(){rej(new Error('libheif script load failed'));});return;}
    var s=document.createElement('script');
    s.src=LIBHEIF_URL;s.async=true;s.crossOrigin='anonymous';s.setAttribute('data-libheif','1');
    s.onload=function(){res();};
    s.onerror=function(){rej(new Error('libheif script load failed'));};
    document.head.appendChild(s);
  });
}
async function ensureLibheif(){
  if(libheifModule)return libheifModule;
  showLibToast('Loading HEIC decoder...');
  try{
    await loadLibheifScript();
    var lib=window.libheif;if(!lib)throw new Error('libheif not found');
    if(typeof lib==='function'){lib=await new Promise(function(res,rej){var to=setTimeout(function(){rej(new Error('timeout'));},30000);lib({onRuntimeInitialized:function(){clearTimeout(to);res(this);}});});}
    else if(lib.then)lib=await lib;
    if(!lib.HeifDecoder&&window.HeifDecoder)lib.HeifDecoder=window.HeifDecoder;
    if(!lib.HeifDecoder){await new Promise(function(r){setTimeout(r,500);});if(!lib.HeifDecoder&&window.HeifDecoder)lib.HeifDecoder=window.HeifDecoder;}
    if(!lib.HeifDecoder)throw new Error('HeifDecoder not found');
    libheifModule=lib;hideLibToast();return lib;
  }catch(e){hideLibToast();throw new Error('HEIC decoder: '+e.message);}
}
async function decodeHeic(f){
  var lib=await ensureLibheif();var buf=await f.arrayBuffer();var dec=new lib.HeifDecoder();
  var data=dec.decode(new Uint8Array(buf));if(!data||!data.length)throw new Error('No images in HEIC');
  var img=data[0],w=img.get_width(),h=img.get_height();
  var c=document.createElement('canvas');c.width=w;c.height=h;
  var ctx=c.getContext('2d'),id=ctx.createImageData(w,h);
  await new Promise(function(res,rej){img.display(id,function(d){if(!d)return rej(new Error('HEIC decode failed'));res(d);});});
  ctx.putImageData(id,0,0);return await canvasToBlob(c,'image/png');
}

/* ========================================
   TIFF DECODER
   ======================================== */
async function decodeTiff(f){
  try{var bmp=await createImageBitmap(f);var c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;c.getContext('2d').drawImage(bmp,0,0);bmp.close();return await canvasToBlob(c,'image/png');}catch(e){}
  var buf=await f.arrayBuffer();return await canvasToBlob(parseTiff(buf),'image/png');
}
function parseTiff(B){var dv=new DataView(B),le=dv.getUint16(0)===0x4949;function r16(o){return dv.getUint16(o,le);}function r32(o){return dv.getUint32(o,le);}if(r16(2)!==42)throw new Error('Invalid TIFF');var io=r32(4),n=r16(io),T={};for(var i=0;i<n;i++){var e=io+2+i*12,tag=r16(e),ty=r16(e+2),cnt=r32(e+4);var v;if(cnt*({1:1,2:1,3:2,4:4,5:8}[ty]||4)<=4){v=ty===3?r16(e+8):r32(e+8);if(cnt>1&&ty===3)v=[r16(e+8),r16(e+10)];}else{var o=r32(e+8);v=[];for(var j=0;j<cnt;j++)v.push(ty===3?r16(o+j*2):r32(o+j*4));}T[tag]=v;}var w=T[256]||0,h=T[257]||0,comp=T[259]||1,ph=T[262]||2,spp=T[277]||1,bv=T[258],bps=Array.isArray(bv)?bv[0]:(bv||8);var offs=Array.isArray(T[273])?T[273]:[T[273]||0],cnts=Array.isArray(T[279])?T[279]:[T[279]||0];if(!w||!h)throw new Error('Invalid TIFF');if(comp!==1&&comp!==5&&comp!==32773)throw new Error('Unsupported TIFF compression');var raw;if(comp===1){var t=0;for(var ci=0;ci<cnts.length;ci++)t+=cnts[ci];raw=new Uint8Array(t);var p=0;for(var si=0;si<offs.length;si++){raw.set(new Uint8Array(B,offs[si],cnts[si]),p);p+=cnts[si];}}else if(comp===32773){var oo=[];for(var s2=0;s2<offs.length;s2++){var src=new Int8Array(B,offs[s2],cnts[s2]);var ii=0;while(ii<src.length){var nn=src[ii++];if(nn>=0)for(var jj=0;jj<=nn&&ii<src.length;jj++)oo.push(src[ii++]&0xff);else if(nn!==-128){var vv=src[ii++]&0xff;for(var kk=0;kk<1-nn;kk++)oo.push(vv);}}}raw=new Uint8Array(oo);}else{raw=decodeLZW(B,offs,cnts);}var c=document.createElement('canvas');c.width=w;c.height=h;var ctx=c.getContext('2d'),id=ctx.createImageData(w,h),px=id.data,bS=Math.ceil(bps/8);for(var y=0;y<h;y++)for(var x=0;x<w;x++){var di=(y*w+x)*4,sii=(y*w+x)*spp*bS;if(spp>=3){px[di]=raw[sii]||0;px[di+1]=raw[sii+1]||0;px[di+2]=raw[sii+2]||0;px[di+3]=spp>=4?(raw[sii+3]!==undefined?raw[sii+3]:255):255;}else{var val=raw[sii]||0,gg=ph===0?255-val:val;px[di]=px[di+1]=px[di+2]=gg;px[di+3]=255;}}ctx.putImageData(id,0,0);return c;}
function decodeLZW(B,offs,cnts){var out=[];for(var s=0;s<offs.length;s++){var src=new Uint8Array(B,offs[s],cnts[s]);var bp=0,cs=9;function rd(){var c=0;for(var i=0;i<cs;i++){var bi=(bp+i)>>3,bt=7-((bp+i)&7);if(bi<src.length)c=(c<<1)|((src[bi]>>bt)&1);}bp+=cs;return c;}var tbl=[];function rst(){tbl=[];for(var i=0;i<258;i++)tbl[i]=i<256?[i]:[];cs=9;}rst();var code=rd();if(code!==256)continue;rst();var old=rd();if(old===257)continue;if(tbl[old])for(var b=0;b<tbl[old].length;b++)out.push(tbl[old][b]);while(true){code=rd();if(code===257||bp>src.length*8+16)break;if(code===256){rst();code=rd();if(code===257)break;if(tbl[code])for(var b2=0;b2<tbl[code].length;b2++)out.push(tbl[code][b2]);old=code;continue;}var entry;if(code<tbl.length&&tbl[code])entry=tbl[code];else if(code===tbl.length)entry=tbl[old]?tbl[old].concat([tbl[old][0]]):[0];else break;for(var b3=0;b3<entry.length;b3++)out.push(entry[b3]);if(tbl[old])tbl.push(tbl[old].concat([entry[0]]));if(tbl.length>=(1<<cs)&&cs<12)cs++;old=code;}}return new Uint8Array(out);}

/* ========================================
   SVG DECODER
   ======================================== */
function decodeSvg(f,tw){return new Promise(function(res,rej){var rd=new FileReader();rd.onload=function(){var blob=new Blob([rd.result],{type:'image/svg+xml;charset=utf-8'});var url=URL.createObjectURL(blob);var img=new Image();img.onload=function(){URL.revokeObjectURL(url);var w=img.naturalWidth||tw,h=img.naturalHeight||tw;var sc=tw/w;var cw=Math.round(w*sc),ch=Math.round(h*sc);var c=document.createElement('canvas');c.width=cw;c.height=ch;c.getContext('2d').drawImage(img,0,0,cw,ch);canvasToBlob(c,'image/png').then(res).catch(rej);};img.onerror=function(){URL.revokeObjectURL(url);rej(new Error('SVG failed'));};img.src=url;};rd.onerror=rej;rd.readAsText(f);});}
async function preDecodeFile(f){var maxDim=parseInt((G('resizeMax')||{}).value)||0;var svgW=maxDim?maxDim*2:2048;if(isHeic(f))return await decodeHeic(f);if(isTiff(f))return await decodeTiff(f);if(isSvg(f))return await decodeSvg(f,svgW);if(isIco(f))return await decodeICO(f);return f;}

/* ========================================
   CLIPBOARD PASTE
   ======================================== */
document.addEventListener('paste',function(e){
  var items=e.clipboardData&&e.clipboardData.items;if(!items)return;
  var files=[];
  for(var i=0;i<items.length;i++){if(items[i].type.indexOf('image')!==-1){var f=items[i].getAsFile();if(f)files.push(f);}}
  if(files.length){e.preventDefault();addFiles(files);}
});

/* ========================================
   DROP / ADD FILES
   ======================================== */
document.addEventListener('dragover',function(e){
  e.preventDefault();
  var dzel=G('dropzone');
  if(dzel&&!G('fsModal').classList.contains('show'))dzel.classList.add('drag');
});
document.addEventListener('dragleave',function(e){
  if(e.clientX===0&&e.clientY===0||(e.clientX<=0||e.clientY<=0||e.clientX>=window.innerWidth||e.clientY>=window.innerHeight)){
    var dzel=G('dropzone');if(dzel)dzel.classList.remove('drag');
  }
});
/* Recursively walk a DirectoryEntry yielding every File underneath. */
function readDirectoryEntries(dirReader){
  return new Promise(function(res,rej){
    var all=[];
    function readBatch(){
      dirReader.readEntries(function(entries){
        if(!entries.length)return res(all);
        all=all.concat(entries);
        readBatch();
      },rej);
    }
    readBatch();
  });
}
async function walkEntry(entry,bag){
  if(entry.isFile){
    await new Promise(function(res,rej){entry.file(function(f){bag.push(f);res();},rej);});
  } else if(entry.isDirectory){
    var reader=entry.createReader();
    var children=await readDirectoryEntries(reader);
    for(var i=0;i<children.length;i++) await walkEntry(children[i],bag);
  }
}
document.addEventListener('drop',async function(e){
  e.preventDefault();
  var dzel=G('dropzone');if(dzel)dzel.classList.remove('drag');
  /* Drop into the fullscreen modal: don't close — switch the modal's
     subject to the new file (Squoosh-style). The modal flips back into
     preview-only mode showing the new file's original; the encode runs in
     background and transitions to the result on completion. The previous
     subject stays in the grid so closing the modal returns to "everything
     I've worked on so far." Captured here so addFiles knows to re-arm the
     solo trigger even though the queue isn't empty. */
  var modalWasOpen=G('fsModal').classList.contains('show');
  if(modalWasOpen){window._dropInModal=true;}
  /* If items have a webkitGetAsEntry, prefer that path so folder drops work */
  var dt=e.dataTransfer;
  if(dt&&dt.items&&dt.items.length&&typeof dt.items[0].webkitGetAsEntry==='function'){
    var entries=[];
    for(var i=0;i<dt.items.length;i++){
      var item=dt.items[i];
      if(item.kind!=='file')continue;
      var entry=item.webkitGetAsEntry&&item.webkitGetAsEntry();
      if(entry)entries.push(entry);
    }
    if(entries.length){
      showLibToast('Reading folder…');
      try{
        var bag=[];
        for(var j=0;j<entries.length;j++) await walkEntry(entries[j],bag);
        hideLibToast();
        if(bag.length)addFiles(bag);
        return;
      }catch(err){hideLibToast();/* fall through to plain files below */}
    }
  }
  /* Fallback: plain dataTransfer.files (no folder support) */
  var files=dt&&dt.files;
  if(files&&files.length)addFiles(files);
});
var fi=G('fileInput');
if(fi){fi.addEventListener('change',function(){addFiles(fi.files);fi.value='';});}

var BATCH_SOFT_LIMIT=200;
function addFiles(list){
  /* Solo auto-flow trigger: any single-file drop pops the fullscreen
     modal for that file, even when the queue already has work in it.
     Real users frequently drop one, work, drop another — they shouldn't
     have to clear the queue first to get the focused experience. The
     existing items stay in the grid behind the modal; the new file is
     what the modal is showing.

     Drop-into-modal: if the user drops onto the open fullscreen modal,
     the document-level drop handler sets `_dropInModal`. We honour it as
     a forced solo trigger — the user is explicitly switching subjects.

     Multi-file drops still go to the batch grid unchanged. */
  var acceptedDrops=0;
  for(var ai=0;ai<list.length;ai++){if(isAccepted(list[ai]))acceptedDrops++;}
  /* Acknowledgement pulse: the dropzone briefly flashes the moment we
     accept a file. Skipped when the modal is already open (the modal-drop
     case has its own visual takeover) and when nothing was accepted. */
  if(acceptedDrops>0&&!G('fsModal').classList.contains('show')){
    var _dz=G('dropzone');
    if(_dz){_dz.classList.remove('just-dropped');void _dz.offsetWidth;_dz.classList.add('just-dropped');setTimeout(function(){if(_dz)_dz.classList.remove('just-dropped');},450);}
  }
  var droppedInModal=!!window._dropInModal;
  if(droppedInModal){try{delete window._dropInModal;}catch(_){window._dropInModal=undefined;}}
  var triggerSolo=(acceptedDrops===1)||(droppedInModal&&acceptedDrops>=1);
  var added=0;
  /* Soft cap to protect users from OOMing the tab on enormous drops */
  if(images.length+list.length>BATCH_SOFT_LIMIT){
    var ok=confirm('You\'re about to add '+list.length+' files (current: '+images.length+'). Browsers can struggle with more than '+BATCH_SOFT_LIMIT+' large images at once. Continue anyway?');
    if(!ok)return;
  }
  for(var i=0;i<list.length;i++){
    var f=list[i];if(!isAccepted(f))continue;
    var id=Date.now()+'_'+Math.random().toString(36).slice(2)+'_'+(added++);
    var item={id:id,file:f,origUrl:null,decoded:null,needsConvert:isExotic(f),errorMsg:'',results:[],natW:0,natH:0,livePhoto:null};
    images.unshift(item);
    /* Live Photo detection happens once per item, async, off the
       main path. Sets item.livePhoto = {offset, length} if the HEIC
       contains an embedded MOV. Used at processing time to decide
       whether to extract the video, and at render time to show the
       Live Photo chip on the card. */
    (function(itm){
      if(!isHeic(itm.file))return;
      detectLivePhotoVideo(itm.file).then(function(lp){
        if(lp){
          itm.livePhoto=lp;
          /* Re-render so the Live Photo chip appears on the card thumbnail. */
          if(typeof renderAll==='function')renderAll();
        }
      }).catch(function(){});
    })(item);
    if(!item.needsConvert){
      item.origUrl=URL.createObjectURL(f);
      (function(itm){
        var ti=new Image();
        ti.onload=function(){itm.natW=ti.naturalWidth;itm.natH=ti.naturalHeight;
          /* Only re-render if processing hasn't completed yet.
             If ti.onload fires late (after encoding finishes) a full renderAll()
             would trigger solo-done and unexpectedly grow the card layout. */
          if(!itm.results.length||!itm.results[0].blob)renderAll();};
        /* Detect "this file claims to be an image but isn't decodable" early */
        ti.onerror=function(){itm.errorMsg='This file isn\'t a valid image. Try a different file.';renderAll();updateChargePreview();};
        ti.src=itm.origUrl;
      })(item);
    }
  }
  renderAll();
  for(var j=0;j<images.length;j++){(function(item){
    if(!item.needsConvert||item.decoded||item.origUrl)return;
    showLibToast('Decoding '+getFileExt(item.file.name).toUpperCase()+'...');
    preDecodeFile(item.file).then(function(dec){
      item.decoded=dec;item.origUrl=URL.createObjectURL(dec);
      var ti=new Image();ti.onload=function(){item.natW=ti.naturalWidth;item.natH=ti.naturalHeight;hideLibToast();if(!item.results.length||!item.results[0].blob)renderAll();};ti.src=item.origUrl;
    }).catch(function(e){hideLibToast();item.errorMsg=e.message||'Decode failed';renderAll();});
  })(images[j]);}
  /* Solo magic flow: empty queue + one accepted drop = the modal opens
     IMMEDIATELY in preview-only mode showing the original. The encode runs
     in the background; once the blob lands we transition the modal from
     preview to full result without any further click. The wait happens in
     the modal, not before it — which is what makes the flow feel snappy
     instead of "drop, wait, modal pops." HEIC/TIFF need their async decode
     before origUrl is ready, so we lazily wait for it. */
  /* `images[0]` is always the most recently added (addFiles unshifts).
     For both empty-queue solo and modal-drop, the new file is at index 0. */
  if(triggerSolo){
    var soloItem=images[0];
    /* Open the modal immediately, regardless of whether origUrl is ready.
       For instantly-decodable formats (JPG/PNG/WebP/AVIF/GIF) the
       <img>-tag-based decode in addFiles' simple branch already set
       origUrl, so fsBefore lands at once. For HEIC/TIFF/BMP origUrl
       arrives ~1–3 s later via preDecodeFile; openPreview's internal
       poller fills fsBefore as soon as it does. The user goes straight
       into the focused experience instead of staring at a card. */
    if(typeof window.openPreview==='function'&&!soloItem.errorMsg){
      window.openPreview(soloItem.id);
    }
    setTimeout(function(){
      var afterProcess=function(){
        var doneIdx=null;
        for(var di=0;di<soloItem.results.length;di++){
          if(soloItem.results[di].blob){doneIdx=di;break;}
        }
        if(doneIdx===null)return;
        if(G('fsModal')&&G('fsModal').classList.contains('show')&&typeof window.transitionPreviewToResult==='function'){
          window.transitionPreviewToResult(soloItem,doneIdx);
        } else if(typeof window.openFS==='function'){
          window.openFS(soloItem.id,doneIdx);
        }
      };
      var p=window.processAll();
      if(p&&typeof p.then==='function'){p.then(afterProcess);}
      else{
        var waited=0,tick=200;
        var poll=setInterval(function(){
          waited+=tick;
          var ready=soloItem.results.some(function(r){return r.blob;});
          if(ready){clearInterval(poll);afterProcess();}
          else if(waited>=30000){clearInterval(poll);}
        },tick);
      }
    },50);
  }
}

/* ========================================
   ACTION BAR STATES + DOWNLOAD ALL
   ======================================== */
/* Snapshot of the settings that produced the most recent batch.
   Reprocess shows only when the live settings differ from this —
   so the button means "you've changed something, click to apply"
   rather than "click to redo for no reason". null until first
   processAll completes. */
var _lastAppliedSettings = null;

function _captureSettings(){
  var qs=G('qualitySlider'), rs=G('resizeMax'), ps=G('presetSelect');
  var stripExifEl=G('stripExif');
  var lpEl=G('livePhotoExtract');
  return {
    format: typeof selectedFormat !== 'undefined' ? selectedFormat : 'auto',
    formats: (typeof selectedFormats !== 'undefined' ? selectedFormats.slice() : []),
    multi: typeof multiOutputMode !== 'undefined' && !!multiOutputMode,
    quality: qs ? parseInt(qs.value, 10) : 82,
    maxDim: rs ? (parseInt(rs.value, 10) || 0) : 0,
    preset: ps ? ps.value : 'custom',
    crop: typeof currentCropRatio !== 'undefined' ? currentCropRatio : 'none',
    stripExif: stripExifEl ? !!stripExifEl.checked : true,
    /* Live Photo toggle is part of settings drift — turning it on
       after a batch ran without it should surface Reprocess so the
       user can re-run and pick up the videos. */
    livePhoto: lpEl ? !!lpEl.checked : false,
  };
}

function _settingsEqual(a, b){
  if(!a || !b) return false;
  if(a.format !== b.format) return false;
  if(a.quality !== b.quality) return false;
  if(a.maxDim !== b.maxDim) return false;
  if(a.preset !== b.preset) return false;
  if(a.crop !== b.crop) return false;
  if(a.stripExif !== b.stripExif) return false;
  if(a.multi !== b.multi) return false;
  if(a.livePhoto !== b.livePhoto) return false;
  /* formats array — compare contents, not reference. */
  var af=a.formats||[], bf=b.formats||[];
  if(af.length !== bf.length) return false;
  for(var i=0;i<af.length;i++){if(af[i]!==bf[i]) return false;}
  return true;
}

function updateChargePreview(){
  var pb=G('processBtn');
  var dlBtn=G('dlAllBtn');
  var pending=0,done=0,errored=0;
  for(var i=0;i<images.length;i++){
    /* Errored items (file unreadable) shouldn't count toward pending or done */
    if(images[i].errorMsg&&!images[i].origUrl){errored++;continue;}
    var hasDone=false;
    for(var j=0;j<images[i].results.length;j++){if(images[i].results[j].blob)hasDone=true;}
    if(hasDone)done++;
    else pending++;
  }
  /* When everything is done, hide the process button entirely instead of leaving
     a disabled "Done" placeholder. The savings pill + Download already say "done".
     When the queue mixes new + already-done items, switch the label to
     "Process N new" so the scope is unambiguous, and reveal the "or reprocess
     all" affordance for the rare case where the user wants to re-encode
     everything (e.g. they changed quality after the first batch landed). */
  if(pb){
    if(!images.length||(!pending&&!done)){pb.disabled=true;pb.textContent='Process All';pb.style.display='';}
    else if(!pending&&done){pb.style.display='none';}
    else if(pending&&done){pb.disabled=false;pb.textContent='Process '+pending+' new';pb.style.display='';}
    else{pb.disabled=false;pb.textContent='Process '+pending+' image'+(pending!==1?'s':'');pb.style.display='';}
  }
  /* ============================================================
     Action bar visibility — "are you done or not done?" mental model
     ============================================================
     Pending exists  → only Process + Clear are surfaced. Share/Copy/
                       Download are hidden because acting on an
                       incomplete batch invites mistakes (Marcus
                       persona accidentally downloading 5 of 8).
     All done        → Share/Copy/Download appear, plus Reprocess
                       (so Priya can re-encode at a new quality
                       without clear-and-re-upload).
     Per-card buttons (Share/Copy/Download on each finished card)
     stay visible regardless of batch state — that's where Ada's
     "ship the first 10 now while AVIFs finish" use case lives.
     The action bar represents the WHOLE batch; per-card actions
     represent INDIVIDUAL items. Two surfaces, two philosophies,
     both honest. Matches TinyPNG's pattern.
     ============================================================ */
  var allDone = done>0 && !pending;

  var rb=G('reprocessBtn');
  if(rb){
    /* Reprocess shows ONLY when:
         (a) everything is done (allDone), AND
         (b) live settings differ from the settings that produced
             the current batch (_lastAppliedSettings).
       This way the button means "you've changed something, click to
       apply" rather than appearing as a permanent fixture inviting
       redundant re-encodes. _lastAppliedSettings is set by processAll
       on completion (and reprocessAll calls processAll, so the cycle
       is self-cleaning). */
    var settingsDrifted = _lastAppliedSettings && !_settingsEqual(_lastAppliedSettings, _captureSettings());
    if(allDone && settingsDrifted){
      rb.style.display='';
      rb.textContent='reprocess all';
    } else {
      rb.style.display='none';
    }
  }
  if(dlBtn){
    /* Download all: only when everything is done. Single-result mode
       skips the ZIP wrapper; multi-result wraps in ZIP. */
    dlBtn.style.display = allDone ? '' : 'none';
    if(done===1){
      dlBtn.textContent='Download all';
      dlBtn.dataset.mode='single';
    } else {
      dlBtn.textContent='Download all ('+done+')';
      dlBtn.dataset.mode='zip';
    }
  }
  /* Share all: only when everything is done AND the browser supports
     navigator.canShare with files. In mixed state, hidden — users
     who want to share a single completed file have the per-card
     Share button. */
  var shareBtn=G('shareAllBtn');
  if(shareBtn){
    var showShare = allDone && window._shareSupportedFiles===true;
    shareBtn.style.display = showShare ? '' : 'none';
    if(showShare){
      var lbl=shareBtn.querySelector('.btn-share-label');
      if(lbl){
        if(done===1) lbl.textContent='Share all';
        else lbl.textContent='Share all ('+done+')';
      }
    }
  }
  /* Copy was removed from the action bar — clipboard physically can't
     hold a multi-image batch, so a "copy this batch" affordance was
     either misleading (silent first-only copy) or inconsistent
     (visible only in solo mode). Per-card Copy stays available on
     every finished card for the "paste this specific image" flow,
     which is the only honest copy operation the web platform supports. */
  /* Hide the .action-cluster wrapper when none of its children are
     visible. Without this, the cluster's own width:100% on mobile
     would leave an empty row. CSS :has() could do this with one
     selector but JS keeps it compatible across browsers. */
  var cluster=G('actionCluster');
  if(cluster){
    /* Cluster now holds Share + Download (Copy was removed). When
       both are hidden, collapse the cluster so its width:100% on
       mobile doesn't leave an empty row above Process. */
    var anyVisible = (shareBtn && shareBtn.style.display !== 'none') ||
                     (dlBtn    && dlBtn.style.display    !== 'none');
    cluster.style.display = anyVisible ? '' : 'none';
  }
  var cp=G('chargePreview');
  if(cp){
    var af=getActiveFormats();
    var totalOutputs=pending*af.length;
    if(pending&&af.length>1){cp.textContent=totalOutputs+' outputs ('+pending+' \u00d7 '+af.length+' formats)';}
    else{cp.textContent='';}
  }
  /* Total bytes saved across the batch \u2014 show as a green pill once non-trivial.
     Live Photo MP4 results are excluded from the "smallest blob" pick:
     they're extracted bytes, not compressed output, so they don't
     represent a savings choice. The image still result is the only
     valid savings target for a Live Photo card. */
  var savedBytes=0;
  for(var si=0;si<images.length;si++){
    var bestSize=null;
    for(var sj=0;sj<images[si].results.length;sj++){
      var rb=images[si].results[sj].blob;
      if(images[si].results[sj].isLivePhotoVideo) continue;
      if(rb&&(bestSize===null||rb.size<bestSize))bestSize=rb.size;
    }
    if(bestSize!==null)savedBytes+=Math.max(0,images[si].file.size-bestSize);
  }
  /* Saved chip lives in .action-meta alongside Clear All. Quiet
     typography-only treatment — color carries success, weight sets
     hierarchy, no border or background fill. Counts the done images
     and appends "· N images" so the chip carries scope context. */
  var pill=G('savingsPill'),num=G('savingsNum'),ctx=G('savingsContext');
  if(pill&&num){
    if(savedBytes>=1024){
      num.textContent=fmtSize(savedBytes);
      if(ctx){
        var doneCount=0;
        for(var sk=0;sk<images.length;sk++){
          for(var sl=0;sl<images[sk].results.length;sl++){
            if(images[sk].results[sl].blob){doneCount++;break;}
          }
        }
        ctx.textContent=doneCount>0?(' · '+doneCount+' image'+(doneCount===1?'':'s')):'';
      }
      pill.classList.add('show');
    } else {
      pill.classList.remove('show');
    }
  }
}

/* JSZip lazy-loader. Saves ~95 KB from first paint by only fetching the
   library if/when the ZIP download path actually fires (Brave, Firefox,
   user cancellation of folder picker, single-image case where we ZIP for
   filename consistency, etc.). Caches the load promise so concurrent
   download clicks don't race. */
var _jszipPromise = null;
function ensureJSZip(){
  if(typeof window.JSZip!=='undefined')return Promise.resolve(window.JSZip);
  if(_jszipPromise)return _jszipPromise;
  return _jszipPromise = new Promise(function(resolve,reject){
    var s=document.createElement('script');
    /* Self-hosted JSZip — eliminates the cdnjs dependency for ZIP download.
       SRI is enforced for parity with the eagerly-loaded /vendor/ scripts. */
    s.src='/vendor/jszip.min.js';
    s.integrity='sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG';
    s.crossOrigin='anonymous';
    s.onload=function(){resolve(window.JSZip);};
    s.onerror=function(){_jszipPromise=null;reject(new Error('Failed to load JSZip'));};
    document.head.appendChild(s);
  });
}

/* Build the {name, blob} list once — both code paths consume it. */
function _collectResults(){
  var out=[],names={};
  for(var i=0;i<images.length;i++){
    var item=images[i];
    for(var j=0;j<item.results.length;j++){
      var r=item.results[j];
      if(!r.blob)continue;
      var name=item.file.name.replace(/\.[^.]+$/,'')+'.'+getExt(r.blob);
      if(names[name]){
        names[name]++;
        var renamed=name.replace(/(\.[^.]+)$/,'_'+names[name]+'$1');
        /* Track the renamed variant too so a file originally named "foo_2.jpg"
           (which would also produce "foo_2.webp") doesn't collide silently. */
        if(!names[renamed])names[renamed]=1;
        name=renamed;
      }else{names[name]=1;}
      out.push({name:name,blob:r.blob});
    }
  }
  return out;
}

/* _saveAllToFolder (showDirectoryPicker / File System Access API) was
   removed when Download All was made unconditionally ZIP-based — the
   folder-picker permission dialog was Chromium-only, surprised users,
   and behaved inconsistently with mobile. If you ever want the folder
   path back, restore it from git: it lived right here and routed via
   `dataset.mode='folder'` in recompute() and a `mode==='folder'`
   branch in downloadAll() below. */

window.downloadAll=async function(){
  var items=_collectResults();
  if(!items.length)return;
  /* Single image: skip the ZIP wrapper and hand back the raw blob — saves
     the user an extraction step. Use triggerDownload directly (never the
     downloadOrShare helper) so we don't accidentally pop the OS share
     sheet — Share is its own button now and Download must always mean
     "save a file to disk". */
  if(items.length===1){
    triggerDownload(items[0].blob,items[0].name);
    return;
  }
  /* Multi-image ZIP — need JSZip; lazy-load if not yet present */
  var Zip;
  try{Zip=await ensureJSZip();}
  catch(err){
    console.warn('[imgready] JSZip load failed:',err);
    /* Last-resort fallback: download files one at a time. Browsers
       throttle multiple synchronous downloads; staggering by 60 ms
       (which is also what _saveAllToFolder's previous fallback used)
       avoids dropped files in Firefox/Safari. */
    for(var fi=0;fi<items.length;fi++){
      (function(it,d){setTimeout(function(){triggerDownload(it.blob,it.name);},d);})(items[fi],fi*60);
    }
    return;
  }
  var zip=new Zip();
  for(var k=0;k<items.length;k++)zip.file(items[k].name,items[k].blob);
  var content=await zip.generateAsync({type:'blob'});
  /* Timestamped filename makes it easy to identify when multiple ZIPs are downloaded */
  var _d=new Date();
  var _ts=_d.getFullYear()+'-'+String(_d.getMonth()+1).padStart(2,'0')+'-'+String(_d.getDate()).padStart(2,'0');
  triggerDownload(content,'imgready-'+_ts+'.zip');
};

/* ========================================
   CROP OVERLAY
   ======================================== */
function buildCropOverlay(item){
  if(!item.origUrl||currentCropRatio==='none'||!item.natW||!item.natH)return '';
  var ratio=CROP_RATIOS[currentCropRatio];if(!ratio)return '';
  var iw=item.natW,ih=item.natH;
  var cx,cy,cw,ch;
  if(ratio>iw/ih){cw=iw;ch=Math.round(iw/ratio);cx=0;cy=Math.round((ih-ch)/2);}
  else{ch=ih;cw=Math.round(ih*ratio);cy=0;cx=Math.round((iw-cw)/2);}
  var mid='cm_'+item.id.replace(/[^a-zA-Z0-9]/g,'');
  var sw=Math.max(1,Math.round(iw/200)),sd=Math.round(iw/50);
  return '<div class="crop-overlay"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+iw+' '+ih+'" style="max-width:100%;max-height:100%"><defs><mask id="'+mid+'"><rect width="'+iw+'" height="'+ih+'" fill="white"/><rect x="'+cx+'" y="'+cy+'" width="'+cw+'" height="'+ch+'" fill="black"/></mask></defs><rect width="'+iw+'" height="'+ih+'" fill="rgba(0,0,0,0.45)" mask="url(#'+mid+')"/><rect x="'+cx+'" y="'+cy+'" width="'+cw+'" height="'+ch+'" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="'+sw+'" stroke-dasharray="'+sd+' '+sd+'"/></svg></div>';
}
window.imgLoaded=function(id){
  for(var i=0;i<images.length;i++){
    if(images[i].id===id){
      var el=G('img_'+id.replace(/[^a-zA-Z0-9]/g,''));
      if(el&&el.naturalWidth){
        images[i].natW=el.naturalWidth;images[i].natH=el.naturalHeight;
        if(currentCropRatio!=='none'){
          var card=document.querySelector('.card[data-id="'+id+'"]');
          if(card){
            var thumb=card.querySelector('.card-thumb');
            var existing=thumb?thumb.querySelector('.crop-overlay'):null;
            var newOverlay=buildCropOverlay(images[i]);
            if(existing)existing.outerHTML=newOverlay||'';
            else if(newOverlay&&thumb)thumb.insertAdjacentHTML('beforeend',newOverlay);
          }
        }
      }
      break;
    }
  }
};

/* ========================================
   RENDER CARDS
   ========================================
   The card layout was refactored from a vertical stack (thumb /
   filename+size / result-row) into the "Direction A" shape:
     - thumb gets a savings stamp overlay when there's a result
     - body shows a single math line (1.48 MB → 204 KB · JPG, with
       strikethrough on the input format if conversion happened)
     - bottom row is three real Share/Copy/Download buttons

   buildResultsHTML now returns the bottom action row OR an error row
   OR empty (pending state). The savings stamp + math line are built
   by separate helpers below and wired into the card composition in
   renderAll. The result-row/card-results CSS is preserved unused so
   multi-format mode (currently disabled) can be re-enabled later
   without re-deriving styles.

   Format equivalence: jpg/jpeg, heic/heif, tif/tiff are treated as
   the same format for the strikethrough check — converting a .heic
   to .heif (essentially identical) shouldn't visually claim a
   conversion happened. */
function _normalizeFmt(f){
  f=(f||'').toLowerCase();
  if(f==='jpeg')return 'jpg';
  if(f==='heif')return 'heic';
  if(f==='tif')return 'tiff';
  return f;
}

function buildCardMathHTML(item){
  /* No results yet: simple pending info — original size + input format.
     Reads as "this is what you dropped in"; will be replaced by the
     full math line once a result lands. */
  var inputExt=getFileExt(item.file.name).toUpperCase();
  if(!item.results.length){
    return '<div class="card-info">'+escHtml(fmtSize(item.file.size))+(inputExt?' · <span class="card-info-fmt">'+escHtml(inputExt)+'</span>':'')+'</div>';
  }
  /* Find the first completed image result. Single-format mode (today's
     default) means there's at most one image result. Skip Live Photo
     MP4 entries — they're side artifacts of HEIC decoding, not the
     primary "what did we encode?" answer that the math line should
     describe. The MP4's existence is signaled by the Live Photo chip
     on the thumbnail, not by the math line. */
  var rr=null;
  for(var k=0;k<item.results.length;k++){
    var rk=item.results[k];
    if(rk.blob && !rk.isLivePhotoVideo){rr=rk;break;}
  }
  if(!rr){
    /* All results are still pending or errored. Show pending info; the
     error row below the body handles the user-visible failure case. */
    return '<div class="card-info">'+escHtml(fmtSize(item.file.size))+(inputExt?' · <span class="card-info-fmt">'+escHtml(inputExt)+'</span>':'')+'</div>';
  }
  var newFmtRaw=(rr.format||'').toUpperCase();
  var inputNorm=_normalizeFmt(inputExt);
  var newNorm=_normalizeFmt(newFmtRaw);
  var fmtChanged=inputNorm && newNorm && inputNorm!==newNorm;
  var fmtPart;
  if(fmtChanged){
    /* Show the input format struck through, then the new format in
       brand color — the conversion is right there in the typography. */
    fmtPart='<span class="math-fmt math-fmt-strike">'+escHtml(inputExt)+'</span> '+
            '<span class="math-arrow">→</span> '+
            '<span class="math-fmt math-fmt-new">'+escHtml(newFmtRaw)+'</span>';
  } else {
    fmtPart='<span class="math-fmt math-fmt-new">'+escHtml(newFmtRaw)+'</span>';
  }
  /* Result-only math line. The input size used to live here as
     "1.48 MB → 204 KB" but it's redundant with the savings stamp on
     the thumbnail, which already telegraphs that the input was bigger.
     Showing both was the same fact twice — once as a delta, once as a
     percentage. The stamp wins because it carries the brand promise;
     the math line drops to a clean "result size · format". */
  return '<div class="card-math">'+
    '<span class="math-new">'+escHtml(fmtSize(rr.blob.size))+'</span>'+
    '<span class="math-sep">·</span>'+
    fmtPart+
  '</div>';
}

/* Metadata chip — appears below the math line on every card with a
   completed image result. Confirms EXIF/GPS/camera data was removed
   during re-encoding. Returns empty when:
     - no result yet (pending state — would be premature)
     - the only result is a Live Photo MP4 (extracted bytes, not re-encoded)
     - getSettings says stripExif is false (the opt-out path; absence is the signal)
   The shield SVG is the same path used in the dropzone trust line so
   the privacy lexicon is visually consistent across the page. */
function buildCardMetadataChipHTML(item){
  if(!item.results || !item.results.length) return '';
  var hasImageResult = false;
  for(var i = 0; i < item.results.length; i++){
    var r = item.results[i];
    if(r.blob && !r.isLivePhotoVideo){ hasImageResult = true; break; }
  }
  if(!hasImageResult) return '';
  /* Honor explicit opt-out if the toggle ever gets reintroduced. */
  var stripExifEl = G('stripExif');
  if(stripExifEl && !stripExifEl.checked) return '';
  return '<div class="card-meta-chip" title="EXIF, GPS, IPTC, XMP and camera-model data removed during re-encoding.">' +
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
    '<span>Metadata stripped</span>' +
  '</div>';
}

function buildCardLivePhotoChipHTML(item){
  /* Returns the Live Photo chip HTML when the item was detected as a
     Live Photo. Empty string otherwise. The chip's appearance differs
     based on the toggle state (livePhotoExtractEnabled): muted when
     off, accent + "MP4" suffix when on. The chip is rendered into the
     same .card-thumb element as the savings stamp; pointer-events
     are off so it doesn't block thumbnail click. */
  if(!item.livePhoto) return '';
  var active = livePhotoExtractEnabled();
  return '<div class="thumb-lp-chip'+(active?' active':'')+'" aria-label="'+(active?'Live Photo, video extracted as MP4':'Live Photo detected')+'">'+
    'Live Photo'+
    (active?'<span class="lp-suffix" aria-hidden="true">· MP4</span>':'')+
  '</div>';
}

function buildCardStampHTML(item){
  /* Savings stamp overlaid on the thumbnail. Returns empty string
     when there's nothing to celebrate yet (no blob, or pure
     pending). The stamp is the brand's promise made visual on every
     card — but quietly. Hollow chip, thin font, "saved" label
     instead of an arrow icon. Reads as a finished receipt.
     Live Photo MP4 results are skipped — savings is an image-quality
     story, not a "how many bytes the video happens to be" story. */
  if(!item.results.length)return '';
  var rr=null;
  for(var k=0;k<item.results.length;k++){
    var rk=item.results[k];
    if(rk.blob && !rk.isLivePhotoVideo){rr=rk;break;}
  }
  if(!rr)return '';
  var sv=item.file.size-rr.blob.size;
  var pc=item.file.size?Math.round(sv/item.file.size*100):0;
  /* Skip the stamp entirely if percentage rounds to 0 — a chip that
     says "0% saved" reads as failure, not nuance. */
  if(pc===0)return '';
  var cls=sv>=0?'':' bad';
  var label=sv>=0?'saved':'larger';
  var pct=(sv>=0?'':'+')+Math.abs(pc)+'%';
  return '<div class="thumb-stamp'+cls+'" aria-label="'+(sv>=0?'Saved ':'Got bigger by ')+Math.abs(pc)+' percent">'+
    '<span class="stamp-pct">'+escHtml(pct)+'</span>'+
    '<span class="stamp-label">'+label+'</span>'+
  '</div>';
}

function buildResultsHTML(item){
  /* This now returns the BOTTOM section of the card — either the
     three-button action row, or an error row, or empty (still pending).
     The math line and the savings stamp live in buildCardMathHTML and
     buildCardStampHTML; they're wired into card-body and card-thumb
     in renderAll. */
  if(!item.results.length)return '';
  /* Find a usable image result (with a blob), or the first error.
     Live Photo MP4 results are skipped for the "primary" pick —
     Copy + math/stamp + the action button labels all describe the
     image still, not the video. The video is implicit (Live Photo
     chip + Download button covers both). */
  var rr=null,rIdx=-1,err=null,errIdx=-1;
  for(var k=0;k<item.results.length;k++){
    var r2=item.results[k];
    if(r2.blob && !r2.isLivePhotoVideo && rr===null){rr=r2;rIdx=k;}
    else if(r2.error && err===null){err=r2;errIdx=k;}
  }
  if(!rr){
    if(err){
      return '<div class="card-error-row">'+
        '<span class="err-msg">'+escHtml(err.error||'Encoding failed')+'</span>'+
        '<button class="btn-retry" onclick="event.stopPropagation();retryResult(\''+item.id+'\','+errIdx+')" aria-label="Retry encoding">Retry</button>'+
      '</div>';
    }
    return ''; /* pending: thumb's processing overlay carries the state */
  }
  var newFmt=(rr.format||'').toUpperCase();
  var shareSupported=window._shareSupportedFiles===true;
  /* Hierarchy: Download is the solid primary button (universal, safe,
     always works). Share + Copy are secondary outlined buttons —
     useful but optional, gated on platform capability. The Download
     button comes LAST in DOM order (right side of the row) so on LTR
     layouts it sits where the eye lands when scanning a card; the
     ghost buttons sit to its left.

     Multi-result handling (Live Photo cards have JPG + MP4):
       - Download → dlCard(imgId) downloads ALL done blobs sequentially
       - Share → shareCard(imgId) shares ALL done files via Web Share API
       - Copy → copyResult on the FIRST result only (clipboard limit)
     For single-result cards (the common case) all three behave exactly
     as before. */
  var actions='<div class="card-actions">';
  if(shareSupported){
    actions+='<button class="card-action-btn" onclick="event.stopPropagation();shareCard(\''+item.id+'\')" aria-label="Share '+escHtml(newFmt)+'" title="Share">'+
             '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>'+
             '<span class="card-action-label">Share</span>'+
             '</button>';
  }
  actions+='<button class="card-action-btn" onclick="event.stopPropagation();copyResult(this,\''+item.id+'\','+rIdx+')" aria-label="Copy '+escHtml(newFmt)+' to clipboard" title="Copy">'+
           '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'+
           '<span class="card-action-label">Copy</span>'+
           '</button>';
  actions+='<button class="card-action-btn card-action-primary" onclick="event.stopPropagation();dlCard(\''+item.id+'\')" aria-label="Download '+escHtml(newFmt)+'" title="Download">'+
           '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'+
           '<span class="card-action-label">Download</span>'+
           '</button>';
  actions+='</div>';
  return actions;
}

/* Tracks which result blobs have already had their reveal animation play
   so that re-renders (e.g. quality slider in the modal) don't re-trigger
   the size countdown every tick. Keyed by result.id which the encoder
   rewrites on each fresh blob — so a brand new result animates, but the
   same blob being painted again (slider drag, filter change) doesn't. */
var _animatedResultIds=Object.create(null);
function _easeOutCubic(t){return 1-Math.pow(1-t,3);}
function _animateNumberText(el,from,to,duration,format){
  if(!el)return;
  var start=performance.now();
  function step(now){
    var t=Math.min(1,(now-start)/duration);
    var v=from+(to-from)*_easeOutCubic(t);
    el.textContent=format(v);
    if(t<1)requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
/* Walk a card's freshly-rendered .result-row elements and animate the
   size + savings numbers from their input baselines down to the actual
   result values. Only fires on first reveal per result.id, so subsequent
   slider edits or hover swaps update instantly without re-tweening. */
function _animateNewResultRows(item){
  var card=document.querySelector('.card[data-id="'+item.id+'"]');
  if(!card)return;
  var rows=card.querySelectorAll('.card-results .result-row');
  for(var i=0;i<item.results.length&&i<rows.length;i++){
    var rr=item.results[i],row=rows[i];
    if(!rr.blob||!rr.id||_animatedResultIds[rr.id])continue;
    _animatedResultIds[rr.id]=true;
    var sizeEl=row.querySelector('.result-size');
    var savEl=row.querySelector('.result-saving');
    var sv=item.file.size-rr.blob.size;
    var endPct=item.file.size?Math.round(sv/item.file.size*100):0;
    var sign=sv>=0?'-':'+';
    if(sizeEl){_animateNumberText(sizeEl,item.file.size,rr.blob.size,520,fmtSize);}
    if(savEl){_animateNumberText(savEl,0,endPct,520,function(v){return sign+Math.abs(Math.round(v))+'%';});}
  }
}

function updateCardResults(item){
  var card=document.querySelector('.card[data-id="'+item.id+'"]');
  if(!card)return;
  /* Card structure (new design):
       card-thumb (with optional .thumb-stamp overlay)
       card-remove
       card-body (with .card-name + .card-math or .card-info)
       card-actions  OR  card-error-row  OR  nothing (pending) */
  /* 1. Update / replace the bottom row (actions or error). The selector
        list covers both possibilities AND the legacy .card-results
        class in case a partial update lands during a transition. */
  var existing=card.querySelector('.card-actions, .card-error-row, .card-results');
  var bottomHtml=buildResultsHTML(item);
  if(existing){
    if(bottomHtml){existing.outerHTML=bottomHtml;}else{existing.remove();}
  } else if(bottomHtml){
    card.insertAdjacentHTML('beforeend',bottomHtml);
  }
  /* 2. Update the math line inside card-body — replaces .card-info
        (pending state) with .card-math (done state) when results arrive. */
  var body=card.querySelector('.card-body');
  if(body){
    var mathSlot=body.querySelector('.card-math, .card-info');
    var mathHtml=buildCardMathHTML(item);
    if(mathSlot){
      mathSlot.outerHTML=mathHtml;
    } else {
      /* No existing slot (rare — happens if buildCardMathHTML returned ''
         on initial render). Insert before any error message; otherwise
         append to end of card-name's parent. */
      var name=body.querySelector('.card-name');
      if(name) name.insertAdjacentHTML('afterend',mathHtml);
    }
    /* 2b. Metadata chip — same pattern. Inserted/replaced after the
       math line on every successful encode. Builder returns '' for
       pending state so the chip simply doesn't appear until ready. */
    var metaSlot=body.querySelector('.card-meta-chip');
    var metaHtml=buildCardMetadataChipHTML(item);
    if(metaSlot){
      if(metaHtml){metaSlot.outerHTML=metaHtml;} else {metaSlot.remove();}
    } else if(metaHtml){
      var refMath=body.querySelector('.card-math');
      if(refMath){refMath.insertAdjacentHTML('afterend',metaHtml);}
      else {
        var nameForMeta=body.querySelector('.card-name');
        if(nameForMeta) nameForMeta.insertAdjacentHTML('afterend',metaHtml);
      }
    }
  }
  /* 3. Walk the results to find the first usable blob. */
  var hasBlob=false;var firstResultUrl=null;var bestSize=null;
  for(var j=0;j<item.results.length;j++){
    var rb=item.results[j].blob;
    if(rb&&item.results[j].url){
      hasBlob=true;
      if(!firstResultUrl)firstResultUrl=item.results[j].url;
      if(bestSize===null||rb.size<bestSize)bestSize=rb.size;
    }
  }
  if(hasBlob){
    card.classList.add('done');
    var cropOv=card.querySelector('.crop-overlay');if(cropOv)cropOv.remove();
    var thumbImg=card.querySelector('.card-thumb .plain-img');
    if(thumbImg&&firstResultUrl&&thumbImg.src!==firstResultUrl){thumbImg.src=firstResultUrl;}
    /* 4. THE STAMP. This was the missing piece — when the first result
          for a card completed, updateCardResults updated the actions and
          thumb image but never added the savings stamp, so the first
          card to finish in a batch silently rendered without its
          signature element until a subsequent renderAll fired. Now we
          rebuild the stamp from current state and replace any existing
          stamp in place. */
    var thumb=card.querySelector('.card-thumb');
    if(thumb){
      var oldStamp=thumb.querySelector('.thumb-stamp');
      var stampHtml=buildCardStampHTML(item);
      if(oldStamp){
        if(stampHtml){oldStamp.outerHTML=stampHtml;}else{oldStamp.remove();}
      } else if(stampHtml){
        thumb.insertAdjacentHTML('beforeend',stampHtml);
      }
      /* 5. THE LIVE PHOTO CHIP. Same pattern as the stamp — Live Photo
            detection runs async and may have completed AFTER the
            initial render, so the chip needs to be added/updated
            here too. The chip's "active" class also reflects the
            toggle state, so this handles toggle-after-encode cases. */
      var oldLpChip=thumb.querySelector('.thumb-lp-chip');
      var lpChipHtml=buildCardLivePhotoChipHTML(item);
      if(oldLpChip){
        if(lpChipHtml){oldLpChip.outerHTML=lpChipHtml;}else{oldLpChip.remove();}
      } else if(lpChipHtml){
        thumb.insertAdjacentHTML('beforeend',lpChipHtml);
      }
    }
    /* Animate size + savings number on first reveal — the moment users
       feel "yes, the tool worked." Tracked per result.id so re-renders
       (slider drag commits, hover swaps) snap to value instantly. */
    _animateNewResultRows(item);
  }
}

function setCardProcessing(item,active,fmt){
  var card=document.querySelector('.card[data-id="'+item.id+'"]');if(!card)return;
  var thumb=card.querySelector('.card-thumb');if(!thumb)return;
  var overlay=thumb.querySelector('.proc-overlay');
  if(active){
    card.classList.add('processing');
    var label=fmt?'Encoding '+fmt.toUpperCase():'Processing';
    var hint=fmt==='avif'?'AVIF takes 5–15s — hang tight':'';
    var html='<div class="proc-overlay"><div class="proc-spin"></div><div class="proc-label">'+label+'</div>'+(hint?'<div class="proc-hint">'+hint+'</div>':'')+'</div>';
    if(!overlay)thumb.insertAdjacentHTML('beforeend',html);
    else overlay.outerHTML=html;
  }
  else{card.classList.remove('processing');if(overlay)overlay.remove();}
}

function renderAll(){
  var hasImages=images.length>0;
  document.body.classList.toggle('has-images',hasImages);
  /* Compact dropzone gets contextual copy: "Add more" instead of "Drop here" */
  var dzH2=document.querySelector('#dropzone h2');
  var dzP=document.querySelector('#dropzone p');
  if(hasImages&&dzH2&&dzP){
    dzH2.textContent='Add more images';
    dzP.textContent='or drag and drop. They\'ll be queued with your current batch.';
  } else if(!hasImages&&dzH2&&dzP){
    dzH2.textContent='Drop your images here';
    dzP.textContent='or click to browse — JPG, PNG, HEIC, TIFF, WebP, AVIF and more';
  }
  var ab=G('actionBar');if(ab)ab.style.display=hasImages?'flex':'none';
  updateChargePreview();
  var grid=G('grid');if(!grid)return;grid.innerHTML='';
  /* Solo-focus mode: exactly 1 image AND it has at least one completed result */
  var soloDone=false;
  if(images.length===1){
    for(var sj=0;sj<images[0].results.length;sj++){if(images[0].results[sj].blob){soloDone=true;break;}}
  }
  grid.classList.toggle('solo-done',soloDone);
  for(var j=0;j<images.length;j++){
    var item=images[j],isDone=item.results.length>0;
    var card=document.createElement('div');card.className='card'+(isDone?' done':'');
    card.setAttribute('data-id',item.id);
    var thumbSrc=(isDone&&item.results[0]&&item.results[0].url)?item.results[0].url:(item.origUrl||null);
    var cropOverlay='';if(currentCropRatio!=='none'&&!isDone)cropOverlay=buildCropOverlay(item);
    var zoomSvg='<div class="thumb-zoom-hint"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></div>';
    var th='';
    if(item.errorMsg&&!thumbSrc){
      /* Errored card: explicit error state at the card thumb level (not buried) */
      card.classList.add('errored');
      th='<div class="card-thumb"><div class="err-state"><div class="err-icon">⚠</div><div class="err-text">Couldn\'t read this file</div><div class="err-hint">'+item.errorMsg+'</div></div></div>';
    }else if(thumbSrc){
      var imgId='img_'+item.id.replace(/[^a-zA-Z0-9]/g,'');
      /* Single thumbnail path: shows the result once a blob is ready, otherwise
         the original. Click opens the fullscreen modal where the real
         interactive before/after slider lives. The savings stamp is
         injected here when there's a usable result; on pending/processing
         cards there's no stamp, the proc-overlay carries that state. */
      var stampHTML=buildCardStampHTML(item);
      var lpChipHTML=buildCardLivePhotoChipHTML(item);
      /* Native right-click is allowed on result thumbnails — gives users
         the browser's "Save Image As" / "Copy Image" / "Open in New Tab"
         menu against the optimized blob. Matches the muscle memory of
         users who came up before share buttons existed. The src is
         already the result blob URL post-encode, so the browser saves
         the optimized output, not the original input. */
      th='<div class="card-thumb" onclick="thumbClick(\''+item.id+'\')"><img class="plain-img" id="'+imgId+'" src="'+thumbSrc+'"';
      if(!isDone&&!item.natW)th+=' onload="imgLoaded(\''+item.id+'\')"';
      th+='>'+cropOverlay+zoomSvg+stampHTML+lpChipHTML+'</div>';
    }else{
      /* No-origUrl fallback uses the SAME .proc-overlay structure that
         setCardProcessing manages, so when encoding kicks off the overlay
         is replaced (label flips from "Decoding…" to "Encoding JPG")
         instead of a second overlay stacking on top of this one. */
      th='<div class="card-thumb"><div class="proc-overlay"><div class="proc-spin"></div><div class="proc-label">Decoding…</div></div></div>';
    }
    var name=item.file.name.replace(/\.[^.]+$/,'');
    /* No JS-side cap. The CSS text-overflow:ellipsis on .card-name
       (which is display:block, max-width:100%) responds to the actual
       container width — wide desktop 3-up cards show the full name,
       tight mobile 2-up cards truncate naturally. The earlier 22-char
       JS cap was firing even when there was plenty of room. The full
       filename is also still the title attribute, so hover-tooltips
       and screen readers always get the complete name. */
    var displayName=name;
    /* Escape filename-derived strings before inlining into HTML — filenames
       can legally contain " < > & ' on most filesystems. errorMsg is also
       escaped because it sometimes wraps a thrown error message.
       The filename no longer carries the input-format extension as a
       suffix. The format identity moved to the math line below, where
       it lives alongside its sibling info (sizes) and gets a strikethrough
       when conversion happens. Filename is now just the user's name for
       this image — clean, single piece of typography. */
    var en=item.errorMsg?'<div class="card-error-msg">'+escHtml(item.errorMsg)+'</div>':'';
    var math=buildCardMathHTML(item);
    var meta=buildCardMetadataChipHTML(item);
    var res=buildResultsHTML(item);
    card.innerHTML=th+'<button class="card-remove" onclick="removeImage(\''+item.id+'\')" aria-label="Remove this image">&#x2715;</button><div class="card-body"><span class="card-name" title="'+escHtml(item.file.name)+'">'+escHtml(displayName)+'</span>'+math+meta+en+'</div>'+res;
    grid.appendChild(card);
  }
}

/* ========================================
   PROCESS — Main encoding pipeline
   ======================================== */
/* Discard all completed results in the batch and re-run processAll. Lets the
   user re-encode everything with the current settings (e.g. after lowering
   quality) without manually clearing and re-uploading. The default flow stays
   incremental — this is opt-in via the "or reprocess all" link in the action
   bar. ObjectURLs are revoked first so we don't leak the soon-to-be-orphaned
   blob URLs. */
window.reprocessAll=function(){
  if(!images.length)return;
  for(var i=0;i<images.length;i++){
    var it=images[i];
    for(var j=0;j<it.results.length;j++){
      /* Release named URLs (or revoke plain blob URLs in fallback case)
         so the SW's blob registry stays bounded between reprocess runs. */
      _releaseNamedResultURL(it.results[j]);
    }
    it.results.length=0;
    /* Clear any prior batch-level error message since we're starting fresh.
       Per-format errors will be re-surfaced if a format fails again. */
    if(it.errorMsg&&it.origUrl)it.errorMsg='';
  }
  renderAll();
  window.processAll();
};

window.processAll=async function(){
  if(!images.length)return;
  var af=getActiveFormats();
  /* Pending = any image where at least one currently-selected format
     does NOT yet have a completed (blob-bearing) result. The previous
     "results.length === 0" filter was too strict — it excluded images
     that had placeholder rows from a cancelled run, so cancel + change
     format + Process All silently did nothing. */
  var pending=[];
  for(var pi=0;pi<images.length;pi++){
    if(images[pi].errorMsg&&!images[pi].origUrl)continue; /* unreadable file */
    var anyMissing=false;
    for(var fj=0;fj<af.length;fj++){
      /* 'auto' resolves to a concrete output format per file's input type. */
      var wantFmt=resolveFormatForFile(af[fj],images[pi].file);
      var done=false;
      for(var rr=0;rr<images[pi].results.length;rr++){
        if(images[pi].results[rr].format===wantFmt&&images[pi].results[rr].blob){done=true;break;}
      }
      if(!done){anyMissing=true;break;}
    }
    if(anyMissing)pending.push(images[pi]);
  }
  if(!pending.length)return;
  var pb=G('processBtn'),cb=G('clearBtn'),dlBtn=G('dlAllBtn'),rb=G('reprocessBtn');
  if(pb){pb.disabled=true;pb.textContent='Processing 1 of '+pending.length+'…';}
  if(cb)cb.disabled=true;
  if(dlBtn)dlBtn.disabled=true;
  /* Hide the reprocess affordance for the duration of the run — re-entering
     reprocessAll mid-batch would race with the active loop. updateChargePreview
     after the run will restore visibility if the new state still warrants it. */
  if(rb)rb.style.display='none';
  /* Allow user to cancel mid-batch */
  _processingCancelled=false;
  if(cb){cb.disabled=false;cb.textContent='Cancel';cb.dataset.mode='cancel';}
  var pw=G('progWrap'),pf=G('progFill'),pl=G('progLabel');if(pw)pw.classList.add('show');
  var processed=0,total=pending.length*af.length;

  for(var i=0;i<pending.length;i++){
    var item=pending[i];
    /* Reconcile result placeholders with the CURRENT format selection.
       Without this, cancelling mid-batch then changing formats and re-running
       would silently drop the new outputs — the inner loop tries to fill
       slots whose formats aren't in `af`, so the encoded blob is computed
       and then thrown away. Drop placeholders whose format is no longer
       wanted; add placeholders for any wanted format that doesn't have one. */
    /* Resolve every active format to a concrete output for THIS file
       (handles 'auto'). Both the cleanup pass and the placeholder pass work
       on the resolved set so item.results never carries the literal 'auto'. */
    var resolved=[];
    for(var rfi=0;rfi<af.length;rfi++){resolved.push(resolveFormatForFile(af[rfi],item.file));}
    var existingFmts={};
    for(var k=item.results.length-1;k>=0;k--){
      var rr=item.results[k];
      if(rr.blob){existingFmts[rr.format]=true;continue;} /* keep completed */
      if(resolved.indexOf(rr.format)===-1){
        _releaseNamedResultURL(rr);
        item.results.splice(k,1);
      }else{
        existingFmts[rr.format]=true;
      }
    }
    for(var fj=0;fj<resolved.length;fj++){
      if(!existingFmts[resolved[fj]]){
        item.results.push({id:'pending_'+resolved[fj]+'_'+i,format:resolved[fj],blob:null,url:null});
      }
    }
    updateCardResults(item);
  }
  updateChargePreview();

  for(var i=0;i<pending.length;i++){
    var item=pending[i];
    if(_processingCancelled)break;
    /* Live progress on the Process button itself: "Processing N of M…" */
    if(pb)pb.textContent='Processing '+(i+1)+' of '+pending.length+'…';
    for(var j=0;j<af.length;j++){
      if(_processingCancelled)break;
      /* Resolve 'auto' to a concrete format per file. Specific formats
         (webp/avif/jpg/png/gif) pass through unchanged. */
      var fmt=resolveFormatForFile(af[j],item.file);
      setCardProcessing(item,true,fmt);
      processed++;
      if(pf)pf.style.width=(processed/total*100)+'%';
      if(pl)pl.textContent='Processing '+processed+' of '+total+': '+item.file.name+' → '+fmt.toUpperCase();
      var slowTimer=null;
      if(fmt==='avif'){
        slowTimer=setTimeout(function(){
          if(pl)pl.textContent='Encoding AVIF — this may take a moment on larger images…';
        },AVIF_SLOW_THRESHOLD);
      }
      try{
        var src=item.decoded||item.file;
        if(item.needsConvert&&!item.decoded){src=await preDecodeFile(item.file);item.decoded=src;if(!item.origUrl)item.origUrl=URL.createObjectURL(src);}
        var settings=getSettings(fmt);
        /* For JPG-from-JPG re-encodes, aim a notch under the source's
           original quality so the output reliably shrinks. Same goal as
           below — hidden work; the user just wants a smaller file. */
        if(fmt==='jpg'){
          settings.quality=await adjustJpgQualityForSource(item.file,settings.quality);
        }
        var blob=await processImg(src,settings,fmt);
        /* If user opted OUT of EXIF stripping AND output is JPG from a JPG input, preserve it */
        if(settings.stripExif===false&&fmt==='jpg'){
          blob=await preserveExifIntoBlob(item.file,blob);
        }
        /* Silent shrink-or-keep guarantee for same-format re-encodes.
           If layer 1 (source-quality estimate) didn't produce a smaller
           file — possible for tiny images or sources where the estimator is
           off by a few points — try one or two lower quality steps before
           giving up and silently keeping the original blob. Floor at q=40
           so we don't ship visibly-degraded JPGs in pursuit of bytes. The
           user just sees a smaller file with a normal -% saving (or, in the
           rare keep-source case, a -0% saving — never a confusing +%). */
        var sourceFmtMatch=(fmt==='jpg'&&item.file.type==='image/jpeg')||
                           (fmt==='png'&&item.file.type==='image/png')||
                           (fmt==='webp'&&item.file.type==='image/webp');
        var hasResize=settings.maxDim>0;
        var hasCrop=currentCropRatio&&currentCropRatio!=='none';
        if(sourceFmtMatch&&!hasResize&&!hasCrop&&blob.size>=item.file.size&&fmt==='jpg'){
          var fallbackQs=[Math.max(0.4,settings.quality-0.10),Math.max(0.4,settings.quality-0.20)];
          for(var fqi=0;fqi<fallbackQs.length;fqi++){
            if(_processingCancelled)break;
            var s2={mime:settings.mime,quality:fallbackQs[fqi],maxDim:settings.maxDim,stripExif:settings.stripExif};
            var b2=await processImg(src,s2,fmt);
            if(s2.stripExif===false){b2=await preserveExifIntoBlob(item.file,b2);}
            if(b2.size<item.file.size){blob=b2;break;}
          }
        }
        if(sourceFmtMatch&&!hasResize&&!hasCrop&&blob.size>=item.file.size){
          /* Last resort: every retry was still larger. Quietly hand back the
             source — output is identical to input, saving reads as -0%. No
             callout, no "already optimised" pill — the user just sees a
             file they can download and move on with. */
          blob=item.file;
        }
        if(slowTimer)clearTimeout(slowTimer);
        for(var r=0;r<item.results.length;r++){
          if(item.results[r].format===fmt&&!item.results[r].blob){
            item.results[r].blob=blob;
            /* Wrap in a named URL so right-click "Save image as" gets a
               proper filename suggestion ("vacation_imgready.jpg") instead
               of the random blob hash. Falls back to a plain blob URL if
               the service worker isn't yet active. See _createNamedResultURL. */
            var _named = _createNamedResultURL(blob, item.file.name, fmt);
            item.results[r].url=_named.url;
            item.results[r].namedId=_named.id;
            item.results[r].id=Date.now()+'_r_'+Math.random().toString(36).slice(2);
            /* Track the quality the encoder actually used (post-smart-adjust)
               so the live editor's slider can restore its position when the
               user re-opens the modal. The global slider in Settings is a
               *request*; the encoder may have dropped lower for shrink-or-keep
               or smart-source tracking. The user sees the truth either way. */
            item.results[r].quality=settings.quality;
            break;
          }
        }
      }catch(err){
        if(slowTimer)clearTimeout(slowTimer);
        /* User-cancellation: pool.cancelAll rejected the in-flight job with
           the 'Cancelled' sentinel. Don't surface this as an error on the
           card — the post-loop sweep will splice the placeholder cleanly,
           leaving the cancelled card looking pending again. The break also
           saves us a needless next-format iteration on the same item. */
        if(_processingCancelled || (err && err.message === 'Cancelled')){
          break;
        }
        console.error('Failed:',item.file.name,fmt,err);
        /* Mark as errored instead of silently splicing — keep the row visible so user sees the failure. */
        for(var re=0;re<item.results.length;re++){
          if(item.results[re].format===fmt&&!item.results[re].blob){
            item.results[re].error=String(err&&err.message||err||'Encode failed');
            break;
          }
        }
        if(!item.errorMsg)item.errorMsg='One or more outputs failed — see rows below.';
      }
    }
    /* Live Photo video extraction. Runs once per item AFTER all
       still formats are encoded. Adds an MP4 result alongside the
       still results when:
         - the file was detected as a Live Photo (item.livePhoto set)
         - the user has the toggle on (livePhotoExtractEnabled())
         - we don't already have an MP4 result for this item (idempotent)
       The MOV bytes are sliced from the original file at the recorded
       offset and wrapped as a Blob with type video/mp4 — most apps
       play .mov inside a .mp4 wrapper, and the .mp4 extension is more
       universally accepted by share targets. */
    if(item.livePhoto && livePhotoExtractEnabled()){
      var hasMp4=false;
      for(var lpi=0;lpi<item.results.length;lpi++){
        if(item.results[lpi].format==='mp4'&&item.results[lpi].blob){hasMp4=true;break;}
      }
      if(!hasMp4){
        try{
          var lp=item.livePhoto;
          /* File.slice is a synchronous "view" — no copy until the bytes
             are actually read. Browsers handle this efficiently. */
          var movBlob=item.file.slice(lp.offset, lp.offset + lp.length, 'video/mp4');
          var named=_createNamedResultURL(movBlob, item.file.name, 'mp4');
          var mp4Result={
            id: Date.now()+'_mp4_'+Math.random().toString(36).slice(2),
            format: 'mp4',
            blob: movBlob,
            url: named.url,
            namedId: named.id,
            quality: null,
            isLivePhotoVideo: true,
          };
          item.results.push(mp4Result);
        } catch(err){
          console.warn('[imgready] Live Photo video extraction failed:', err);
          /* Don't error the card — the still result is still valid. */
        }
      }
    }
    setCardProcessing(item,false);
    updateCardResults(item);
    updateChargePreview();
    if(i%3===2)await new Promise(function(r){setTimeout(r,4);});
  }

  if(pf)pf.style.width='100%';
  if(pl)pl.textContent=_processingCancelled?'Cancelled':'All done!';
  setTimeout(function(){if(pw)pw.classList.remove('show');},600);
  if(cb){cb.disabled=false;cb.textContent='Clear All';delete cb.dataset.mode;}
  if(dlBtn)dlBtn.disabled=false;
  var _wasCancelled=_processingCancelled;
  /* When the user cancels mid-batch, the inner format loop breaks before
     filling every slot, leaving placeholder rows that buildResultsHTML renders
     forever as "processing...". Sweep them so cancelled cards present a clean
     state — keep completed blobs and explicit error rows. */
  if(_wasCancelled){
    for(var ci=0;ci<images.length;ci++){
      var cit=images[ci];
      var changed=false;
      for(var cri=cit.results.length-1;cri>=0;cri--){
        var crr=cit.results[cri];
        if(!crr.blob&&!crr.error){cit.results.splice(cri,1);changed=true;}
      }
      if(changed)updateCardResults(cit);
    }
  }
  _processingCancelled=false;
  /* Snapshot the settings that produced this batch. The Reprocess
     button compares this snapshot to the live settings and shows
     itself only when they differ — so users only ever see the
     button after they've actually changed something worth applying. */
  if(!_wasCancelled){_lastAppliedSettings=_captureSettings();}
  updateChargePreview();
  if(!_wasCancelled){maybeShowNudge();maybeAutoOpenFirstCompare();if(typeof window.maybeShowInstallPrompt==='function')window.maybeShowInstallPrompt();}
};
var _processingCancelled=false;

/* Auto-open compare modal removed in favor of trusting users.
   The "compare ›" hover affordance + the result-row click target telegraph the
   feature. Squoosh, TinyPNG and other beloved tools never auto-open modals —
   they let users discover features when ready. Restraint > tutorialization. */
function maybeAutoOpenFirstCompare(){/* intentionally a no-op */}

/* ========================================
   processImg — core encoding function
   FIX: white background applied before
   encoding when output format is JPG.
   This prevents transparent PNG/WebP
   inputs from producing black backgrounds.
   ======================================== */
/* ========================================
   WORKER POOL — moves all heavy decode/encode off the main thread.
   Falls back to the legacy main-thread path if module workers aren't
   supported or fail to instantiate. The fallback path is processImg_main()
   below; the public processImg() routes to the worker when it can.
   ======================================== */
var _workerPool = null;
var _workerPoolFailed = false;
var WORKER_URL = '/imgready-worker.js';

function getWorkerPool(){
  if(_workerPoolFailed) return null;
  if(_workerPool) return _workerPool;
  try{
    var n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    var pool = {
      size: n,
      workers: [],
      busy: [],
      queue: [],
      pending: {},
      nextId: 0,
    };
    for(var i = 0; i < n; i++){
      var w = new Worker(WORKER_URL);  /* classic worker — uses importScripts + dynamic import() */
      w.onmessage = function(e){
        var msg = e.data;
        var entry = pool.pending[msg.id];
        if(!entry) return;
        if(msg.type === 'result'){
          delete pool.pending[msg.id];
          var idx = pool.busy.indexOf(entry.worker);
          if(idx !== -1) pool.busy.splice(idx, 1);
          entry.resolve(msg.blob);
          drainQueue();
        } else if(msg.type === 'error'){
          delete pool.pending[msg.id];
          var idx2 = pool.busy.indexOf(entry.worker);
          if(idx2 !== -1) pool.busy.splice(idx2, 1);
          entry.reject(new Error(msg.message));
          drainQueue();
        } else if(msg.type === 'progress' && entry.onProgress){
          entry.onProgress(msg.stage);
        }
      };
      w.onerror = (function(deadWorker){ return function(err){
        console.error('Worker error:', err);
        /* Reject every pending job assigned to this worker so promises
           don't hang forever. The fallback path in processImg() will
           re-run them on the main thread. */
        var deadIds=Object.keys(pool.pending);
        for(var di=0;di<deadIds.length;di++){
          var dentry=pool.pending[deadIds[di]];
          if(dentry&&dentry.worker===deadWorker){
            delete pool.pending[deadIds[di]];
            dentry.reject(new Error('Worker crashed'));
          }
        }
        var widx=pool.busy.indexOf(deadWorker);
        if(widx!==-1)pool.busy.splice(widx,1);
        var widx2=pool.workers.indexOf(deadWorker);
        if(widx2!==-1)pool.workers.splice(widx2,1);
        pool.size=pool.workers.length||1;
        drainQueue();
      };})(w);
      pool.workers.push(w);
    }
    function drainQueue(){
      while(pool.queue.length && pool.busy.length < pool.size){
        var task = pool.queue.shift();
        var idle = pool.workers.find(function(wk){ return pool.busy.indexOf(wk) === -1; });
        if(!idle) break;
        pool.busy.push(idle);
        pool.pending[task.id] = { worker: idle, resolve: task.resolve, reject: task.reject, onProgress: task.onProgress };
        idle.postMessage({ id: task.id, action: 'process', file: task.file, fmt: task.fmt, settings: task.settings });
      }
    }
    pool.process = function(file, fmt, settings, onProgress){
      return new Promise(function(resolve, reject){
        pool.queue.push({ id: ++pool.nextId, file: file, fmt: fmt, settings: settings, resolve: resolve, reject: reject, onProgress: onProgress });
        drainQueue();
      });
    };
    /* Hard-cancel hook for the Cancel button. Without this, mid-AVIF
       cancellations sit on the user for up to 15 s while the in-flight
       encoder finishes its job before the loop sees the flag. We instead
       terminate every worker (the spec-correct way to interrupt WASM in
       a worker), reject every pending and queued promise with the
       sentinel `Cancelled` error, then null out the pool reference so
       the very next pool.process() call (next batch) lazily spins up a
       fresh set of workers via getWorkerPool. */
    pool.cancelAll = function(){
      var ids = Object.keys(pool.pending);
      for(var i = 0; i < ids.length; i++){
        var entry = pool.pending[ids[i]];
        if(entry){ try { entry.reject(new Error('Cancelled')); } catch(_){} }
      }
      pool.pending = {};
      for(var qi = 0; qi < pool.queue.length; qi++){
        try { pool.queue[qi].reject(new Error('Cancelled')); } catch(_){}
      }
      pool.queue.length = 0;
      for(var wi = 0; wi < pool.workers.length; wi++){
        try { pool.workers[wi].terminate(); } catch(_){}
      }
      pool.workers.length = 0;
      pool.busy.length = 0;
      _workerPool = null;
    };
    _workerPool = pool;
    return pool;
  }catch(e){
    console.warn('Worker pool unavailable, falling back to main-thread processing:', e);
    _workerPoolFailed = true;
    return null;
  }
}

/* Public processImg — routes to worker pool when possible, falls back to main-thread */
function processImg(file, s, fmt){
  /* SVG inputs stay on main thread (Image() unavailable in workers).
     The pre-decode SVG path in preDecodeFile already converts SVG→PNG before
     processImg is called, so by the time we get here the input is rasterized. */
  /* ICO output runs on main thread via processIco — the worker doesn't
     know about the multi-resolution ICO format and the encode work
     (canvas downsizing + PNG encode + binary packing) is small enough
     that worker round-trips would be wasteful. */
  if(fmt==='ico'){
    return processIco(file, s);
  }
  var pool = getWorkerPool();
  if(pool){
    var settings = {
      quality: s.quality,
      maxDim: s.maxDim,
      crop: currentCropRatio,
      stripExif: s.stripExif !== false
    };
    return pool.process(file, fmt, settings).catch(function(err){
      /* User-cancellation case: pool.cancelAll() rejected this with the
         sentinel 'Cancelled' error. Don't fall back to main-thread —
         the user explicitly asked us to stop. processAll's outer catch
         recognises the same sentinel and skips error-marking the slot. */
      if(_processingCancelled || (err && err.message === 'Cancelled')){
        throw err;
      }
      /* Any other worker failure: fall back to main-thread path */
      console.warn('Worker process failed, retrying on main thread:', err.message);
      return processImg_main(file, s, fmt);
    });
  }
  return processImg_main(file, s, fmt);
}

/* ICO output path — main-thread only. Loads the source, draws to a
   canvas, packs the multi-resolution ICO via encodeICO. The result
   blob is the ICO file; encodeICO also returns includedSizes and
   skippedSizes for the card-level "skipped" hint. */
function processIco(file, s){
  return new Promise(function(resolve, reject){
    var img=new Image();
    var url=URL.createObjectURL(file);
    img.onload=async function(){
      URL.revokeObjectURL(url);
      var w=img.naturalWidth, h=img.naturalHeight;
      /* Source canvas at full resolution — encodeICO handles squaring
         and per-size downsampling. We don't pre-resize via s.maxDim
         here because the resize input is for "longest side of the
         output image", which doesn't apply to ICO (the output IS the
         multi-resolution set defined by getIcoSizes). */
      var c=document.createElement('canvas');
      c.width=w; c.height=h;
      var ctx=c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      try{
        var sizes=getIcoSizes();
        var result=await encodeICO(c, sizes);
        /* Stash the skippedSizes on the blob so downstream code can
           surface a card-level note. The blob itself is the ICO file. */
        if(result.skippedSizes && result.skippedSizes.length){
          result.blob._skippedIcoSizes = result.skippedSizes;
        }
        resolve(result.blob);
      } catch(err){
        reject(err);
      }
    };
    img.onerror=function(){URL.revokeObjectURL(url);reject(new Error('Could not load source for ICO encoding'));};
    img.src=url;
  });
}

/* Legacy main-thread path — kept as fallback. Identical to the original
   processImg() before the worker refactor. */
function processImg_main(file,s,fmt){return new Promise(function(resolve,reject){
  var img=new Image();var url=URL.createObjectURL(file);
  img.onload=async function(){
    URL.revokeObjectURL(url);
    var w=img.naturalWidth,h=img.naturalHeight,sx=0,sy=0,sw=w,sh=h;
    var cropRatio=CROP_RATIOS[currentCropRatio];
    if(cropRatio){if(w/h>cropRatio){sw=Math.round(h*cropRatio);sx=Math.round((w-sw)/2);}else{sh=Math.round(w/cropRatio);sy=Math.round((h-sh)/2);}w=sw;h=sh;}
    if(s.maxDim){var longest=Math.max(w,h);if(longest>s.maxDim){var scale=s.maxDim/longest;w=Math.round(w*scale);h=Math.round(h*scale);}}
    var c=document.createElement('canvas');c.width=w;c.height=h;
    var ctx=c.getContext('2d');
    /* WHITE BACKGROUND FIX:
       JPG has no transparency support. Without this, transparent
       pixels from PNG/WebP inputs render as black in the output.
       We paint the canvas white before drawing the image. */
    if(fmt==='jpg'){
      ctx.fillStyle='#ffffff';
      ctx.fillRect(0,0,w,h);
    }
    ctx.drawImage(img,sx,sy,sw,sh,0,0,w,h);
    try{
      var blob;
      if(fmt==='avif'||(fmt==='webp'&&isIOS)){
        blob=await encodeWithJsquash(c,fmt,s.quality);
      } else if(fmt==='png'&&s.quality!==undefined&&s.quality<1.0&&typeof UPNG!=='undefined'){
        blob=encodeWithUPNG(c,s.quality);
      } else {
        blob=await new Promise(function(res,rej){
          c.toBlob(function(b){b?res(b):rej(new Error('Encode failed'));},s.mime,s.quality);
        });
      }
      resolve(blob);
    }catch(err){reject(err);}
  };
  img.onerror=function(){URL.revokeObjectURL(url);reject(new Error('Load failed'));};
  img.src=url;
});}

/* ========================================
   FULLSCREEN COMPARE
   ======================================== */
var fsZoom=1,fsPanX=0,fsPanY=0,fsPinchDist=0,fsHideTimer=null;
var fsCurrentItem=null,fsCurrentIdx=0,fsScrollY=0;
/* Tracked ObjectURLs for the fullscreen modal — revoked when replaced or closed.
   The "before" canvas (cropped preview) and the "after" live re-encode each
   create new URLs every time settings change, so without these we leaked one
   URL per slider tick. */
var _fsBeforeUrl=null,_fsAfterUrl=null;
/* Where focus was when fullscreen opened — restored on close so keyboard users
   don't get dropped at the top of the page. */
var _fsTriggerEl=null;
function updateFsZoom(){
  var t='translate('+fsPanX+'px,'+fsPanY+'px) scale('+fsZoom+')';
  var w=G('fsZoom');if(w)w.style.transform=t;
  var wa=G('fsZoomAfter');if(wa)wa.style.transform=t;
}
function showZoomLevel(){
  var zl=G('fsZoomLevel');if(!zl)return;
  zl.textContent=Math.round(fsZoom*100)+'%';zl.style.display='block';
  if(fsHideTimer)clearTimeout(fsHideTimer);
  fsHideTimer=setTimeout(function(){zl.style.display='none';},1200);
}
function setFsP(pct){
  pct=Math.max(0,Math.min(100,pct));
  var d=G('fsDiv');if(d)d.style.left=pct+'%';
  var h=G('fsHdl');if(h)h.style.left=pct+'%';
  var cl=G('fsClip');if(cl)cl.style.clipPath='inset(0 0 0 '+pct+'%)';
}
function mvFs(e){
  var r=G('fsInner');if(!r)return;
  /* Deadzones — when the touch/click originates inside one of the
     overlay UI elements (bottom toolbar, close button, encoding pulse,
     zoom-level chip, format/quality controls), don't shift the compare
     bar. Without this, dragging the quality slider in the toolbar would
     also drag the compare divider since both listen to touchmove on
     fsInner. The check uses .closest() so any nested target inside a
     deadzone is caught regardless of nesting depth. */
  var t=e.target;
  if(t && t.closest){
    if(t.closest('.fs-editor') ||
       t.closest('.fs-close') ||
       t.closest('.fs-encoding-pulse') ||
       t.closest('.fs-zoom-level') ||
       t.closest('.fs-lbl')){
      return;
    }
  }
  var rect=r.getBoundingClientRect();
  var cx=e.touches?e.touches[0].clientX:e.clientX;
  setFsP((cx-rect.left)/rect.width*100);
}
window.thumbClick=function(imgId){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item)return;
  var doneResults=item.results.filter(function(r){return r.blob;});
  if(doneResults.length>0){window.openFS(imgId,item.results.indexOf(doneResults[0]));}
  else if(item.origUrl){window.openPreview(imgId);}
};
window.openPreview=function(imgId){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item)return;
  var modalWasOpen=G('fsModal').classList.contains('show');
  /* For HEIC / TIFF / BMP inputs, origUrl isn't ready immediately —
     decoding takes 1–3 s. Open the modal anyway with an empty fsBefore
     and a "Decoding…" pulse; once preDecodeFile lands the origUrl,
     poll-and-populate fsBefore without flashing the modal. The
     `_fsPreviewItemId` guard means a drop-switch in the meantime
     cancels this pending update. */
  if(!item.origUrl){
    /* Mark the modal as decoding so the centred "Decoding HEIC…" treatment
       kicks in (CSS hides the image, recentres the pulse pill). Cleared
       once origUrl arrives or the user moves on. */
    G('fsInner').classList.add('fs-decoding');
    var startedAt=performance.now();
    var pollOrig=function(){
      if(_fsPreviewItemId!==item.id){G('fsInner').classList.remove('fs-decoding');return;}
      if(item.errorMsg){G('fsInner').classList.remove('fs-decoding');return;}
      if(item.origUrl){
        var bef=G('fsBefore');if(bef)bef.src=item.origUrl;
        G('fsInner').classList.remove('fs-decoding');
        return;
      }
      /* Hard cap: if still no origUrl after ~30 s, decode probably failed
         silently — stop polling rather than spin forever. */
      if(performance.now()-startedAt>30000){G('fsInner').classList.remove('fs-decoding');return;}
      setTimeout(pollOrig,100);
    };
    setTimeout(pollOrig,100);
  } else {
    G('fsInner').classList.remove('fs-decoding');
  }
  /* If the modal was already showing a different subject (modal-drop case),
     clean up its tracked URLs and live-editor state before flipping subject.
     Without this we'd leak ObjectURLs and re-encode against the previous
     bitmap on the first slider tick. */
  if(modalWasOpen){
    if(_fsBeforeUrl){URL.revokeObjectURL(_fsBeforeUrl);_fsBeforeUrl=null;}
    if(_fsAfterUrl){URL.revokeObjectURL(_fsAfterUrl);_fsAfterUrl=null;}
    fsCurrentItem=null;feLiveBlob=null;feLiveFmt='';feOrigBitmap=null;feBitmapPromise=null;
    feApplied=false;
  } else {
    /* Capture the focused element on open (only on the *first* open) so we
       can restore on close. Drops-while-open shouldn't re-capture. */
    _fsTriggerEl=document.activeElement;
  }
  G('fsBefore').src=item.origUrl||'';G('fsAfter').src='';
  /* Reset only the dynamic rows (info + savings). The .fs-lbl-title
     spans hold the static "Before"/"After" headings and stay intact —
     wiping textContent on the parent would destroy them and break the
     stacked layout on next open. */
  (function(){
    var bb=G('fsLblBefore'),aa=G('fsLblAfter');
    if(bb){var bi=bb.querySelector('.fs-lbl-info');if(bi)bi.textContent='';}
    if(aa){
      var ai=aa.querySelector('.fs-lbl-info');if(ai)ai.textContent='';
      var as=aa.querySelector('.fs-lbl-savings');if(as){as.textContent='';as.classList.remove('bad');}
    }
  })();
  G('fsInner').classList.add('fs-preview-only');
  /* Mark this item as the preview subject. transitionPreviewToResult uses
     this to ignore late callbacks from a previous subject the user has
     since dropped past. */
  _fsPreviewItemId=imgId;
  /* Kick off the encode progress bar for big files. Resolves the output
     format the same way processAll will (so 'auto' becomes the right
     concrete format for the estimate). */
  try{
    var af=getActiveFormats();
    var fmtForEst=resolveFormatForFile(af[0]||'auto',item.file);
    startEncodeProgress(item.file,fmtForEst);
  }catch(_){}
  fsZoom=1;fsPanX=0;fsPanY=0;updateFsZoom();
  if(!modalWasOpen){
    G('fsModal').classList.add('show');
    fsScrollY=window.scrollY;document.body.classList.add('fs-open');document.body.style.top=(-fsScrollY)+'px';
    /* Move focus into the modal — close button is a sensible target. */
    var closeBtn=document.querySelector('.fs-close');if(closeBtn)closeBtn.focus();
  }
};
/* Tracks which item the modal is currently in *preview* mode for. A
   drop-into-modal can swap the subject mid-encode; when the previous item's
   encoder eventually returns, transitionPreviewToResult must NOT hijack the
   modal away from the user's new subject. */
var _fsPreviewItemId=null;

/* Time-based progress bar for the encoding pulse.
   For inputs above ~5 MB the dot-only pulse felt stalled — AVIF on a 10 MB
   photo can take 15 seconds. We estimate total encode time from input size
   + target format and fill a bar over that estimate, capped at 95% until
   the real result lands. Estimates are deliberately generous: it's better
   for the bar to finish "early" (snap to 100%) than to claim 100% before
   the file is ready. */
var _encodeProgressTimer=null;
var _encodeTextRotateTimer=null;
var _encodeTextStrings=['Compressing…','Squeezing pixels…','Almost there…','Optimizing…'];
var ENCODE_BAR_THRESHOLD_BYTES=5*1024*1024; /* show bar above 5 MB */
function _rotatePulseText(){
  var el=G('fsPulseText');
  if(!el)return;
  /* Cross-fade by toggling .swap-out for 280 ms, swapping the text mid-fade. */
  el.classList.add('swap-out');
  setTimeout(function(){
    var idx=(_encodeTextStrings.indexOf(el.textContent)+1)%_encodeTextStrings.length;
    if(idx<0)idx=0;
    el.textContent=_encodeTextStrings[idx];
    el.classList.remove('swap-out');
  },280);
}
function _estimateEncodeSeconds(file,outputFmt){
  var mb=Math.max(0.5,(file?file.size:0)/1048576);
  /* Rough seconds-per-MB by output format on a typical mid-range desktop.
     AVIF is the slow one; everything else lands quickly. Add a small fixed
     overhead for HEIC/TIFF inputs that need a separate decode pass. */
  var perMb={avif:1.5,webp:0.3,jpg:0.4,png:0.5,gif:0.2}[outputFmt]||0.5;
  var decodeOverhead=(file&&(/\.(heic|heif|tif|tiff|bmp)$/i).test(file.name))?1.0+mb*0.4:0;
  return Math.max(0.4,decodeOverhead+mb*perMb);
}
function startEncodeProgress(file,outputFmt){
  stopEncodeProgress();
  var textEl=G('fsPulseText');
  if(textEl){
    /* Exotic inputs (HEIC/TIFF/BMP) need a separate decode pass before
       the encoder runs — calling that out by name in the pulse tells the
       user "we're working on the file, not stuck." Subsequent rotations
       cycle to the standard "Compressing…" / "Squeezing pixels…" set. */
    var ext=file&&file.name?(file.name.split('.').pop()||'').toLowerCase():'';
    var isExoticInput=ext==='heic'||ext==='heif'||ext==='tif'||ext==='tiff'||ext==='bmp';
    textEl.textContent=isExoticInput?('Decoding '+ext.toUpperCase()+'…'):'Compressing…';
    textEl.classList.remove('swap-out');
  }
  var bar=G('fsPulseBar'),fill=G('fsPulseBarFill');
  if(!bar||!fill)return;
  var isBig=file&&file.size>=ENCODE_BAR_THRESHOLD_BYTES;
  if(!isBig){
    bar.classList.remove('show');
    return;
  }
  bar.classList.add('show');
  fill.style.width='0%';
  var est=_estimateEncodeSeconds(file,outputFmt)*1000;
  var start=performance.now();
  _encodeProgressTimer=setInterval(function(){
    var elapsed=performance.now()-start;
    /* Asymptotic curve: fill quickly toward the estimate, then ease off as
       we approach 95%. Never reach 100% from the timer alone — that's
       reserved for the real result landing. */
    var pct=Math.min(95,(elapsed/(est+elapsed))*100);
    fill.style.width=pct.toFixed(1)+'%';
  },120);
  /* Rotate the loading text only when the wait will actually be long
     enough to read multiple strings — sub-threshold encodes finish before
     the second word would land. */
  _encodeTextRotateTimer=setInterval(_rotatePulseText,2200);
}
function stopEncodeProgress(){
  if(_encodeProgressTimer){clearInterval(_encodeProgressTimer);_encodeProgressTimer=null;}
  if(_encodeTextRotateTimer){clearInterval(_encodeTextRotateTimer);_encodeTextRotateTimer=null;}
  var bar=G('fsPulseBar'),fill=G('fsPulseBarFill');
  var textEl=G('fsPulseText');
  if(fill)fill.style.width='100%';
  if(textEl){textEl.classList.remove('swap-out');textEl.textContent='Done.';}
  /* Hide the bar after a tiny delay so the 100% snap is briefly visible. */
  setTimeout(function(){
    if(bar)bar.classList.remove('show');
    if(fill)fill.style.width='0%';
    if(textEl)textEl.textContent='Compressing…';
  },280);
}

/* Promote an already-open preview-mode modal to full result mode without
   re-opening it. Used by the solo-magic flow: the modal pops on drop in
   preview-only mode, encoding finishes, and this swaps in the result side
   + brings up the live editor. No flash, no second click. */
window.transitionPreviewToResult=function(item,resultIdx){
  if(!item||!item.results||!item.results[resultIdx]||!item.results[resultIdx].blob)return;
  if(!G('fsModal').classList.contains('show')){
    /* Modal isn't actually open — caller should fall back to openFS. */
    return window.openFS&&window.openFS(item.id,resultIdx);
  }
  /* Guard: if the modal has been re-pointed at a different subject (drop-
     in-modal swapped it), the late-completing encoder for the *old* subject
     should silently land in the grid behind the modal — not yank the user
     away from what they're now looking at. */
  if(_fsPreviewItemId&&_fsPreviewItemId!==item.id)return;
  fsCurrentItem=item;fsCurrentIdx=resultIdx;
  /* Encoding done — snap the progress bar to 100% then hide. */
  stopEncodeProgress();
  G('fsInner').classList.remove('fs-preview-only');
  G('fsInner').classList.remove('fs-decoding');
  showFsResult(resultIdx);
  setFsP(50);
  feInit(item,resultIdx);
  _fsPreviewItemId=null; /* preview phase ended for this item */
};

window.openFS=function(imgId,resultIdx){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item||!item.results[resultIdx]||!item.origUrl)return;
  /* Capture the focused element BEFORE we open so we can restore on close. */
  _fsTriggerEl=document.activeElement;
  fsCurrentItem=item;fsCurrentIdx=resultIdx;
  G('fsInner').classList.remove('fs-preview-only');

  var cropRatio=CROP_RATIOS[currentCropRatio];
  if(cropRatio&&item.natW&&item.natH){
    var img=new Image();
    img.onload=function(){
      var w=img.naturalWidth,h=img.naturalHeight,sx=0,sy=0,sw=w,sh=h;
      if(w/h>cropRatio){sw=Math.round(h*cropRatio);sx=Math.round((w-sw)/2);}
      else{sh=Math.round(w/cropRatio);sy=Math.round((h-sh)/2);}
      var c=document.createElement('canvas');c.width=sw;c.height=sh;
      c.getContext('2d').drawImage(img,sx,sy,sw,sh,0,0,sw,sh);
      c.toBlob(function(b){
        if(!b)return;
        if(_fsBeforeUrl)URL.revokeObjectURL(_fsBeforeUrl);
        _fsBeforeUrl=URL.createObjectURL(b);
        G('fsBefore').src=_fsBeforeUrl;
      });
    };
    img.src=item.origUrl;
  } else {
    G('fsBefore').src=item.origUrl;
  }

  showFsResult(resultIdx);
  fsZoom=1;fsPanX=0;fsPanY=0;updateFsZoom();
  setFsP(50);G('fsModal').classList.add('show');
  fsScrollY=window.scrollY;document.body.classList.add('fs-open');document.body.style.top=(-fsScrollY)+'px';
  feInit(item,resultIdx);
  /* Move focus into the modal so screen readers + keyboard users know it
     opened. Close button is the safest target — always present, always
     correctly labeled. */
  var closeBtn=document.querySelector('.fs-close');if(closeBtn)closeBtn.focus();
};
function showFsResult(idx){
  if(!fsCurrentItem||!fsCurrentItem.results[idx])return;
  fsCurrentIdx=idx;
  var r=fsCurrentItem.results[idx];
  if(!r.url)return;
  G('fsAfter').src=r.url;
  /* Stacked "Before" / "After" labels — three-row structure:
       Row 1: title (large)
       Row 2: size · format
       Row 3 (after only): savings %
     The After savings row uses .bad class when the result was larger
     than the input (rare, e.g. small JPG → AVIF re-encode), which
     swaps the color from success-green to warn-orange. */
  var inputFmt=(getFileExt(fsCurrentItem.file.name)||'').toUpperCase();
  var beforeLbl=G('fsLblBefore');
  if(beforeLbl){
    var bInfo=beforeLbl.querySelector('.fs-lbl-info');
    if(bInfo) bInfo.textContent=fmtSize(fsCurrentItem.file.size)+(inputFmt?' · '+inputFmt:'');
  }
  var sv=fsCurrentItem.file.size-r.blob.size,pc=Math.round(sv/fsCurrentItem.file.size*100);
  var afterLbl=G('fsLblAfter');
  if(afterLbl){
    var aInfo=afterLbl.querySelector('.fs-lbl-info');
    var aSav=afterLbl.querySelector('.fs-lbl-savings');
    if(aInfo) aInfo.textContent=fmtSize(r.blob.size)+' · '+r.format.toUpperCase();
    if(aSav){
      aSav.textContent=sv>=0?pc+'% smaller':Math.abs(pc)+'% larger';
      aSav.classList.toggle('bad',sv<0);
    }
  }
}
window.closeFullscreen=function(){
  /* Live slider movements auto-commit; closing the modal is purely visual.
     The card behind has already been updated with the latest blob/format. */
  G('fsModal').classList.remove('show');
  document.body.classList.remove('fs-open');document.body.style.top='';window.scrollTo(0,fsScrollY);
  G('fsInner').classList.remove('fs-preview-only');
  G('fsInner').classList.remove('fs-decoding');
  fsZoom=1;fsPanX=0;fsPanY=0;fsCurrentItem=null;feApplied=false;
  feLiveBlob=null;feLiveFmt='';feOrigBitmap=null;feBitmapPromise=null;
  _fsPreviewItemId=null;
  /* Stop the progress bar + text rotation if user closed mid-encode. */
  if(_encodeProgressTimer){clearInterval(_encodeProgressTimer);_encodeProgressTimer=null;}
  if(_encodeTextRotateTimer){clearInterval(_encodeTextRotateTimer);_encodeTextRotateTimer=null;}
  var pulseBar=G('fsPulseBar');if(pulseBar)pulseBar.classList.remove('show');
  var pulseFill=G('fsPulseBarFill');if(pulseFill)pulseFill.style.width='0%';
  var pulseTxt=G('fsPulseText');if(pulseTxt){pulseTxt.classList.remove('swap-out');pulseTxt.textContent='Compressing…';}
  /* Free the modal's tracked ObjectURLs. */
  if(_fsBeforeUrl){URL.revokeObjectURL(_fsBeforeUrl);_fsBeforeUrl=null;}
  if(_fsAfterUrl){URL.revokeObjectURL(_fsAfterUrl);_fsAfterUrl=null;}
  /* Restore focus to whatever opened the modal (if it's still in the DOM
     and focusable). Fall back to body if the trigger element is gone. */
  if(_fsTriggerEl&&document.body.contains(_fsTriggerEl)&&typeof _fsTriggerEl.focus==='function'){
    try{_fsTriggerEl.focus();}catch(_){}
  }
  _fsTriggerEl=null;
};
/* applyFsEdit removed — the live editor's slider/format-swap auto-commit
   to the result slot inside feReEncode now. The Apply button is gone from
   the modal UI. Closing the modal preserves whatever the user is looking
   at; re-opening restores the slider position from the recorded quality. */
/* Hover preview: when the user hovers a result row, swap the card thumbnail to
   that format's blob URL so they can eyeball each format without opening the
   modal. resultIdx === -1 restores the first-result thumbnail (the default).
   This was previously called from result-row onmouseenter/onmouseleave but the
   function definition was missing — every hover threw a ReferenceError. */
window.previewFmt=function(itemId,resultIdx){
  var item=null;
  for(var i=0;i<images.length;i++){if(images[i].id===itemId){item=images[i];break;}}
  if(!item)return;
  var card=document.querySelector('.card[data-id="'+item.id+'"]');
  if(!card)return;
  var thumbImg=card.querySelector('.card-thumb .plain-img');
  if(!thumbImg)return;
  var src=null;
  if(resultIdx>=0&&item.results[resultIdx]&&item.results[resultIdx].url){
    src=item.results[resultIdx].url;
  }else{
    /* Restore: first completed result, else the original */
    for(var k=0;k<item.results.length;k++){
      if(item.results[k].blob&&item.results[k].url){src=item.results[k].url;break;}
    }
    if(!src)src=item.origUrl||null;
  }
  if(src&&thumbImg.src!==src)thumbImg.src=src;
};
var feApplied=false;

/* ========================================
   LIVE EDITOR
   feReEncode also gets the white background
   fix so the live editor is consistent.
   ======================================== */
var feLiveBlob=null,feLiveFmt='',feDebounceTimer=null,feOrigBitmap=null;
/* Pending decode promise — feReEncode awaits this so a quality-slider tick that
   fires while the bitmap is still decoding doesn't silently no-op. */
var feBitmapPromise=null;
var FE_FMTS=['webp','avif','jpg','png'];
function feInit(item,resultIdx){
  var fmtEl=G('feFmt');
  var startFmt=item.results[resultIdx]?item.results[resultIdx].format:'webp';
  feLiveFmt=startFmt;
  var html='';
  for(var i=0;i<FE_FMTS.length;i++){
    var f=FE_FMTS[i];
    var act=f===startFmt?' class="active"':'';
    html+='<button'+act+' onclick="feSwitchFmt(\''+f+'\')">'+f.toUpperCase()+'</button>';
  }
  fmtEl.innerHTML=html;
  /* Reveal the Share button only on browsers where Web Share API
     supports files. Same feature flag the per-card Share button uses. */
  var feShareBtn=G('feShareBtn');
  if(feShareBtn){
    feShareBtn.style.display=window._shareSupportedFiles===true?'':'none';
  }
  /* Slider position priority:
     1. The quality the encoder actually used for THIS result (post-smart-adjust).
     2. Fall back to the global Settings slider if no recorded quality exists.
     This keeps the modal's slider truthful: it shows what the visible blob
     was encoded at, never a stale default. */
  var storedQ=item.results[resultIdx]&&typeof item.results[resultIdx].quality==='number'
    ? item.results[resultIdx].quality
    : null;
  var startQ=Math.round((storedQ!==null?storedQ:(getSettings(startFmt).quality||0.82))*100);
  var sl=G('feQSlider');sl.value=startQ;
  G('feQVal').textContent=startQ;
  feUpdateQDisabled();
  if(item.results[resultIdx]&&item.results[resultIdx].blob){
    feLiveBlob=item.results[resultIdx].blob;
    G('feSize').textContent=fmtSize(feLiveBlob.size);
  }
  feOrigBitmap=null;
  var origSrc=item.decoded||item.file;
  /* Capture the decode promise so feReEncode can await it. The previous code
     fired-and-forgot the promise, so any slider movement before the bitmap
     resolved hit the `if(!feOrigBitmap)return` guard and did nothing. */
  feBitmapPromise=createImageBitmap(origSrc).then(function(bmp){feOrigBitmap=bmp;return bmp;}).catch(function(){
    /* Fallback: round-trip the origUrl through an <img> first, then bitmap. */
    return new Promise(function(resolve){
      if(!item.origUrl){resolve(null);return;}
      var img=new Image();
      img.onload=function(){createImageBitmap(img).then(function(bmp){feOrigBitmap=bmp;resolve(bmp);}).catch(function(){resolve(null);});};
      img.onerror=function(){resolve(null);};
      img.src=item.origUrl;
    });
  });
}
function feUpdateQDisabled(){
  var sl=G('feQSlider');
  var isGif=(feLiveFmt==='gif');
  sl.disabled=isGif;sl.style.opacity=isGif?'.3':'1';
}
window.feSwitchFmt=function(f){
  feLiveFmt=f;
  var btns=G('feFmt').getElementsByTagName('button');
  for(var i=0;i<btns.length;i++)btns[i].classList.toggle('active',btns[i].textContent.toLowerCase()===f);
  feUpdateQDisabled();
  feReEncode();
};
(function(){
  var sl=G('feQSlider');if(!sl)return;
  sl.addEventListener('input',function(){
    G('feQVal').textContent=sl.value;
    if(feDebounceTimer)clearTimeout(feDebounceTimer);
    feDebounceTimer=setTimeout(feReEncode,300);
  });
})();
async function feReEncode(){
  if(!fsCurrentItem)return;
  var spinner=G('feSpinner');if(spinner)spinner.style.display='block';
  /* Bitmap decode happens asynchronously in feInit. If a slider tick fires
     before it lands, wait for it instead of silently bailing. */
  if(!feOrigBitmap&&feBitmapPromise){
    try{await feBitmapPromise;}catch(_){}
  }
  if(!feOrigBitmap){if(spinner)spinner.style.display='none';return;}
  var q=parseInt(G('feQSlider').value)/100;
  var isLossless=(feLiveFmt==='png'&&q>=1.0);
  var bmp=feOrigBitmap;
  var w=bmp.width,h=bmp.height,sx=0,sy=0,sw=w,sh=h;
  var cropRatio=CROP_RATIOS[currentCropRatio];
  if(cropRatio){if(w/h>cropRatio){sw=Math.round(h*cropRatio);sx=Math.round((w-sw)/2);}else{sh=Math.round(w/cropRatio);sy=Math.round((h-sh)/2);}w=sw;h=sh;}
  var maxDim=parseInt((G('resizeMax')||{}).value)||0;
  if(maxDim){var longest=Math.max(w,h);if(longest>maxDim){var scale=maxDim/longest;w=Math.round(w*scale);h=Math.round(h*scale);}}
  var c=document.createElement('canvas');c.width=w;c.height=h;
  var ctx=c.getContext('2d');
  /* WHITE BACKGROUND FIX for live editor */
  if(feLiveFmt==='jpg'){
    ctx.fillStyle='#ffffff';
    ctx.fillRect(0,0,w,h);
  }
  ctx.drawImage(bmp,sx,sy,sw,sh,0,0,w,h);
  try{
    var blob;
    if(feLiveFmt==='avif'||(feLiveFmt==='webp'&&isIOS)){
      blob=await encodeWithJsquash(c,feLiveFmt,isLossless?undefined:q);
    } else if(feLiveFmt==='png'&&!isLossless&&typeof UPNG!=='undefined'){
      blob=encodeWithUPNG(c,q);
    } else {
      var mimeMap={webp:'image/webp',jpg:'image/jpeg',png:'image/png'};
      var mime=mimeMap[feLiveFmt]||'image/jpeg';
      blob=await new Promise(function(res,rej){
        c.toBlob(function(b){b?res(b):rej(new Error('Encode failed'));},mime,isLossless?undefined:q);
      });
    }
    if(spinner)spinner.style.display='none';
    feLiveBlob=blob;
    G('feSize').textContent=fmtSize(blob.size);
    /* Each slider tick re-encodes — track + revoke so we don't leak per tick. */
    if(_fsAfterUrl)URL.revokeObjectURL(_fsAfterUrl);
    _fsAfterUrl=URL.createObjectURL(blob);
    var afterImg=G('fsAfter');if(afterImg)afterImg.src=_fsAfterUrl;
    if(fsCurrentItem){
      /* Same stacked shape as showFsResult — populates the same three
         spans inside each label. Lives in two places (this re-encode
         path + the initial render in showFsResult) and they MUST stay
         in sync; if either drifts, the labels jitter as the slider
         drags. The .fs-lbl-title spans are static ("Before"/"After")
         so we don't touch them — only info + savings update. */
      var inputFmtL=(getFileExt(fsCurrentItem.file.name)||'').toUpperCase();
      var bLbl=G('fsLblBefore');
      if(bLbl){
        var bInfoEl=bLbl.querySelector('.fs-lbl-info');
        if(bInfoEl) bInfoEl.textContent=fmtSize(fsCurrentItem.file.size)+(inputFmtL?' · '+inputFmtL:'');
      }
      var sv=fsCurrentItem.file.size-blob.size,pc=Math.round(sv/fsCurrentItem.file.size*100);
      var aLbl=G('fsLblAfter');
      if(aLbl){
        var aInfoEl=aLbl.querySelector('.fs-lbl-info');
        var aSavEl=aLbl.querySelector('.fs-lbl-savings');
        if(aInfoEl) aInfoEl.textContent=fmtSize(blob.size)+' · '+feLiveFmt.toUpperCase();
        if(aSavEl){
          aSavEl.textContent=sv>=0?pc+'% smaller':Math.abs(pc)+'% larger';
          aSavEl.classList.toggle('bad',sv<0);
        }
      }
      /* Auto-commit: the live re-encode IS the saved result. The Apply
         button is gone — the slider position is the saved quality, the
         visible blob is the saved blob. Closing the modal preserves
         exactly what the user is looking at. */
      var slot=fsCurrentItem.results[fsCurrentIdx];
      if(slot){
        var oldUrl=slot.url;
        var oldNamedId=slot.namedId;
        slot.blob=blob;
        /* Re-mint a named URL for the live re-encoded blob so right-click
           on the card thumbnail (post-modal) still suggests the proper
           branded filename. _releaseNamedResultURL on the old slot would
           also release the SW registration, but we've replaced the slot
           in place; release the OLD entries explicitly below. */
        var _named2 = _createNamedResultURL(blob, fsCurrentItem.file.name, feLiveFmt);
        slot.url=_named2.url;
        slot.namedId=_named2.id;
        slot.format=feLiveFmt;
        slot.quality=q;
        /* Release old artifacts. Skip _fsAfterUrl which is owned by the
           live editor and revoked separately when the modal closes. */
        if(oldNamedId){
          var ctrl3=navigator.serviceWorker&&navigator.serviceWorker.controller;
          if(ctrl3){try{ctrl3.postMessage({type:'release-blob',id:oldNamedId});}catch(_){}}
        } else if(oldUrl&&oldUrl!==_fsAfterUrl&&typeof oldUrl==='string'&&oldUrl.indexOf('blob:')===0){
          URL.revokeObjectURL(oldUrl);
        }
        feApplied=true;
        try{updateCardResults(fsCurrentItem);updateChargePreview();}catch(_){}
      }
    }
  }catch(err){
    if(spinner)spinner.style.display='none';
    console.error('Live re-encode failed:',err);
  }
}
/* Helper used by all three fullscreen action buttons — gives the live
   blob a sensible filename derived from the original image's name. */
function _feCurrentFilename(){
  if(!feLiveBlob||!fsCurrentItem)return null;
  var ext={'image/webp':'webp','image/avif':'avif','image/png':'png','image/jpeg':'jpg'}[feLiveBlob.type]||feLiveFmt;
  return fsCurrentItem.file.name.replace(/\.[^.]+$/,'')+'.'+ext;
}

window.feLiveDl=function(){
  var name=_feCurrentFilename();
  if(!name)return;
  /* Pure download — fullscreen editor's Download button is for "save a
     file." Share has its own button now. */
  triggerDownload(feLiveBlob,name);
};

window.feLiveShare=async function(){
  if(!window._shareSupportedFiles)return;
  var name=_feCurrentFilename();
  if(!name)return;
  try{
    var file=new File([feLiveBlob],name,{type:feLiveBlob.type||'application/octet-stream'});
    var data={files:[file]};
    if(!navigator.canShare(data)){
      /* Runtime payload rejected for this specific blob — fall through
         to a download so the user isn't stranded. */
      return triggerDownload(feLiveBlob,name);
    }
    var btn=G('feShareBtn');if(btn)btn.disabled=true;
    try{
      await navigator.share(data);
      window._userDownloadedAtLeastOnce=true;
    } finally {
      if(btn)btn.disabled=false;
    }
  } catch(err){
    if(err && err.name==='AbortError')return; /* user cancelled */
    console.warn('[imgready] feLiveShare failed:',err);
  }
};

window.feLiveCopy=async function(btn){
  /* Mirror of copyResult, but for the live blob in the fullscreen
     editor instead of a per-card result. PNG is the only universally-
     accepted clipboard image type, so we transcode if needed. */
  if(!feLiveBlob||!fsCurrentItem)return;
  if(typeof navigator.clipboard==='undefined' || typeof window.ClipboardItem==='undefined'){
    /* No clipboard image API — fall back to download so the click
       still produces something useful. */
    return window.feLiveDl();
  }
  var origHTML=btn?btn.innerHTML:'';
  var svgCheck='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  if(btn){btn.innerHTML='<span class="spin-sm"></span>';btn.disabled=true;}
  try{
    var pngBlob;
    if(feLiveBlob.type==='image/png'){
      pngBlob=feLiveBlob;
    } else {
      pngBlob=await new Promise(function(resolve,reject){
        var url=URL.createObjectURL(feLiveBlob);
        var img=new Image();
        img.onload=function(){
          var c=document.createElement('canvas');
          c.width=img.naturalWidth;c.height=img.naturalHeight;
          c.getContext('2d').drawImage(img,0,0);
          c.toBlob(function(b){URL.revokeObjectURL(url);b?resolve(b):reject(new Error('PNG conversion failed'));},'image/png');
        };
        img.onerror=function(){URL.revokeObjectURL(url);reject(new Error('Image load failed'));};
        img.src=url;
      });
    }
    await navigator.clipboard.write([new ClipboardItem({'image/png':pngBlob})]);
    if(btn){
      btn.innerHTML=svgCheck;
      btn.disabled=false;
      setTimeout(function(){btn.innerHTML=origHTML;},1500);
    }
  } catch(err){
    console.warn('[imgready] feLiveCopy failed:',err);
    if(btn){btn.innerHTML=origHTML;btn.disabled=false;}
    if(!err || err.name!=='NotAllowedError')window.feLiveDl();
  }
};

/* ========================================
   SHARE — Web Share API integration

   Goal: on devices that support file-sharing through the OS share sheet
   (iOS Safari, Android Chrome, Edge, Safari desktop), let the user send
   their results straight to Messages/Mail/WhatsApp/AirDrop without ever
   touching the local filesystem. On phones this is the killer flow —
   the Files-app round trip is the worst part of mobile image work.

   Feature detect runs once at script load. We try a tiny synthetic
   payload: a 1-byte text File. If `canShare` returns true for that, the
   browser supports share-with-files and we light up both the action-bar
   button and any per-card share buttons. If not, the buttons stay hidden.
   We never attempt to share + recover, because failed share attempts on
   unsupported browsers throw permission errors that are confusing.

   Important: imgready's privacy story is unaffected. The blob is handed
   to the OS, which hands it to whatever app the user picks. No bytes
   pass through imgready, ever. The destination app's privacy is its
   own — that's outside our brand surface.
   ======================================== */
window._shareSupportedFiles = (function(){
  try {
    if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) return false;
    var probeFile = new File([new Uint8Array([0])], 'probe.txt', {type:'text/plain'});
    return !!navigator.canShare({files:[probeFile]});
  } catch(e){
    return false;
  }
})();

/* Per-result share — same pattern as shareAll but for a single blob.
   Uses the existing downloadOrShare helper as a fallback path so users
   on the rare device where canShare() lies still get something. */
window.shareResult = async function(imgId, rIdx){
  if (!window._shareSupportedFiles) return;
  var item = null;
  for (var i = 0; i < images.length; i++){
    if (images[i].id === imgId){ item = images[i]; break; }
  }
  if (!item || !item.results[rIdx] || !item.results[rIdx].blob) return;
  var r = item.results[rIdx];
  var ext = (typeof getExt === 'function') ? getExt(r.blob) : (r.format || 'bin');
  var name = item.file.name.replace(/\.[^.]+$/, '') + '.' + ext;
  try {
    var file = new File([r.blob], name, {type: r.blob.type || 'application/octet-stream'});
    var data = {files:[file]};
    if (!navigator.canShare(data)){
      /* Runtime payload rejected — fall back to download. */
      return downloadOrShare(r.blob, name);
    }
    await navigator.share(data);
    window._userDownloadedAtLeastOnce = true;
  } catch(err){
    if (err && err.name === 'AbortError') return;
    console.warn('[imgready] shareResult failed:', err);
  }
};

window.shareAll = async function(){
  if (!window._shareSupportedFiles) return;
  var items = _collectResults();
  if (!items.length) return;
  /* Build File[] from the result list. _collectResults already handled
     name de-duplication; we just need to convert {name,blob} → File. */
  var files = [];
  for (var i = 0; i < items.length; i++){
    try {
      files.push(new File([items[i].blob], items[i].name, {type: items[i].blob.type || 'application/octet-stream'}));
    } catch(e){
      console.warn('[imgready] shareAll: skipping unshareable item', items[i].name, e);
    }
  }
  if (!files.length) return;
  /* Some browsers cap how many files can be shared at once. Web Share API
     doesn't expose the limit, so we feature-check the assembled payload. */
  var payload = {files: files};
  if (!navigator.canShare(payload)){
    /* The runtime payload exceeded what canShare accepts. Fall back to
       a smaller payload — just the first file — rather than failing
       silently. The user can repeat for the rest. */
    if (files.length > 1 && navigator.canShare({files:[files[0]]})){
      payload = {files:[files[0]]};
    } else {
      /* Genuinely unsupported. Surface the existing download flow so the
         user isn't stranded. */
      if (typeof window.downloadAll === 'function') return window.downloadAll();
      return;
    }
  }
  var shareBtn = G('shareAllBtn');
  if (shareBtn) shareBtn.disabled = true;
  try {
    await navigator.share(payload);
    /* Success: count it as a save so the beforeunload nag stays quiet. */
    window._userDownloadedAtLeastOnce = true;
  } catch(err){
    /* User cancelled — completely normal on share sheet dismiss. */
    if (err && err.name === 'AbortError') return;
    console.warn('[imgready] share failed:', err);
  } finally {
    if (shareBtn) shareBtn.disabled = false;
  }
};

/* (window.copyAll was removed — see the action bar comment above.
   Per-card copyResult covers the only honest copy use case.) */

var fsInner=G('fsInner');
if(fsInner){
  fsInner.addEventListener('mousemove',function(e){if(!G('fsModal').classList.contains('show'))return;mvFs(e);});
  fsInner.addEventListener('touchstart',function(e){if(e.touches.length===1)mvFs(e);},{passive:true});
  fsInner.addEventListener('touchmove',function(e){
    if(e.touches.length===1){mvFs(e);}
    else if(e.touches.length===2){
      e.preventDefault();
      var dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY,dist=Math.sqrt(dx*dx+dy*dy);
      if(fsPinchDist>0){var sc=dist/fsPinchDist;fsZoom=Math.max(1,Math.min(5,fsZoom*sc));if(fsZoom<=1){fsPanX=0;fsPanY=0;}updateFsZoom();showZoomLevel();}
      fsPinchDist=dist;
    }
  },{passive:false});
  fsInner.addEventListener('touchend',function(e){if(e.touches.length<2)fsPinchDist=0;});
  fsInner.addEventListener('wheel',function(e){
    if(!G('fsModal').classList.contains('show'))return;e.preventDefault();
    var delta=e.deltaY>0?-0.15:0.15;
    var nz=Math.max(1,Math.min(5,fsZoom+delta));
    if(nz!==fsZoom){
      var rect=fsInner.getBoundingClientRect(),mx=e.clientX-rect.left-rect.width/2,my=e.clientY-rect.top-rect.height/2,factor=nz/fsZoom;
      fsPanX=mx-(mx-fsPanX)*factor;fsPanY=my-(my-fsPanY)*factor;
      fsZoom=nz;if(fsZoom<=1){fsPanX=0;fsPanY=0;}
      updateFsZoom();showZoomLevel();
    }
  },{passive:false});
}
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){
    if(G('supModalOverlay').classList.contains('show')){closeSupModal();return;}
    if(G('fsModal').classList.contains('show')){closeFullscreen();return;}
    /* Keyboard help popover — was previously only dismissible by clicking
       outside, which was inconsistent with the other dialogs above. */
    var kbd=G('kbdPopover');
    if(kbd&&kbd.classList.contains('show')){kbd.classList.remove('show');return;}
    return;
  }
  /* Don't intercept typing in form fields */
  var t=e.target,tag=t&&t.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||(t&&t.isContentEditable))return;

  /* Inside the fullscreen modal: arrow keys cycle through this card's results */
  if(G('fsModal').classList.contains('show')&&fsCurrentItem){
    var doneIdx=[];
    for(var i=0;i<fsCurrentItem.results.length;i++){if(fsCurrentItem.results[i].blob)doneIdx.push(i);}
    if(doneIdx.length>1&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){
      var pos=doneIdx.indexOf(fsCurrentIdx);
      var nextPos=e.key==='ArrowRight'?(pos+1)%doneIdx.length:(pos-1+doneIdx.length)%doneIdx.length;
      e.preventDefault();
      showFsResult(doneIdx[nextPos]);
      feInit(fsCurrentItem,doneIdx[nextPos]);
    }
    return;
  }

  /* Outside the modal: P = process, D = download all, / = focus dropzone */
  if(e.key==='p'||e.key==='P'){
    var pb=G('processBtn');if(pb&&!pb.disabled){e.preventDefault();pb.click();}
  } else if(e.key==='d'||e.key==='D'){
    var dl=G('dlAllBtn');if(dl&&dl.style.display!=='none'&&!dl.disabled){e.preventDefault();dl.click();}
  } else if(e.key==='/'){
    var dz=G('dropzone');if(dz){e.preventDefault();dz.focus();dz.click();}
  }
});

/* ========================================
   ACTIONS
   ======================================== */
function downloadOrShare(blob,filename){
  if(navigator.canShare){
    var file=new File([blob],filename,{type:blob.type});
    var data={files:[file]};
    if(navigator.canShare(data)){
      navigator.share(data).then(function(){
        /* Shared successfully — counts as "saved"; suppress beforeunload nag */
        _userDownloadedAtLeastOnce=true;
      }).catch(function(err){
        if(err.name!=='AbortError'){triggerDownload(blob,filename);}
      });
      return;
    }
  }
  triggerDownload(blob,filename);
}
function triggerDownload(blob,filename){
  var url=URL.createObjectURL(blob);
  var a=document.createElement('a');a.href=url;a.download=filename;a.click();
  /* Revoke after a short delay — immediate revoke can abort the download on some browsers */
  setTimeout(function(){URL.revokeObjectURL(url);},10000);
  /* Suppress the beforeunload nag once a download has fired this session */
  _userDownloadedAtLeastOnce=true;
}

/* ========================================
   UNDO REMOVAL — 5-second safety net
   ======================================== */
var _undoPending=null; /* { item, index, timerId } */

function _finalizeRemoval(entry){
  /* Revoke ObjectURLs only when the undo window has expired */
  if(!entry)return;
  if(entry.item.origUrl)URL.revokeObjectURL(entry.item.origUrl);
  for(var j=0;j<entry.item.results.length;j++){
    if(entry.item.results[j].url)URL.revokeObjectURL(entry.item.results[j].url);
  }
}

function _showUndoToast(name){
  var toast=G('undoToast'),msg=G('undoToastMsg');
  if(!toast)return;
  if(msg)msg.textContent='Removed “'+name+'”';
  toast.classList.add('show');
}

window.dismissUndoToast=function(){
  var toast=G('undoToast');
  if(toast)toast.classList.remove('show');
  /* Don't finalize here — the timer is still responsible for cleanup */
};

window.undoRemove=function(){
  if(!_undoPending)return;
  clearTimeout(_undoPending.timerId);
  /* Restore item at original position (clamped to current array length) */
  var idx=Math.min(_undoPending.index,images.length);
  images.splice(idx,0,_undoPending.item);
  _undoPending=null;
  var toast=G('undoToast');if(toast)toast.classList.remove('show');
  renderAll();
};

window.removeImage=function(id){
  for(var i=0;i<images.length;i++){
    if(images[i].id!==id)continue;
    var item=images[i];

    /* If there's already a pending removal, finalize it now before accepting
       a new one — we only support a single undo slot at a time. */
    if(_undoPending){
      clearTimeout(_undoPending.timerId);
      _finalizeRemoval(_undoPending);
      _undoPending=null;
    }

    images.splice(i,1);
    renderAll();

    /* Hold the item for 5s — ObjectURLs stay alive so Undo can restore it.
       entry is created first so the same reference is shared by the timer
       callback and _undoPending (identity check in the callback is reliable). */
    var displayName=item.file.name.replace(/\.[^.]+$/,'');
    var entry={item:item,index:i,timerId:null};
    entry.timerId=setTimeout(function(e){
      _finalizeRemoval(e);
      if(_undoPending===e)_undoPending=null;
      var toast=G('undoToast');if(toast)toast.classList.remove('show');
    },5000,entry);
    _undoPending=entry;
    _showUndoToast(displayName);
    return;
  }
};

/* Inline compare slider: drag horizontally on a done card thumb to compare
   original vs result without entering the fullscreen modal. Single click on
   the handle area still opens fullscreen for power users (zoom, format swap). */
(function inlineCompareSlider(){
  var dragging=null;
  function move(e,thumb){
    var rect=thumb.getBoundingClientRect();
    var cx=e.touches?e.touches[0].clientX:e.clientX;
    var pct=Math.max(0,Math.min(100,(cx-rect.left)/rect.width*100));
    var divider=thumb.querySelector('.compare-divider');
    var handle=thumb.querySelector('.compare-handle');
    var clip=thumb.querySelector('.compare-after');
    if(divider)divider.style.left=pct+'%';
    if(handle)handle.style.left=pct+'%';
    if(clip)clip.style.clipPath='inset(0 0 0 '+pct+'%)';
  }
  document.addEventListener('mousedown',function(e){
    var t=e.target.closest('.compare-thumb');
    if(!t)return;
    dragging=t;
    move(e,t);
    e.preventDefault();
  });
  document.addEventListener('mousemove',function(e){if(dragging)move(e,dragging);});
  document.addEventListener('mouseup',function(){dragging=null;});
  document.addEventListener('touchstart',function(e){
    var t=e.target.closest('.compare-thumb');
    if(!t)return;
    dragging=t;
    move(e,t);
  },{passive:true});
  document.addEventListener('touchmove',function(e){if(dragging)move(e,dragging);},{passive:true});
  document.addEventListener('touchend',function(){dragging=null;});
  /* Double-click opens fullscreen for users who want zoom + format-swap */
  document.addEventListener('dblclick',function(e){
    var t=e.target.closest('.compare-thumb');
    if(!t)return;
    var id=t.getAttribute('data-id');
    if(id&&typeof window.thumbClick==='function')window.thumbClick(id);
  });
})();

/* previewFmt was previously redefined here for the now-removed inline compare
   slider; the duplicate definition shadowed the working one above (`var X =`
   declarations let the later one win). Removed — the canonical previewFmt
   sits next to applyFsEdit and targets the current single-thumbnail DOM. */

window.retryResult=async function(imgId,rIdx){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item||!item.results[rIdx])return;
  var rr=item.results[rIdx];rr.error=null;
  updateCardResults(item);
  try{
    var src=item.decoded||item.file;
    if(item.needsConvert&&!item.decoded){src=await preDecodeFile(item.file);item.decoded=src;}
    var settings=getSettings(rr.format);
    var blob=await processImg(src,settings,rr.format);
    if(settings.stripExif===false&&rr.format==='jpg')blob=await preserveExifIntoBlob(item.file,blob);
    /* Defensive: if a previous (failed) URL exists for this slot, revoke it
       before overwriting. retryResult shouldn't have a URL on a failed slot,
       but guarding cheaply prevents leaks if invariant ever breaks. */
    if(rr.url)URL.revokeObjectURL(rr.url);
    rr.blob=blob;rr.url=URL.createObjectURL(blob);
    rr.error=null;
  }catch(err){rr.error=String(err&&err.message||err||'Encode failed');}
  updateCardResults(item);updateChargePreview();
};
window.dlResult=function(imgId,rIdx){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item||!item.results[rIdx]||!item.results[rIdx].blob)return;
  var r=item.results[rIdx];
  var filename=item.file.name.replace(/\.[^.]+$/,'')+'.'+getExt(r.blob);
  /* Pure download: Share is now a separate button on each result row. */
  triggerDownload(r.blob,filename);
};

/* dlCard — downloads ALL done results for a card. Used by the per-card
   Download button so Live Photo cards (which carry both a still and a
   video MP4) trigger both downloads with one click. Sequential trigger
   with 60ms stagger because browsers throttle simultaneous downloads
   from the same origin (Firefox/Safari especially); 60ms is enough to
   let each click event flush separately. For a card with one result,
   this is identical to dlResult. */
window.dlCard=function(imgId){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item)return;
  var idx=0;
  for(var j=0;j<item.results.length;j++){
    var r=item.results[j];
    if(!r.blob) continue;
    /* MP4 results from Live Photo extraction get .mp4 extension; image
       results use the blob's MIME-derived extension. */
    var ext = (r.format==='mp4') ? 'mp4' : getExt(r.blob);
    var filename = _brandedFilename(item.file.name, ext);
    (function(blob, name, delay){
      setTimeout(function(){triggerDownload(blob, name);}, delay);
    })(r.blob, filename, idx*60);
    idx++;
  }
};

/* shareCard — shares ALL done results via Web Share API as a multi-file
   payload. Live Photo cards share both still + video in one share
   sheet invocation. Receiving apps choose how to handle (Messages
   takes both, AirDrop takes both, single-file-only apps may take just
   the first). Falls back gracefully when the runtime payload is
   rejected — tries the first file alone, then triggers downloads. */
window.shareCard=async function(imgId){
  if(!window._shareSupportedFiles)return;
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item)return;
  var files=[];
  for(var j=0;j<item.results.length;j++){
    var r=item.results[j];
    if(!r.blob) continue;
    var ext = (r.format==='mp4') ? 'mp4' : getExt(r.blob);
    var filename = _brandedFilename(item.file.name, ext);
    try {
      files.push(new File([r.blob], filename, {type: r.blob.type || 'application/octet-stream'}));
    } catch(_){}
  }
  if(!files.length)return;
  try {
    var data = {files: files};
    if(!navigator.canShare(data)){
      /* Some browsers cap multi-file payloads — retry with first file only. */
      if(files.length>1 && navigator.canShare({files:[files[0]]})){
        data = {files: [files[0]]};
      } else {
        /* Genuinely unsupported — fall back to download-all. */
        return window.dlCard(imgId);
      }
    }
    await navigator.share(data);
    window._userDownloadedAtLeastOnce = true;
  } catch(err){
    if(err && err.name==='AbortError')return;
    console.warn('[imgready] shareCard failed:', err);
  }
};

/* Copy the processed result to the system clipboard as image/png.
   Clipboard.write only accepts image/png universally, so non-PNG blobs are
   round-tripped through a canvas. On unsupported browsers the button
   falls back to triggering a download so the user always gets their file. */
window.copyResult=async function(btn,imgId,rIdx){
  var item=null;for(var i=0;i<images.length;i++){if(images[i].id===imgId){item=images[i];break;}}
  if(!item||!item.results[rIdx]||!item.results[rIdx].blob)return;
  var r=item.results[rIdx];
  var origHTML=btn.innerHTML;
  var svgCheck='<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  /* Feature-detect — ClipboardItem is still behind a flag in some older builds */
  if(typeof navigator.clipboard==='undefined'||typeof window.ClipboardItem==='undefined'){
    window.dlResult(imgId,rIdx);
    return;
  }
  btn.innerHTML='<span class="spin-sm"></span>';
  btn.disabled=true;
  try{
    /* Clipboard only accepts image/png universally. Convert if needed. */
    var pngBlob;
    if(r.blob.type==='image/png'){
      pngBlob=r.blob;
    }else{
      pngBlob=await new Promise(function(resolve,reject){
        var img=new Image();
        img.onload=function(){
          var c=document.createElement('canvas');
          c.width=img.naturalWidth;c.height=img.naturalHeight;
          c.getContext('2d').drawImage(img,0,0);
          c.toBlob(function(b){b?resolve(b):reject(new Error('PNG conversion failed'));}, 'image/png');
        };
        img.onerror=function(){reject(new Error('Image load failed'));};
        img.src=r.url;
      });
    }
    await navigator.clipboard.write([new ClipboardItem({'image/png':pngBlob})]);
    btn.innerHTML=svgCheck;
    btn.disabled=false;
    setTimeout(function(){btn.innerHTML=origHTML;},1500);
  }catch(err){
    console.warn('[imgready] clipboard copy failed:',err);
    btn.innerHTML=origHTML;
    btn.disabled=false;
    /* Permission denied: revert silently. Any other failure: fall back to download. */
    if(!err||err.name!=='NotAllowedError'){window.dlResult(imgId,rIdx);}
  }
};

/* ========================================
   THEME
   ======================================== */
window.toggleTheme=function(){
  var h=document.documentElement,d=h.getAttribute('data-theme')==='dark';
  var next=d?'light':'dark';
  h.setAttribute('data-theme',next);
  var b=G('themeBtn');if(b)b.textContent=d?'Night mode':'Day mode';
  try{localStorage.setItem('imgready_theme',next);}catch(e){}
};
/* Restore persisted theme. Default is light; only switch to dark if the user
   has explicitly chosen it via toggleTheme(). We do NOT follow OS dark mode
   automatically — that surprised early users whose OS was set to dark. */
(function restoreTheme(){
  try{
    var saved=localStorage.getItem('imgready_theme');
    if(saved==='dark'){
      document.documentElement.setAttribute('data-theme','dark');
      var b=G('themeBtn');if(b)b.textContent='Day mode';
    }
  }catch(e){}
})();
/* Persist quality + last format too */
(function restoreLastSettings(){
  try{
    /* Quality slider persistence: read from `imgready_q_v2`. The old
       `imgready_q` key could stash extreme values (some users had 100,
       which silently kept the tool in "near-lossless" mode forever after
       the first visit — wrong default for an optimise-first product).
       Bumping the key resets returning visitors to the HTML default of 82
       once; we then validate to a 30–95 sane range so a future bug or
       hand-edit can't poison the slider. */
    var q=localStorage.getItem('imgready_q_v2');
    var qNum=q!=null?parseInt(q,10):NaN;
    if(qNum>=30&&qNum<=95){
      var qs=G('qualitySlider');if(qs)qs.value=qNum;
      var qv=G('qVal');if(qv)qv.textContent=qNum;
    }
    try{localStorage.removeItem('imgready_q');}catch(_){}
    /* Format-pick persistence: read from `imgready_fmt_v2` on purpose.
       The old `imgready_fmt` key stored a specific format (defaulting to
       webp/jpg) from before Auto existed. Restoring that would override
       the new "Auto" default for every returning visitor — exactly the
       opposite of what we want. Bumping the key resets everyone to Auto
       once; subsequent explicit picks save under the v2 key. */
    var f=localStorage.getItem('imgready_fmt_v2');
    if(f&&['auto','webp','avif','png','jpg','gif'].indexOf(f)!==-1){selectedFormat=f;selectedFormats=[f];}
    /* Best-effort cleanup of the old key so it doesn't linger forever. */
    try{localStorage.removeItem('imgready_fmt');}catch(_){}
  }catch(e){}
})();
/* Intent priming: if visitor came from a format-specific landing page or has ?fmt=
   in the URL, pre-select that format. URL takes priority; referrer is a fallback.
   Runs AFTER restoreLastSettings, so explicit intent wins over a stale localStorage value. */
(function primeFormatFromIntent(){
  var fmt=null;
  try{
    /* 1. URL param ?fmt=jpg / ?fmt=webp / etc. */
    var p=new URLSearchParams(location.search);
    var q=(p.get('fmt')||'').toLowerCase();
    if(['webp','avif','png','jpg','jpeg','gif'].indexOf(q)!==-1)fmt=q==='jpeg'?'jpg':q;
    /* 2. Referrer pattern matching — convert /heic-to-jpg/ → jpg, etc. */
    if(!fmt&&document.referrer){
      var ref=document.referrer;
      var slugMap={
        'heic-to-jpg':'jpg','heic-to-png':'png','heic-to-webp':'webp',
        'jpg-to-png':'png','jpg-to-webp':'webp',
        'png-to-jpg':'jpg','png-to-webp':'webp',
        'tiff-to-jpg':'jpg','tiff-to-webp':'webp',
        'compress-jpg':'jpg','compress-png':'png',
        'webp-converter':'webp','avif-converter':'avif'
      };
      for(var slug in slugMap){
        if(ref.indexOf('/'+slug+'/')!==-1||ref.indexOf('/'+slug)!==-1){fmt=slugMap[slug];break;}
      }
    }
  }catch(e){}
  if(fmt&&['webp','avif','png','jpg','gif'].indexOf(fmt)!==-1){
    selectedFormat=fmt;
    selectedFormats=[fmt];
  }
})();
var _qs=G('qualitySlider');if(_qs)_qs.addEventListener('change',function(){try{localStorage.setItem('imgready_q_v2',_qs.value);}catch(e){}});
var _origSelectFormat=window.selectFormat;
window.selectFormat=function(f){_origSelectFormat(f);try{if(!multiOutputMode)localStorage.setItem('imgready_fmt_v2',f);}catch(e){}};
/* Warn before leaving if there are processed results not yet downloaded.
   We can't tell whether the user already downloaded each result, so we warn
   whenever there are completed blobs in the grid. Modern browsers ignore the
   custom message and show their own generic prompt — that's fine, the goal is
   just to interrupt the accidental Cmd+W. */
var _userDownloadedAtLeastOnce=false;
window.addEventListener('beforeunload',function(e){
  if(!images||!images.length)return;
  if(_userDownloadedAtLeastOnce)return;
  var hasUnsaved=false;
  for(var i=0;i<images.length;i++){
    for(var j=0;j<images[i].results.length;j++){
      if(images[i].results[j].blob){hasUnsaved=true;break;}
    }
    if(hasUnsaved)break;
  }
  if(hasUnsaved){
    e.preventDefault();
    e.returnValue='You have processed images that haven\'t been downloaded yet. They will be lost if you close this tab.';
    return e.returnValue;
  }
});
/* Mark "downloaded at least once" so subsequent close attempts don't nag */
var _origTriggerDownload=window.triggerDownload;
/* triggerDownload is defined later as a local fn — wrap via a flag in dlResult/downloadAll */

/* Keyboard help popover */
window.toggleKbdHelp=function(){
  var p=G('kbdPopover');if(!p)return;
  p.classList.toggle('show');
};
/* Click outside to close */
document.addEventListener('click',function(e){
  var p=G('kbdPopover'),btn=G('kbdHelpBtn');
  if(!p||!p.classList.contains('show'))return;
  if(p.contains(e.target)||(btn&&btn.contains(e.target)))return;
  p.classList.remove('show');
});

/* CMP open settings stub — replaced at runtime by Funding Choices when loaded */
window.openCmpSettings=function(){
  if(window.googlefc&&window.googlefc.showRevocationMessage){window.googlefc.showRevocationMessage();return;}
  alert('Cookie & ad consent settings will appear here when the CMP is active. For now, see /privacy/ to manage your choices.');
};

/* ========================================
   DEMO SLIDER
   ======================================== */
(function initDemo(){
  var slider=G('demoSlider'),stats=G('demoStats'),loading=G('demoLoading');
  if(!slider)return;
  var MAX_ZOOM=2.5;
  var demoZoom=1,demoPanX=0,demoPanY=0,demoPinchDist=0,demoHideTimer=null;
  var demoZoomWrap=null,demoZoomAfterEl=null,demoClipEl=null;
  var img=new Image();
  img.crossOrigin='anonymous';
  img.onload=async function(){
    var c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    c.getContext('2d').drawImage(img,0,0);
    var pngBlob=await canvasToBlob(c,'image/png');
    if(!pngBlob){if(loading)loading.innerHTML='Demo unavailable';return;}
    var pngSize=pngBlob.size,pngUrl=URL.createObjectURL(pngBlob);
    try{
      var webpBlob;
      try{
        webpBlob=await encodeWithJsquash(c,'webp',0.82);
      }catch(e){
        webpBlob=await new Promise(function(res,rej){c.toBlob(function(b){b?res(b):rej(new Error('fail'));},'image/webp',0.82);});
      }
      var webpSize=webpBlob.size,webpUrl=URL.createObjectURL(webpBlob);
      var saving=Math.round((1-webpSize/pngSize)*100);
      if(stats)stats.innerHTML='<span class="demo-stat"><span class="label">Original PNG:</span><span class="value">'+fmtSize(pngSize)+'</span></span><span class="demo-stat"><span class="label">WebP:</span><span class="value">'+fmtSize(webpSize)+'</span></span><span class="demo-stat"><span class="saving">'+saving+'% smaller</span></span>';
      if(loading)loading.remove();
      slider.innerHTML='<div class="demo-zoom-wrap" id="demoZoomWrap"><img src="'+pngUrl+'" alt="Original PNG"></div><div class="demo-clip" id="demoClip"><div class="demo-zoom-wrap" id="demoZoomAfter"><img src="'+webpUrl+'" alt="Compressed WebP"></div></div><div class="demo-divider" id="demoDivider"></div><div class="demo-handle" id="demoHandle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2.5" stroke-linecap="round"><path d="M8 4l-4 8 4 8M16 4l4 8-4 8"/></svg></div><span class="demo-lbl l">PNG '+fmtSize(pngSize)+'</span><span class="demo-lbl r">WebP '+fmtSize(webpSize)+'</span><div class="demo-zoom-hint" id="demoZoomHint">Scroll to zoom and inspect</div><div class="demo-zoom-level" id="demoZoomLevel">100%</div>';
      demoZoomWrap=G('demoZoomWrap');demoZoomAfterEl=G('demoZoomAfter');demoClipEl=G('demoClip');
      var hint=G('demoZoomHint');if(hint){hint.classList.add('show');setTimeout(function(){hint.classList.remove('show');},3000);}
      function setPos(pct){pct=Math.max(0,Math.min(100,pct));var dv=G('demoDivider');if(dv)dv.style.left=pct+'%';var hd=G('demoHandle');if(hd)hd.style.left=pct+'%';if(demoClipEl)demoClipEl.style.clipPath='inset(0 0 0 '+pct+'%)';}
      function onMove(e){var rect=slider.getBoundingClientRect();var cx=e.touches?e.touches[0].clientX:e.clientX;setPos((cx-rect.left)/rect.width*100);}
      function updZoom(){var t='translate('+demoPanX+'px,'+demoPanY+'px) scale('+demoZoom+')';if(demoZoomWrap)demoZoomWrap.style.transform=t;if(demoZoomAfterEl)demoZoomAfterEl.style.transform=t;}
      function showDZL(){var zl=G('demoZoomLevel');if(!zl)return;zl.textContent=Math.round(demoZoom*100)+'%';zl.style.display='block';if(demoHideTimer)clearTimeout(demoHideTimer);demoHideTimer=setTimeout(function(){zl.style.display='none';},1200);}
      slider.addEventListener('mousemove',function(e){onMove(e);});
      slider.addEventListener('touchstart',function(e){if(e.touches.length===1)onMove(e);},{passive:true});
      slider.addEventListener('touchmove',function(e){
        if(e.touches.length===1){onMove(e);}
        else if(e.touches.length===2){e.preventDefault();var dx=e.touches[0].clientX-e.touches[1].clientX,dy=e.touches[0].clientY-e.touches[1].clientY,dist=Math.sqrt(dx*dx+dy*dy);if(demoPinchDist>0){var sc=dist/demoPinchDist;demoZoom=Math.max(1,Math.min(MAX_ZOOM,demoZoom*sc));if(demoZoom<=1){demoPanX=0;demoPanY=0;}updZoom();showDZL();}demoPinchDist=dist;}
      },{passive:false});
      slider.addEventListener('touchend',function(e){if(e.touches.length<2)demoPinchDist=0;});
      slider.addEventListener('wheel',function(e){
        e.preventDefault();var delta=e.deltaY>0?-0.12:0.12;var nz=Math.max(1,Math.min(MAX_ZOOM,demoZoom+delta));
        if(nz!==demoZoom){var rect=slider.getBoundingClientRect(),mx=e.clientX-rect.left-rect.width/2,my=e.clientY-rect.top-rect.height/2,factor=nz/demoZoom;demoPanX=mx-(mx-demoPanX)*factor;demoPanY=my-(my-demoPanY)*factor;demoZoom=nz;if(demoZoom<=1){demoPanX=0;demoPanY=0;}updZoom();showDZL();}
      },{passive:false});
      setPos(50);
    }catch(e){if(loading)loading.innerHTML='<span style="color:var(--muted)">Demo unavailable</span>';}
  };
  img.onerror=function(){if(loading)loading.innerHTML='<span style="color:var(--muted)">Demo image not found</span>';};
  /* Lazy: only fetch demo.png if/when the demo slider is in view, to keep the homepage light. */
  if('IntersectionObserver' in window){
    var demoEl=G('demoWrap');
    if(demoEl){
      var io=new IntersectionObserver(function(entries){
        entries.forEach(function(e){
          if(e.isIntersecting){io.disconnect();img.src='/demo.png';}
        });
      },{rootMargin:'200px'});
      io.observe(demoEl);
    } else {img.src='/demo.png';}
  } else {img.src='/demo.png';}
})();

/* ========================================
   INIT
   ======================================== */
updateFormatUI();
renderAll();
/* Sticky action-bar elevation. The bar uses position:sticky;top:8px so it
   pins as the user scrolls. We can't tell from CSS alone whether it's
   currently pinned vs flowing in normal layout — IntersectionObserver with a
   sentinel above the bar fires when the bar leaves natural position, and we
   add `.is-stuck` for the box-shadow + border colour-mix. */
(function watchActionBarStuck(){
  if(!('IntersectionObserver' in window))return;
  var bar=G('actionBar');if(!bar)return;
  var sentinel=document.createElement('div');
  sentinel.style.cssText='position:absolute;top:0;height:1px;width:1px;pointer-events:none;';
  if(bar.parentNode){bar.parentNode.insertBefore(sentinel,bar);}
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(e){bar.classList.toggle('is-stuck',!e.isIntersecting);});
  },{rootMargin:'-9px 0px 0px 0px',threshold:[0,1]});
  io.observe(sentinel);
})();
var _resizeEl=G('resizeMax');
if(_resizeEl)_resizeEl.addEventListener('input',resetPresetToCustom);
var _origSetCrop=window.setCropRatio;
window.setCropRatio=function(r){
  _origSetCrop(r);
  var s=G('presetSelect');if(!s)return;
  var ap=PRESETS[s.value];
  if(ap&&ap.crop!==r)s.value='custom';
};

})();