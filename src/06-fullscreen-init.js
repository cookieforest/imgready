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
/* Inline compare slider — drag the handle to swipe between the original
   and the optimised result on a done card thumbnail. Drag is anchored
   to the .compare-handle button, not the whole thumb, so the rest of
   the thumb area stays free for the corner fullscreen icon. Both
   pointer-events: mouse and touch are wired; on touchstart we don't
   preventDefault (passive) and let the OS scroll if the user swipes
   vertically — horizontal swipe wins because the handle is small and
   centered. */
(function inlineCompareSlider(){
  var dragging=null;
  function setPct(thumb,pct){
    pct=Math.max(0,Math.min(100,pct));
    var divider=thumb.querySelector('.compare-divider');
    var handle=thumb.querySelector('.compare-handle');
    var clip=thumb.querySelector('.compare-after');
    if(divider)divider.style.left=pct+'%';
    if(handle)handle.style.left=pct+'%';
    if(clip)clip.style.clipPath='inset(0 0 0 '+pct+'%)';
  }
  function moveFromEvent(e,thumb){
    var rect=thumb.getBoundingClientRect();
    var cx=(e.touches&&e.touches[0])?e.touches[0].clientX:e.clientX;
    setPct(thumb,(cx-rect.left)/rect.width*100);
  }
  function startDrag(e,handle){
    var thumb=handle.closest('.compare-thumb');
    if(!thumb)return false;
    dragging=thumb;
    /* Prevent the browser's image-drag ghost on desktop, and prevent the
       native click-bubbling that would otherwise open fullscreen. */
    if(e.cancelable)e.preventDefault();
    return true;
  }
  document.addEventListener('mousedown',function(e){
    var h=e.target.closest('.compare-handle');
    if(!h)return;
    startDrag(e,h);
  });
  document.addEventListener('mousemove',function(e){if(dragging)moveFromEvent(e,dragging);});
  document.addEventListener('mouseup',function(){dragging=null;});
  document.addEventListener('mouseleave',function(){dragging=null;});
  document.addEventListener('touchstart',function(e){
    var h=e.target.closest('.compare-handle');
    if(!h)return;
    /* Touch listener is non-passive specifically on the handle path so we
       can preventDefault and stop the ghost click + page scroll. */
    var thumb=h.closest('.compare-thumb');
    if(!thumb)return;
    dragging=thumb;
    e.preventDefault();
  },{passive:false});
  document.addEventListener('touchmove',function(e){
    if(!dragging)return;
    moveFromEvent(e,dragging);
    if(e.cancelable)e.preventDefault();
  },{passive:false});
  document.addEventListener('touchend',function(){dragging=null;});
  document.addEventListener('touchcancel',function(){dragging=null;});
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
/* Intent priming: if the visitor's URL or referrer suggests a specific output
   format, pre-select it. Runs AFTER restoreLastSettings so explicit intent
   wins over a stale localStorage value. Three priorities:
     1. ?fmt=jpg query param (explicit, always wins)
     2. location.pathname matches a known format slug (covers the post-P5
        case where the lifted tool runs ON the slug page itself, e.g.
        a Google visitor landing directly on /heic-to-jpg/ — referrer
        is google.com, not a slug page, so the old referrer-only check
        missed this entirely).
     3. document.referrer matches a slug (covers the legacy case of
        clicking through from a non-lifted page back to homepage). */
(function primeFormatFromIntent(){
  var fmt=null;
  var slugMap={
    'heic-to-jpg':'jpg','heic-to-png':'png','heic-to-webp':'webp','heic-to-avif':'avif',
    'jpg-to-png':'png','jpg-to-webp':'webp','jpg-to-avif':'avif',
    'png-to-jpg':'jpg','png-to-webp':'webp','png-to-avif':'avif',
    'tiff-to-jpg':'jpg','tiff-to-webp':'webp','tiff-to-png':'png',
    'webp-to-jpg':'jpg','webp-to-png':'png','webp-to-avif':'avif',
    'avif-to-jpg':'jpg','avif-to-png':'png',
    'bmp-to-jpg':'jpg','gif-to-webp':'webp','svg-to-png':'png',
    'compress-jpg':'jpg','compress-png':'png',
    'webp-converter':'webp','avif-converter':'avif'
  };
  try{
    /* 1. URL param wins. */
    var p=new URLSearchParams(location.search);
    var q=(p.get('fmt')||'').toLowerCase();
    if(['webp','avif','png','jpg','jpeg','gif'].indexOf(q)!==-1)fmt=q==='jpeg'?'jpg':q;
    /* 2. Pathname slug match. Walk the slugMap, look for /{slug}/ in the path. */
    if(!fmt){
      var path=(location.pathname||'').toLowerCase();
      for(var slug in slugMap){
        if(path.indexOf('/'+slug+'/')!==-1 || path.indexOf('/'+slug)===path.length-1-slug.length){
          fmt=slugMap[slug]; break;
        }
      }
    }
    /* 3. Referrer fallback for visitors arriving via legacy CTA links. */
    if(!fmt&&document.referrer){
      var ref=document.referrer;
      for(var slug2 in slugMap){
        if(ref.indexOf('/'+slug2+'/')!==-1||ref.indexOf('/'+slug2)!==-1){fmt=slugMap[slug2];break;}
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

/* Pre-warm WASM encoders on idle. The first encode pays a one-time WASM
   instantiation cost (~330ms cold for MozJPEG, similar for AVIF/WebP). By
   sending a `prewarm` message to the worker pool once the page has been
   idle for a moment, that cost happens during a quiet window instead of
   while the user is staring at a "Processing..." spinner.
   Gating: wait for window.load + 1.5s floor + idle callback. We piggyback
   on the same gating philosophy as AdSense — never compete with FCP/LCP
   work on the main thread. The pool is created lazily; calling
   getWorkerPool() here triggers a one-time spin-up of the workers. We
   prewarm with [auto-target, webp] which covers the cases where the user
   has a remembered format pref AND the safe default fallback. */
(function schedulePrewarm(){
  if(typeof getWorkerPool!=='function')return;
  function fire(){
    try{
      var pool=getWorkerPool(); if(!pool||!pool.prewarm)return;
      var fmts=[];
      if(typeof selectedFormat==='string' && selectedFormat!=='auto'){
        fmts.push(selectedFormat);
      }
      if(fmts.indexOf('webp')===-1)fmts.push('webp');
      pool.prewarm(fmts);
    }catch(_){}
  }
  function schedule(){
    setTimeout(function(){
      if('requestIdleCallback' in window){
        requestIdleCallback(fire,{timeout:5000});
      } else {
        setTimeout(fire,200);
      }
    },1500);
  }
  if(document.readyState==='complete'){
    schedule();
  } else {
    window.addEventListener('load',schedule,{once:true});
  }
})();

})();
/* CHUNK_END:06-fullscreen-init v1 */
