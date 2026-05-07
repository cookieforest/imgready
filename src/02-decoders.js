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
/* Full-window drop overlay. The previous behaviour only highlighted the
   dropzone itself, which is invisible if the user is scrolled mid-page.
   Squoosh and TinyPNG both show a translucent overlay across the whole
   viewport during drag — much better orientation for first-time visitors
   who don't know where the dropzone is. We lazily create the overlay
   element on first drag so pages that never see a drag pay nothing.
   Tracking a depth counter (dragenter +1, dragleave -1) handles the
   case where the cursor moves between child elements firing dragleave
   on the parent — a counter-based approach is the spec-correct way. */
var _windowDragOverlay=null;
var _windowDragDepth=0;
function _ensureWindowDragOverlay(){
  if(_windowDragOverlay)return _windowDragOverlay;
  _windowDragOverlay=document.createElement('div');
  _windowDragOverlay.className='window-drop-overlay';
  _windowDragOverlay.setAttribute('aria-hidden','true');
  _windowDragOverlay.innerHTML='<div class="wd-card">'+
    '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'+
    '<div class="wd-title">Drop anywhere</div>'+
    '<div class="wd-sub">Stays on your device — never uploaded</div>'+
  '</div>';
  document.body.appendChild(_windowDragOverlay);
  return _windowDragOverlay;
}
function _hideWindowDragOverlay(){
  _windowDragDepth=0;
  if(_windowDragOverlay)_windowDragOverlay.classList.remove('show');
  document.body.classList.remove('window-dragging');
}
document.addEventListener('dragenter',function(e){
  var types=e.dataTransfer&&e.dataTransfer.types;
  if(!types||(typeof types.indexOf==='function'?types.indexOf('Files')===-1:!types.contains('Files')))return;
  if(G('fsModal')&&G('fsModal').classList.contains('show'))return;
  _windowDragDepth++;
  if(_windowDragDepth===1){
    document.body.classList.add('window-dragging');
    _ensureWindowDragOverlay().classList.add('show');
  }
});
document.addEventListener('dragover',function(e){
  e.preventDefault();
  var dzel=G('dropzone');
  if(dzel&&!G('fsModal').classList.contains('show'))dzel.classList.add('drag');
});
document.addEventListener('dragleave',function(e){
  if(_windowDragDepth>0){
    _windowDragDepth--;
    if(_windowDragDepth===0)_hideWindowDragOverlay();
  }
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
  _hideWindowDragOverlay();
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
/* Styled in-page confirm dialog. Replaces native confirm() — that
   looked like a browser security warning, not part of imgready's
   design language. Returns a Promise<boolean>; resolves true when
   the user clicks Continue, false on Cancel / Esc / backdrop click. */
function imgrConfirm(message,opts){
  opts=opts||{};
  return new Promise(function(resolve){
    var bg=document.createElement('div');
    bg.className='imgr-confirm-bg';
    bg.setAttribute('role','dialog');
    bg.setAttribute('aria-modal','true');
    bg.innerHTML='<div class="imgr-confirm">'+
      (opts.title?'<div class="imgr-confirm-title">'+escHtml(opts.title)+'</div>':'')+
      '<div class="imgr-confirm-msg">'+escHtml(message)+'</div>'+
      '<div class="imgr-confirm-actions">'+
        '<button class="imgr-confirm-cancel">'+escHtml(opts.cancelText||'Cancel')+'</button>'+
        '<button class="imgr-confirm-ok">'+escHtml(opts.okText||'Continue')+'</button>'+
      '</div>'+
    '</div>';
    document.body.appendChild(bg);
    var prevFocus=document.activeElement;
    function close(result){
      bg.removeEventListener('click',onBg);
      document.removeEventListener('keydown',onKey);
      bg.classList.remove('show');
      setTimeout(function(){if(bg.parentNode)bg.parentNode.removeChild(bg);},150);
      try{if(prevFocus&&prevFocus.focus)prevFocus.focus();}catch(_){}
      resolve(result);
    }
    function onBg(e){if(e.target===bg)close(false);}
    function onKey(e){
      if(e.key==='Escape'){e.preventDefault();close(false);}
      else if(e.key==='Enter'){e.preventDefault();close(true);}
    }
    bg.addEventListener('click',onBg);
    document.addEventListener('keydown',onKey);
    bg.querySelector('.imgr-confirm-ok').addEventListener('click',function(){close(true);});
    bg.querySelector('.imgr-confirm-cancel').addEventListener('click',function(){close(false);});
    requestAnimationFrame(function(){bg.classList.add('show');});
    setTimeout(function(){
      var c=bg.querySelector('.imgr-confirm-cancel');
      if(c&&c.focus)c.focus();
    },20);
  });
}
async function addFiles(list){
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
  /* Soft cap to protect users from OOMing the tab on enormous drops.
     Uses the styled imgrConfirm (defined above) instead of native
     confirm() — better visual continuity with the rest of the UI. */
  if(images.length+list.length>BATCH_SOFT_LIMIT){
    var ok=await imgrConfirm(
      'You\'re about to add '+list.length+' files (current: '+images.length+'). '+
      'Browsers can struggle with more than '+BATCH_SOFT_LIMIT+' large images at once. Continue anyway?',
      {title:'Big batch — heads up'}
    );
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
/* CHUNK_END:02-decoders v1 */
