#!/usr/bin/env python3
"""Generate a simple brand icon (PNG) for EpicDeck.

No third-party deps: writes a PNG manually via zlib + struct.
Draws an abstract "game pad + arrow" mark on a rounded dark card.
"""
import struct
import zlib
import math
import os

SIZE = 512
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "icon.png")


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


BG_TOP = hex_rgb("2b2f3a")      # dark slate
BG_BOTTOM = hex_rgb("1a1d24")   # darker
ACCENT = hex_rgb("7c5cff")      # epic-ish purple
ACCENT2 = hex_rgb("4fd1c5")     # teal accent


def lerp(a, b, t):
    return a + (b - a) * t


def rounded_rect_alpha(x, y, w, h, r):
    """Return 0..1 coverage for a rounded rect (for anti-aliased bg card)."""
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = max(abs(x - cx) - (w / 2 - r), 0)
    dy = max(abs(y - cy) - (h / 2 - r), 0)
    dist = math.hypot(dx, dy)
    return max(0.0, min(1.0, r - dist + 0.5))


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    rows = []
    for py in range(SIZE):
        row = bytearray()
        # background vertical gradient
        t = py / (SIZE - 1)
        for px in range(SIZE):
            base = (
                round(lerp(BG_TOP[0], BG_BOTTOM[0], t)),
                round(lerp(BG_TOP[1], BG_BOTTOM[1], t)),
                round(lerp(BG_TOP[2], BG_BOTTOM[2], t)),
            )
            # rounded card
            card = rounded_rect_alpha(px + 0.5, py + 0.5, SIZE, SIZE, 96)
            r, g, b = base

            # --- draw a stylized gamepad cross + arrow mark ---
            # central circle (left thumbstick)
            cx1, cy1 = 190, 280
            if (px - cx1) ** 2 + (py - cy1) ** 2 <= 78 ** 2:
                r, g, b = ACCENT
            # second circle (right thumbstick)
            cx2, cy2 = 322, 280
            if (px - cx2) ** 2 + (py - cy2) ** 2 <= 78 ** 2:
                r, g, b = ACCENT2
            # dpad cross (horizontal bar)
            if 150 <= py <= 170 and 100 <= px <= 280:
                r, g, b = ACCENT
            # dpad cross (vertical bar)
            if 110 <= py <= 210 and 140 <= px <= 160:
                r, g, b = ACCENT
            # a "download/launch" arrow (triangle) in the middle
            # simple upward chevron between the two circles
            d = abs(px - 256)
            if 200 <= py <= 240 and d <= (py - 200) * 0.8 + 20:
                r, g, b = (255, 255, 255)

            # apply card alpha (blend toward a transparent-dark edge is not
            # needed since bg is uniform; keep full opacity)
            row += bytes((r, g, b))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)  # filter byte 0 per row

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )

    with open(OUT, "wb") as f:
        f.write(png)
    print(f"✅ 图标已生成: {OUT} ({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
