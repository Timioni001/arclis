#!/usr/bin/env python3
"""
Rasterise the Arclis mark into the PNG sizes the web still demands.

# Why this exists rather than an image in the repo

`app/public/brand/mark.svg` is the mark. An SVG favicon is enough for every
current browser, but two places still refuse one:

  * iOS home screens, which want `apple-touch-icon.png` at 180px and will
    screenshot the page if it is missing.
  * Social scrapers. Twitter, Discord, Slack and iMessage do not render SVG
    `og:image`, so a link to the site posted in a judging channel unfurls as
    a bare grey rectangle unless a PNG exists.

Committing hand-exported PNGs would mean four binaries that silently drift
from the SVG the moment anyone touches it. This redraws them from the same
numbers instead, so "regenerate the icons" is a command rather than a design
tool and a memory.

# Why it does not shell out to a converter

There is no rasteriser in the build image: no rsvg-convert, no ImageMagick,
no cairosvg, no sharp. Adding one is a system dependency for four flat
shapes. Signed distance fields draw those four shapes exactly, in stdlib,
with better antialiasing than a nearest-neighbour downscale - coverage comes
out of the distance itself rather than out of counting subsamples.

Usage:  python3 scripts/make-icons.py
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, os.pardir, "app", "public")

# ---------------------------------------------------------------------------
# The mark, in the same 32-unit space as mark.svg. These numbers are duplicated
# there on purpose: the SVG has to stand alone as an asset. Change one, change
# both, and the test in app/src/components/ui/Brand.test.tsx will tell you if
# the SVG stops matching.
# ---------------------------------------------------------------------------
GRID = 32.0
TILE_RADIUS = 8.5
ARC = ((7.0, 23.8), (13.5, 23.2), (18.2, 19.2), (21.4, 11.2))
ARC_WIDTH = 3.0
DOT = (23.4, 5.9, 2.15)

LIME_BRIGHT = (0xD4, 0xF8, 0x6A)
LIME_DEEP = (0xAA, 0xDD, 0x1F)
ON_LIME = (0x16, 0x21, 0x0C)
INK_BG = (0x0B, 0x0D, 0x0A)


# ---------------------------------------------------------------------------
# Signed distance fields. Negative inside, positive outside, in design units.
# ---------------------------------------------------------------------------
def sd_round_rect(px, py, w, h, r):
    qx = abs(px - w / 2.0) - (w / 2.0 - r)
    qy = abs(py - h / 2.0) - (h / 2.0 - r)
    return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r


def sd_circle(px, py, cx, cy, r):
    return math.hypot(px - cx, py - cy) - r


def flatten_cubic(p0, p1, p2, p3, steps=192):
    """A cubic as a polyline. 192 steps over 20 units is well under a pixel."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1.0 - t
        a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
        pts.append(
            (
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
            )
        )
    return pts


def sd_polyline(px, py, pts):
    """Distance to a polyline. Round joins and caps fall out of this for free,
    which is exactly what stroke-linecap="round" asks for in the SVG."""
    best = float("inf")
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        vx, vy = bx - ax, by - ay
        wx, wy = px - ax, py - ay
        denom = vx * vx + vy * vy
        t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
        d = math.hypot(wx - t * vx, wy - t * vy)
        if d < best:
            best = d
    return best


ARC_PTS = flatten_cubic(*ARC)


def coverage(sd_px):
    """Analytic antialiasing: a distance of half a pixel inside is fully
    covered, half a pixel outside is empty, and the edge is linear between.
    Sharper than supersampling and it costs one clamp."""
    return max(0.0, min(1.0, 0.5 - sd_px))


def over(dst, src, alpha):
    return tuple(int(round(s * alpha + d * (1.0 - alpha))) for s, d in zip(src, dst))


