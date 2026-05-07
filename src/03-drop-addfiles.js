
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
/* CHUNK_END:03-drop-addfiles v1 */
