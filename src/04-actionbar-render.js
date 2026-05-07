
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
     reads "0% smaller" reads as failure, not nuance. */
  if(pc===0)return '';
  var cls=sv>=0?'':' bad';
  /* Unified savings copy across the app: "smaller" everywhere instead of
     a mix of "saved" (thumb stamp) and "smaller" (modal label). The
     percent already disambiguates direction; the word is just there to
     tell first-time visitors what the number means. "Smaller" is more
     direct for a layperson reading a card thumbnail at a glance. */
  var label=sv>=0?'smaller':'larger';
  var pct=Math.abs(pc)+'%';
  return '<div class="thumb-stamp'+cls+'" aria-label="'+(sv>=0?'Output is ':'Output is ')+Math.abs(pc)+' percent '+label+' than the original">'+
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
            var s2={mime:settings.mime,quality:fallbackQs[fqi],maxDim:settings.maxDim,resizePct:settings.resizePct||0,stripExif:settings.stripExif};
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
    /* Pre-warm: tell every worker to import + instantiate the encoder
       modules for the given formats. Fire-and-forget — the worker swallows
       errors and we never wait for completion. Sending to all workers (not
       just one) means the first user drop can use any of them without
       paying the cold-start. The default `formats` is the user's last
       picked format and webp as a safe fallback (most likely encode path
       on a fresh visit). */
    pool.prewarm = function(formats){
      var list = (formats && formats.length) ? formats : ['webp'];
      for (var pi = 0; pi < pool.workers.length; pi++) {
        try { pool.workers[pi].postMessage({ action: 'prewarm', formats: list }); } catch(_){}
      }
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
      resizePct: s.resizePct||0,
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
    else if(s.resizePct&&s.resizePct>0&&s.resizePct<100){var pscale=s.resizePct/100;w=Math.max(1,Math.round(w*pscale));h=Math.max(1,Math.round(h*pscale));}
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

/* CHUNK_END:04-actionbar-render v1 */
