#!/usr/bin/env python3
"""Build the macOS app icon from the IRIS cube mark.

The shipped icon was a full-bleed square with opaque corners, which is why it read as
foreign next to every native app in the dock. This rebuilds it on Apple's actual grid.

Usage:  python3 packages/desktop/scripts/make-icon.py <source-1024.png> <out-dir>
"""
import math
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

SS = 2                       # supersample, downscaled at the end
CANVAS = 1024 * SS
BODY = int(824 * SS)         # Apple's icon body is 824 of a 1024 canvas...
OFF = (CANVAS - BODY) // 2   # ...centred, so 100 each side. The padding is what makes it
                             # sit correctly among native icons.
GLYPH = 0.66                 # cube size as a fraction of the body. 0.56 looked balanced at
                             # 1024 and vanished at 16 and 32px — the menu bar and list views
                             # are the sizes an icon has to survive.
CUBE_THRESHOLD = 24          # see below


def squircle(size: int, n: float = 5.0) -> Image.Image:
    """Apple's silhouette is a SUPERELLIPSE, not a rounded rectangle — a rounded rect turns
    too abruptly at the corners and reads subtly wrong beside real icons."""
    m = Image.new("L", (size, size), 0)
    px = m.load()
    a = size / 2.0
    for y in range(size):
        dy = abs((y + 0.5 - a) / a) ** n
        if dy > 1:
            continue
        half = a * (1.0 - dy) ** (1.0 / n)
        for x in range(max(0, int(a - half)), min(size, int(math.ceil(a + half)))):
            px[x, y] = 255
    return m


def cube_layer(source: str, size: int) -> Image.Image:
    """Lift the white cube off its black background, cropped to the cube itself.

    THRESHOLD FIRST. The source has faint non-black pixels along its edges, so a raw
    getbbox() returned (0, 0, 1024, 902) — the whole canvas rather than the glyph. Cropping
    to that centred the IMAGE instead of the CUBE and pushed it 30px low, which is visible.
    Thresholded, the cube's true bbox is (188, 124, 836, 900), dead centre.
    """
    lum = Image.open(source).convert("L").resize((size, size), Image.LANCZOS)
    solid = lum.point(lambda v: 255 if v > CUBE_THRESHOLD else 0)
    cube = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    cube.putalpha(lum)                       # keep the soft edge for antialiasing...
    cube.putalpha(ImageChops.multiply(cube.split()[3], solid))   # ...but drop the background
    return cube.crop(cube.getbbox())


def build(source: str) -> Image.Image:
    mask = squircle(BODY)

    # Ground: hue-biased near-black, never #000. Flat black reads as a hole in the dock and
    # leaves nothing for the drop shadow to separate from a dark wallpaper.
    bg = Image.new("RGB", (BODY, BODY))
    d = ImageDraw.Draw(bg)
    top, bot = (30, 31, 38), (8, 8, 11)
    for y in range(BODY):
        t = y / (BODY - 1)
        d.line([(0, y), (BODY, y)],
               fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
    body = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    body.paste(bg, (0, 0), mask)

    # Rim light along the top edge: the cheapest thing that makes a dark icon look machined
    # rather than printed. Built by offsetting the silhouette and keeping the sliver.
    rim = Image.new("L", (BODY, BODY), 0)
    rim.paste(mask, (0, int(3 * SS)))
    rim = ImageChops.subtract(mask, rim).filter(ImageFilter.GaussianBlur(1.6 * SS))
    fade = Image.new("L", (BODY, BODY), 0)
    fd = ImageDraw.Draw(fade)
    for y in range(BODY):
        fd.line([(0, y), (BODY, y)], fill=max(0, int(190 * (1 - y / (BODY * 0.40)))))
    body.paste(Image.new("RGBA", (BODY, BODY), (255, 255, 255, 255)), (0, 0),
               ImageChops.multiply(rim, fade))

    cube = cube_layer(source, BODY)
    w, h = cube.size
    s = int(BODY * GLYPH) / max(w, h)
    cube = cube.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
    cw, ch = cube.size

    # Dimensional shading. Flat white reads as a sticker; a lit object reads as an object.
    shade = Image.new("RGB", (cw, ch))
    sd = ImageDraw.Draw(shade)
    hi, lo = (255, 255, 255), (176, 180, 196)
    for y in range(ch):
        t = (y / max(1, ch - 1)) ** 0.85
        sd.line([(0, y), (cw, y)],
                fill=tuple(int(hi[i] + (lo[i] - hi[i]) * t) for i in range(3)))
    lit = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    lit.paste(shade, (0, 0), cube.split()[3])

    cx, cy = (BODY - cw) // 2, (BODY - ch) // 2

    # Contact shadow, clipped to the body so it cannot bleed past the squircle.
    cs = Image.new("RGBA", (BODY, BODY), (0, 0, 0, 0))
    cs.paste(Image.new("RGBA", (cw, ch), (0, 0, 0, 120)), (cx, cy + int(9 * SS)),
             cube.split()[3])
    cs = cs.filter(ImageFilter.GaussianBlur(9 * SS))
    cs.putalpha(ImageChops.multiply(cs.split()[3], mask))
    body.alpha_composite(cs)
    body.alpha_composite(lit, (cx, cy))

    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sh = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    sh.paste((0, 0, 0, 95), (OFF, OFF + int(12 * SS)), mask)
    canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(16 * SS)))
    canvas.alpha_composite(body, (OFF, OFF))
    return canvas.resize((1024, 1024), Image.LANCZOS)


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    icon = build(src)
    icon.save(f"{out}/icon-1024.png")
    print(f"wrote {out}/icon-1024.png")
