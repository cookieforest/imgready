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
   END OF CHUNK 05 — actions continue in 06
   ======================================== */
/* CHUNK_END:05-process-modal v1 */
