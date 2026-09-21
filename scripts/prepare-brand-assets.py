#!/usr/bin/env python3
"""
Turn a supplied logo PNG into a mark the interface can place anywhere.

# The problem

Brand assets arrive as square artwork on a flat background - Clawpump's claw
on white, Meteora's sphere on near-black - because that is how a logo is
delivered. Dropped into the page as-is, each one is a hard white or black
square sitting on a lime hero, which looks like a broken image rather than a
credit.

So the background has to become transparent, and it has to do so without the
fringe that a naive colour-key leaves behind.

# The method

1. **Flood fill inwards from the border.** Not a global colour test: the white
   ellipses inside Clawpump's claw are the same white as its background, and a
   global test would punch holes through the artwork. Only background that is
   actually connected to the edge is background. This is also what correctly
   opens up the gaps between Meteora's stripes and the bands across the claw,
   since those do reach the edge.
2. **Crop to what is left,** so a logo drawn with generous padding and one
   drawn to the edge end up the same optical size beside each other.
3. **Box-downscale to 128px.** This is where the antialiasing comes from: the
   flood fill produces a hard binary edge, and averaging ~90 source pixels per
   output pixel turns that into smooth coverage for free. Colour is averaged
   premultiplied, or the discarded background bleeds back in as a white or
   black halo around every edge.

# Why not a library

Same reason as `make-icons.py`: this image has no rasteriser and no PIL, and
this is a hundred lines of stdlib against a system dependency.

Usage:  python3 scripts/prepare-brand-assets.py <in.png> <out.png> [size]
"""

import os
import struct
import sys
import zlib
from collections import deque

SIZE = 128
# How far a pixel may sit from the border colour and still count as background.
# Generous enough for the JPEG-ish noise and gradient banding in a supplied
# asset, tight enough not to eat a dark logo on a dark field.
TOLERANCE = 30


# ---------------------------------------------------------------------------
# PNG in
# ---------------------------------------------------------------------------
def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def read_png(path):
    """8-bit RGB or RGBA, non-interlaced, which is what a logo export is."""
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path}: not a PNG")
    w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", data[16:29])
    if depth != 8 or ctype not in (2, 6) or interlace:
        raise SystemExit(
            f"{path}: need 8-bit RGB or RGBA without interlacing, "
            f"got depth={depth} colortype={ctype} interlace={interlace}"
        )
    channels = 3 if ctype == 2 else 4

    idat = bytearray()
    i = 8
    while i < len(data):
        (ln,) = struct.unpack(">I", data[i : i + 4])
        tag = data[i + 4 : i + 8]
        if tag == b"IDAT":
            idat += data[i + 8 : i + 8 + ln]
        i += 12 + ln
    raw = zlib.decompress(bytes(idat))

    stride = w * channels
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if ft == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 0xFF
        elif ft == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 0xFF
        elif ft == 3:
            for x in range(stride):
                left = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + ((left + prev[x]) >> 1)) & 0xFF
        elif ft == 4:
            for x in range(stride):
                left = line[x - channels] if x >= channels else 0
                ul = prev[x - channels] if x >= channels else 0
                line[x] = (line[x] + paeth(left, prev[x], ul)) & 0xFF
        elif ft != 0:
            raise SystemExit(f"{path}: unknown filter {ft} on row {y}")

        o = y * w * 4
        for x in range(w):
            s = x * channels
            out[o] = line[s]
            out[o + 1] = line[s + 1]
            out[o + 2] = line[s + 2]
            out[o + 3] = line[s + 3] if channels == 4 else 255
            o += 4
        prev = line
    return w, h, out


# ---------------------------------------------------------------------------
# PNG out
# ---------------------------------------------------------------------------
def write_png(path, w, h, buf):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += buf[y * stride : (y + 1) * stride]

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    open(path, "wb").write(png)
    return len(png)


# ---------------------------------------------------------------------------
def knock_out_background(w, h, buf):
    """Flood fill from every border pixel; returns the number cleared."""
    # The corners agree on the background in every asset worth shipping; if
    # they do not, the artwork bleeds to the edge and there is nothing here to
    # remove, so say that rather than eating half the logo.
    corners = [
        tuple(buf[(y * w + x) * 4 : (y * w + x) * 4 + 3])
        for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))
    ]
    base = corners[0]
    if any(max(abs(a - b) for a, b in zip(base, c)) > TOLERANCE for c in corners):
        raise SystemExit(f"corners disagree on the background colour: {corners}")

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        q.append((x, 0))
        q.append((x, h - 1))
    for y in range(h):
        q.append((0, y))
        q.append((w - 1, y))

    cleared = 0
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        idx = y * w + x
        if seen[idx]:
            continue
        p = idx * 4
        if max(abs(buf[p + c] - base[c]) for c in range(3)) > TOLERANCE:
            continue
        seen[idx] = 1
        buf[p + 3] = 0
        cleared += 1
        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))
    return cleared


def content_box(w, h, buf):
    x0, y0, x1, y1 = w, h, -1, -1
    for y in range(h):
        row = y * w
        for x in range(w):
            if buf[(row + x) * 4 + 3]:
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    if x1 < 0:
        raise SystemExit("nothing left after removing the background")
    return x0, y0, x1, y1


def square_downscale(w, h, buf, box, size):
    """Crop to `box`, centre it in a square, and box-filter down to `size`."""
    x0, y0, x1, y1 = box
    side = max(x1 - x0 + 1, y1 - y0 + 1)
    # Where the square sits in source coordinates, centred on the content.
    ox = x0 - (side - (x1 - x0 + 1)) // 2
    oy = y0 - (side - (y1 - y0 + 1)) // 2

    out = bytearray(size * size * 4)
    step = side / size
    for oy_i in range(size):
        sy0 = oy + int(oy_i * step)
        sy1 = oy + int((oy_i + 1) * step)
        for ox_i in range(size):
            sx0 = ox + int(ox_i * step)
            sx1 = ox + int((ox_i + 1) * step)
            ar = ag = ab = aa = 0.0
            n = 0
            for sy in range(sy0, max(sy1, sy0 + 1)):
                if sy < 0 or sy >= h:
                    n += max(sx1 - sx0, 1)
                    continue
                base = sy * w
                for sx in range(sx0, max(sx1, sx0 + 1)):
                    n += 1
                    if sx < 0 or sx >= w:
                        continue
                    p = (base + sx) * 4
                    a = buf[p + 3] / 255.0
                    # Premultiplied, so the background we just discarded
                    # cannot bleed back as a halo along every edge.
                    ar += buf[p] * a
                    ag += buf[p + 1] * a
                    ab += buf[p + 2] * a
                    aa += a
            o = (oy_i * size + ox_i) * 4
            if aa <= 0:
                continue
            out[o] = min(255, int(round(ar / aa)))
            out[o + 1] = min(255, int(round(ag / aa)))
            out[o + 2] = min(255, int(round(ab / aa)))
            out[o + 3] = min(255, int(round(aa / n * 255)))
    return out


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.strip().splitlines()[-1])
    src, dst = sys.argv[1], sys.argv[2]
    size = int(sys.argv[3]) if len(sys.argv) > 3 else SIZE

    w, h, buf = read_png(src)
    cleared = knock_out_background(w, h, buf)
    box = content_box(w, h, buf)
    out = square_downscale(w, h, buf, box, size)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    written = write_png(dst, size, size, out)
    print(
        f"  {os.path.basename(dst):20} {w}x{h} -> {size}x{size}  "
        f"background {cleared * 100 // (w * h)}%  crop {box}  {written / 1024:.1f} KB"
    )


if __name__ == "__main__":
    main()
