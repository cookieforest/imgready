"""Assemble favicon.ico from the rendered favicon-16/32/48 PNGs.

Run after tools/_raster.html has written those three files.

PNG-payload ICO rather than BMP: every browser that matters reads it,
the file is a third the size, and it avoids hand-rolling BMP with its
bottom-up rows and separate 1-bit AND mask.

Layout: ICONDIR (6 bytes), then one 16-byte ICONDIRENTRY per image, then
the PNG bytes back to back. Width and height are a single byte each, so
0 means 256 -- not reachable at these sizes, but it is why the field
looks wrong at a glance.
"""
import io
import os
import struct

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SIZES = [16, 32, 48]
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def build():
    images = []
    for s in SIZES:
        path = os.path.join(ROOT, "favicon-%d.png" % s)
        if not os.path.exists(path):
            raise SystemExit(
                "missing %s -- run tools/_raster.html first "
                "(serve the repo with tools/iconserver.py)" % os.path.basename(path))
        with open(path, "rb") as fh:
            data = fh.read()
        if data[:8] != PNG_MAGIC:
            raise SystemExit("favicon-%d.png is not a PNG" % s)
        images.append((s, data))

    buf = io.BytesIO()
    buf.write(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for size, data in images:
        buf.write(struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0, 0,      # palette entries, reserved
            1, 32,     # colour planes, bits per pixel
            len(data), offset))
        offset += len(data)
    for _, data in images:
        buf.write(data)

    out = os.path.join(ROOT, "favicon.ico")
    with open(out, "wb") as fh:
        fh.write(buf.getvalue())
    return out


def verify(path):
    """Read it back the way tests/site-checks.mjs does, so a malformed
    directory is caught here rather than three commits later."""
    raw = open(path, "rb").read()
    reserved, kind, count = struct.unpack("<HHH", raw[:6])
    assert reserved == 0 and kind == 1, "bad ICONDIR"
    lines = ["favicon.ico: %d bytes, %d entries" % (len(raw), count)]
    for i in range(count):
        w, h, _, _, planes, bpp, nbytes, off = struct.unpack(
            "<BBBBHHII", raw[6 + i * 16: 22 + i * 16])
        payload = raw[off:off + nbytes]
        assert len(payload) == nbytes, "entry %d truncated" % i
        assert payload[:8] == PNG_MAGIC, "entry %d is not a PNG" % i
        lines.append("  %3dx%-3d  %5dB at %5d  PNG ok"
                     % (w or 256, h or 256, nbytes, off))
    return "\n".join(lines)


if __name__ == "__main__":
    print(verify(build()))
