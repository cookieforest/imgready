/* EXIF viewer and lossless metadata stripper.
 *
 * Two things here that the field mostly does not do.
 *
 * 1. SHOW BEFORE STRIP. Most "EXIF remover" tools just remove. You never
 *    learn that the photo you already posted last week had your home
 *    coordinates in it. Reading the tags out and putting the GPS on the
 *    page is the part that changes behaviour.
 *
 * 2. LOSSLESS REMOVAL. The usual implementation draws the image to a
 *    canvas and re-encodes, which throws away metadata as a side effect
 *    of throwing away image quality. For JPEG and PNG the metadata lives
 *    in discrete segments or chunks, so it can be cut out and the
 *    compressed pixel data copied through untouched. Same bytes, same
 *    quality, no metadata.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- EXIF parsing ---------------- */

  var TAGS = {
    0x010F: 'Camera make', 0x0110: 'Camera model', 0x0112: 'Orientation',
    0x011A: 'X resolution', 0x011B: 'Y resolution', 0x0131: 'Software',
    0x0132: 'Date modified', 0x013B: 'Artist', 0x8298: 'Copyright',
    0x829A: 'Exposure time', 0x829D: 'F number', 0x8822: 'Exposure program',
    0x8827: 'ISO', 0x9003: 'Date taken', 0x9004: 'Date digitised',
    0x9201: 'Shutter speed', 0x9202: 'Aperture', 0x9204: 'Exposure bias',
    0x9207: 'Metering mode', 0x9209: 'Flash', 0x920A: 'Focal length',
    0xA002: 'Pixel width', 0xA003: 'Pixel height', 0xA402: 'Exposure mode',
    0xA403: 'White balance', 0xA406: 'Scene type', 0xA430: 'Camera owner',
    0xA431: 'Body serial number', 0xA432: 'Lens specification',
    0xA433: 'Lens make', 0xA434: 'Lens model', 0xA435: 'Lens serial number'
  };
  var GPS_TAGS = {
    1: 'Latitude ref', 2: 'Latitude', 3: 'Longitude ref', 4: 'Longitude',
    5: 'Altitude ref', 6: 'Altitude', 7: 'GPS time', 29: 'GPS date'
  };
  /* Tags worth shouting about: they identify a person, a place or a device. */
  var SENSITIVE = {
    'Latitude': 1, 'Longitude': 1, 'Altitude': 1, 'GPS time': 1, 'GPS date': 1,
    'Artist': 1, 'Copyright': 1, 'Camera owner': 1, 'Body serial number': 1,
    'Lens serial number': 1, 'Software': 1, 'Date taken': 1, 'Date digitised': 1,
    'Date modified': 1
  };
  var SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  function readIfd(dv, tiff, off, le, into, dict) {
    var n = dv.getUint16(tiff + off, le), ptrs = {};
    for (var i = 0; i < n; i++) {
      var e = tiff + off + 2 + i * 12;
      if (e + 12 > dv.byteLength) break;
      var tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le);
      var count = dv.getUint32(e + 4, le), size = (SIZES[type] || 1) * count;
      var vo = size > 4 ? tiff + dv.getUint32(e + 8, le) : e + 8;
      if (vo + size > dv.byteLength || vo < 0) continue;
      if (tag === 0x8769) { ptrs.exif = dv.getUint32(e + 8, le); continue; }
      if (tag === 0x8825) { ptrs.gps = dv.getUint32(e + 8, le); continue; }
      var name = dict[tag];
      if (!name) continue;
      into[name] = readVal(dv, vo, type, count, le);
    }
    return ptrs;
  }

  function readVal(dv, o, type, count, le) {
    var i, out = [];
    if (type === 2) {
      var s = '';
      for (i = 0; i < count; i++) {
        var c = dv.getUint8(o + i);
        if (!c) break;
        s += String.fromCharCode(c);
      }
      return s.trim();
    }
    for (i = 0; i < count && i < 8; i++) {
      if (type === 1 || type === 7) out.push(dv.getUint8(o + i));
      else if (type === 3) out.push(dv.getUint16(o + i * 2, le));
      else if (type === 4) out.push(dv.getUint32(o + i * 4, le));
      else if (type === 9) out.push(dv.getInt32(o + i * 4, le));
      else if (type === 5 || type === 10) {
        var num = type === 5 ? dv.getUint32(o + i * 8, le) : dv.getInt32(o + i * 8, le);
        var den = type === 5 ? dv.getUint32(o + i * 8 + 4, le) : dv.getInt32(o + i * 8 + 4, le);
        out.push(den ? num / den : 0);
      }
    }
    return out.length === 1 ? out[0] : out;
  }

  function dms(v, ref) {
    if (!Array.isArray(v) || v.length < 3) return null;
    var d = v[0] + v[1] / 60 + v[2] / 3600;
    if (ref === 'S' || ref === 'W') d = -d;
    return d;
  }

  /* Locate the EXIF/TIFF block in the container, or return null. */
  function findTiff(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    /* JPEG: walk the segment chain to APP1 "Exif\0\0" */
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      var p = 2;
      while (p + 4 < bytes.length) {
        if (bytes[p] !== 0xFF) { p++; continue; }
        var marker = bytes[p + 1];
        if (marker === 0xDA || marker === 0xD9) break;
        var len = dv.getUint16(p + 2, false);
        if (marker === 0xE1 && bytes[p + 4] === 0x45 && bytes[p + 5] === 0x78) {
          return p + 10;
        }
        p += 2 + len;
      }
      return null;
    }
    /* PNG: eXIf chunk */
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      var q = 8;
      while (q + 8 < bytes.length) {
        var clen = dv.getUint32(q, false);
        var ctype = String.fromCharCode(bytes[q + 4], bytes[q + 5], bytes[q + 6], bytes[q + 7]);
        if (ctype === 'eXIf') return q + 8;
        if (ctype === 'IEND') break;
        q += 12 + clen;
      }
      return null;
    }
    /* WebP: RIFF ... EXIF chunk */
    if (bytes[0] === 0x52 && bytes[8] === 0x57) {
      var r = 12;
      while (r + 8 < bytes.length) {
        var fourcc = String.fromCharCode(bytes[r], bytes[r + 1], bytes[r + 2], bytes[r + 3]);
        var sz = dv.getUint32(r + 4, true);
        if (fourcc === 'EXIF') return r + 8;
        r += 8 + sz + (sz & 1);
      }
      return null;
    }
    return null;
  }

  function parseExif(bytes) {
    var tiff = findTiff(bytes);
    if (tiff === null) return null;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (tiff + 8 > dv.byteLength) return null;
    var b0 = dv.getUint16(tiff, false);
    var le = b0 === 0x4949;
    if (!le && b0 !== 0x4D4D) return null;
    if (dv.getUint16(tiff + 2, le) !== 0x2A) return null;
    var ifd0 = dv.getUint32(tiff + 4, le);
    var out = {}, gps = {};
    var ptrs = readIfd(dv, tiff, ifd0, le, out, TAGS);
    if (ptrs.exif) readIfd(dv, tiff, ptrs.exif, le, out, TAGS);
    if (ptrs.gps) readIfd(dv, tiff, ptrs.gps, le, gps, GPS_TAGS);
    var lat = dms(gps['Latitude'], gps['Latitude ref']);
    var lon = dms(gps['Longitude'], gps['Longitude ref']);
    return { tags: out, gps: gps, lat: lat, lon: lon };
  }

  /* ---------------- lossless stripping ---------------- */

  /* JPEG: copy every segment except the metadata carriers. APP0/JFIF is
     kept because some decoders expect it and it holds no personal data.
     Everything from SOS onward is the entropy-coded scan and is copied
     byte for byte, so the pixels are bit-identical to the original. */
  function stripJpeg(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out = [0xFF, 0xD8], p = 2, removed = [];
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      var m = bytes[p + 1];
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
      if (m === 0xDA) {                       /* start of scan: copy the rest */
        for (var i = p; i < bytes.length; i++) out.push(bytes[i]);
        break;
      }
      var len = dv.getUint16(p + 2, false);
      var drop = (m >= 0xE1 && m <= 0xEF) || m === 0xFE;   /* APP1..APPF, COM */
      if (drop) {
        removed.push(m === 0xFE ? 'comment' : 'APP' + (m - 0xE0));
      } else {
        for (var j = p; j < p + 2 + len && j < bytes.length; j++) out.push(bytes[j]);
      }
      p += 2 + len;
    }
    return { bytes: new Uint8Array(out), removed: removed };
  }

  /* PNG: chunks are self-describing and independently CRC'd, so dropping
     a metadata chunk needs no recompression and no CRC recalculation. */
  function stripPng(bytes) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var DROP = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1, iCCP: 0 };
    var out = [], removed = [], i;
    for (i = 0; i < 8; i++) out.push(bytes[i]);
    var p = 8;
    while (p + 8 <= bytes.length) {
      var len = dv.getUint32(p, false);
      var type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      var total = 12 + len;
      if (DROP[type]) {
        removed.push(type);
      } else {
        for (i = p; i < p + total && i < bytes.length; i++) out.push(bytes[i]);
      }
      p += total;
      if (type === 'IEND') break;
    }
    return { bytes: new Uint8Array(out), removed: removed };
  }

  function strip(bytes, mime) {
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return strip._r = stripJpeg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return strip._r = stripPng(bytes);
    return null;
  }

  /* ---------------- UI ---------------- */

  var current = null;

  function fmt(k, v) {
    if (k === 'Exposure time' && typeof v === 'number' && v > 0 && v < 1) {
      return '1/' + Math.round(1 / v) + ' s';
    }
    if (k === 'F number' || k === 'Aperture') return 'f/' + (+v).toFixed(1);
    if (k === 'Focal length') return (+v).toFixed(0) + ' mm';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  }

  function row(k, v, hot) {
    return '<tr' + (hot ? ' class="ex-hot"' : '') + '><th scope="row">' + k +
           '</th><td>' + String(v).replace(/[<>&]/g, '') + '</td></tr>';
  }

  function show(name, bytes) {
    current = { name: name, bytes: bytes };
    var info = parseExif(bytes);
    var out = $('exResult');
    var kb = (bytes.length / 1024).toFixed(1);
    var head = '<p class="ex-file"><b>' + name.replace(/[<>&]/g, '') + '</b> &middot; ' + kb + ' KB</p>';

    if (!info || (!Object.keys(info.tags).length && !Object.keys(info.gps).length)) {
      out.innerHTML = head +
        '<p class="ex-clean">No EXIF metadata found. Either it was never written, ' +
        'or something has already stripped it. Nothing to remove.</p>';
      $('exActions').hidden = true;
      return;
    }

    var hot = [], cold = [];
    Object.keys(info.tags).forEach(function (k) {
      (SENSITIVE[k] ? hot : cold).push(row(k, fmt(k, info.tags[k]), SENSITIVE[k]));
    });

    var gpsBlock = '';
    if (info.lat !== null && info.lon !== null) {
      var ll = info.lat.toFixed(6) + ', ' + info.lon.toFixed(6);
      gpsBlock =
        '<div class="ex-gps">' +
        '<p class="ex-gps-title">This photo records where it was taken</p>' +
        '<p class="ex-gps-coord">' + ll + '</p>' +
        '<p><a href="https://www.openstreetmap.org/?mlat=' + info.lat + '&mlon=' + info.lon +
        '#map=16/' + info.lat + '/' + info.lon + '" target="_blank" rel="noopener noreferrer">' +
        'Open the location on OpenStreetMap</a> to see what it points at.</p>' +
        '<p class="ex-note">The link above is the only thing on this page that ' +
        'leaves your device, and only if you click it. Your photo does not.</p>' +
        '</div>';
    }

    out.innerHTML = head + gpsBlock +
      (hot.length ? '<h3 class="ex-h">Identifying information</h3><table class="ex-table">' +
        hot.join('') + '</table>' : '') +
      (cold.length ? '<h3 class="ex-h">Camera and capture</h3><table class="ex-table">' +
        cold.join('') + '</table>' : '');
    $('exActions').hidden = false;
    $('exCount').textContent = (hot.length + cold.length) +
      ' tag' + (hot.length + cold.length === 1 ? '' : 's') + ' found' +
      (hot.length ? ', ' + hot.length + ' identifying' : '');
  }

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  function handle(file) {
    var fr = new FileReader();
    fr.onload = function () { show(file.name, new Uint8Array(fr.result)); };
    fr.onerror = function () { $('exResult').innerHTML = '<p class="ex-clean">Could not read that file.</p>'; };
    fr.readAsArrayBuffer(file);
  }

  function init() {
    var dz = $('exDrop'), input = $('exInput');
    if (!dz) return;

    dz.addEventListener('click', function () { input.click(); });
    dz.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      if (this.files && this.files[0]) handle(this.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.add('is-drag'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      dz.addEventListener(t, function (e) { e.preventDefault(); dz.classList.remove('is-drag'); });
    });
    dz.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
    });

    $('exStrip').addEventListener('click', function () {
      if (!current) return;
      var r = strip(current.bytes);
      var note = $('exStripNote');
      if (!r) {
        note.textContent = 'Lossless removal only works on JPEG and PNG. For other ' +
          'formats, convert with the main tool: re-encoding drops metadata too.';
        return;
      }
      var base = current.name.replace(/\.[^.]+$/, '');
      var ext = current.bytes[0] === 0x89 ? '.png' : '.jpg';
      var mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      download(new Blob([r.bytes], { type: mime }), base + '-clean' + ext);
      var saved = current.bytes.length - r.bytes.length;
      note.textContent = 'Saved ' + base + '-clean' + ext + '. Removed ' +
        (r.removed.length ? r.removed.join(', ') : 'nothing') + ', ' +
        saved + ' bytes. The compressed image data was copied through untouched, ' +
        'so the pixels are identical to the original.';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else { init(); }
})();