def draw_mark(buf, w, size, ox, oy):
    """Composite the mark at `size` pixels with its top-left at (ox, oy)."""
    scale = size / GRID
    for y in range(size):
        py = (y + 0.5) / scale
        row = (oy + y) * w
        for x in range(size):
            px = (x + 0.5) / scale
            tile = coverage(sd_round_rect(px, py, GRID, GRID, TILE_RADIUS) * scale)
            if tile <= 0.0:
                continue

            # The tile's own gradient, 135 degrees corner to corner.
            t = max(0.0, min(1.0, (px + py) / (2 * GRID)))
            rgb = tuple(
                int(round(a + (b - a) * t)) for a, b in zip(LIME_BRIGHT, LIME_DEEP)
            )

            arc = coverage((sd_polyline(px, py, ARC_PTS) - ARC_WIDTH / 2.0) * scale)
            dot = coverage(sd_circle(px, py, *DOT) * scale)
            ink = max(arc, dot)
            if ink > 0.0:
                rgb = over(rgb, ON_LIME, ink)

            i = (row + ox + x) * 4
            a = int(round(tile * 255))
            # Premultiplying is wrong for PNG, but so is leaving the colour of
            # a fully transparent pixel undefined: some downscalers average it
            # back in and the mark grows a dark halo. Write the fill colour at
            # every pixel and let alpha do the cutting.
            buf[i] = rgb[0]
            buf[i + 1] = rgb[1]
            buf[i + 2] = rgb[2]
            buf[i + 3] = a


def write_png(path, w, h, buf):
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type 0: none. These images compress fine flat.
        raw += buf[y * stride : (y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)
    return len(png)


def icon(path, size):
    buf = bytearray(size * size * 4)
    draw_mark(buf, size, size, 0, 0)
    return write_png(path, size, size, buf)


def social_card(path, w=1200, h=630):
    """The unfurl card.

    Deliberately wordless. The scraper already has the title and description
    from the meta tags and renders them itself in the host's own type; an
    image repeating them in ours would be the same sentence twice, in two
    fonts, one of them resampled. The mark on the brand's own dark field is
    the part the text cannot say.
    """
    buf = bytearray(w * h * 4)
    mark = 236
    mx, my = (w - mark) // 2, (h - mark) // 2 - 18
    gx, gy = w / 2.0, h / 2.0 - 30
    # A lime glow behind the mark, falling off over ~430px, so the card reads
    # as lit rather than as a logo dropped on black.
    # A large soft radial in 8 bits bands into visible rings: the gradient
    # crosses a quantisation step far more slowly than one pixel, so the step
    # becomes a contour line. A sub-LSB ordered dither moves the step boundary
    # around by less than one level, which is below the eye's threshold for a
    # dot and well above its threshold for a ring.
    BAYER = [
        [0, 8, 2, 10],
        [12, 4, 14, 6],
        [3, 11, 1, 9],
        [15, 7, 13, 5],
    ]
    for y in range(h):
        for x in range(w):
            d = math.hypot(x + 0.5 - gx, y + 0.5 - gy) / 520.0
            glow = max(0.0, 1.0 - d) ** 2.2 * 0.34
            i = (y * w + x) * 4
            jitter = (BAYER[y & 3][x & 3] + 0.5) / 16.0 - 0.5
            rgb = tuple(
                max(0, min(255, int(round(c + jitter))))
                for c in (
                    b * glow + a * (1.0 - glow)
                    for a, b in zip(INK_BG, LIME_DEEP)
                )
            )
            buf[i], buf[i + 1], buf[i + 2], buf[i + 3] = rgb[0], rgb[1], rgb[2], 255
    draw_mark(buf, w, mark, mx, my)
    # A short rule under the mark, at the lime, as a baseline for the title the
    # scraper will draw beneath the image.
    ry, rh, rw = my + mark + 54, 6, 132
    for y in range(ry, ry + rh):
        for x in range((w - rw) // 2, (w + rw) // 2):
            i = (y * w + x) * 4
            buf[i], buf[i + 1], buf[i + 2] = LIME_DEEP
    return write_png(path, w, h, buf)


def main():
    os.makedirs(os.path.join(OUT, "brand"), exist_ok=True)
    made = []
    for name, size in (
        ("favicon-32.png", 32),
        ("favicon-180.png", 180),
        ("favicon-512.png", 512),
    ):
        made.append((name, icon(os.path.join(OUT, name), size)))
    made.append(("brand/social-card.png", social_card(os.path.join(OUT, "brand", "social-card.png"))))
    for name, size in made:
        print(f"  {name:28} {size/1024:7.1f} KB")


if __name__ == "__main__":
    main()
