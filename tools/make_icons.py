"""Generate the PWA icon set.

Written against the standard library only (zlib + struct) so the repo has no
image dependency and the icons can be regenerated anywhere Python runs:

    python tools/make_icons.py

Shapes are described in normalised 0..1 coordinates as capsules (thick line
segments with round caps), rendered at 4x and box-downsampled for antialiasing.
The logo is five tally marks - four uprights and a diagonal strike.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "frontend" / "public" / "icons"

BG = (49, 46, 129)  # indigo-900
MARK = (238, 242, 255)  # near white
STRIKE = (251, 191, 36)  # amber-400

SUPERSAMPLE = 4

# (x0, y0, x1, y1, radius, colour)
UPRIGHTS = [(x, 0.30, x, 0.70, 0.036) for x in (0.315, 0.445, 0.575, 0.705)]
DIAGONAL = (0.255, 0.715, 0.765, 0.285, 0.036)


def _capsule_hit(px: float, py: float, seg: tuple[float, float, float, float, float]) -> bool:
    x0, y0, x1, y1, radius = seg
    dx, dy = x1 - x0, y1 - y0
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        t = 0.0
    else:
        t = ((px - x0) * dx + (py - y0) * dy) / length_sq
        t = max(0.0, min(1.0, t))
    nearest_x, nearest_y = x0 + t * dx, y0 + t * dy
    return (px - nearest_x) ** 2 + (py - nearest_y) ** 2 <= radius * radius


def _rounded_square_hit(px: float, py: float, radius: float) -> bool:
    """Point-in-rounded-square over the unit square."""
    cx = min(max(px, radius), 1.0 - radius)
    cy = min(max(py, radius), 1.0 - radius)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= radius * radius


def render(size: int, *, maskable: bool) -> bytes:
    """Return RGBA bytes for one icon."""
    hi = size * SUPERSAMPLE
    # Maskable icons get cropped to whatever shape the launcher wants, so the
    # background goes full bleed and the glyph shrinks into the 80% safe zone.
    corner = 0.0 if maskable else 0.225
    glyph_scale = 0.78 if maskable else 1.0

    def scaled(seg):
        x0, y0, x1, y1, r = seg
        return (
            0.5 + (x0 - 0.5) * glyph_scale,
            0.5 + (y0 - 0.5) * glyph_scale,
            0.5 + (x1 - 0.5) * glyph_scale,
            0.5 + (y1 - 0.5) * glyph_scale,
            r * glyph_scale,
        )

    uprights = [scaled(seg) for seg in UPRIGHTS]
    diagonal = scaled(DIAGONAL)

    # Accumulate colour and coverage per output pixel across the supersamples.
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]

    for sy in range(hi):
        py = (sy + 0.5) / hi
        out_y = sy // SUPERSAMPLE
        for sx in range(hi):
            px = (sx + 0.5) / hi

            if corner > 0 and not _rounded_square_hit(px, py, corner):
                continue

            colour = BG
            if _capsule_hit(px, py, diagonal):
                colour = STRIKE
            else:
                for seg in uprights:
                    if _capsule_hit(px, py, seg):
                        colour = MARK
                        break

            cell = acc[out_y * size + (sx // SUPERSAMPLE)]
            cell[0] += colour[0]
            cell[1] += colour[1]
            cell[2] += colour[2]
            cell[3] += 255.0

    samples = SUPERSAMPLE * SUPERSAMPLE
    pixels = bytearray(size * size * 4)
    for index, (r, g, b, a) in enumerate(acc):
        alpha = a / samples
        if alpha <= 0:
            continue
        # Un-premultiply: colour sums only covered samples, alpha tracks coverage.
        covered = a / 255.0
        pixels[index * 4 + 0] = round(r / covered)
        pixels[index * 4 + 1] = round(g / covered)
        pixels[index * 4 + 2] = round(b / covered)
        pixels[index * 4 + 3] = round(alpha)
    return bytes(pixels)


def _chunk(tag: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + tag
        + payload
        + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, size: int, rgba: bytes) -> None:
    stride = size * 4
    raw = b"".join(
        b"\x00" + rgba[row * stride : (row + 1) * stride] for row in range(size)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(raw, 9))
        + _chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def svg_logo(maskable: bool = False) -> str:
    """The same logo as scalable vector, for the favicon and the app header."""
    corner = 0 if maskable else 23
    strokes = "\n".join(
        f'  <line x1="{x0 * 100:.1f}" y1="{y0 * 100:.1f}" x2="{x1 * 100:.1f}" '
        f'y2="{y1 * 100:.1f}" stroke="{colour}" stroke-width="{r * 200:.1f}" '
        'stroke-linecap="round" />'
        for x0, y0, x1, y1, r, colour in [
            (*seg, "#eef2ff") for seg in UPRIGHTS
        ]
        + [(*DIAGONAL, "#fbbf24")]
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="100" height="100" role="img" aria-label="Tally">\n'
        f'  <rect width="100" height="100" rx="{corner}" fill="#312e81" />\n'
        f"{strokes}\n"
        "</svg>\n"
    )


TARGETS = [
    ("icon-192.png", 192, False),
    ("icon-512.png", 512, False),
    ("icon-maskable-192.png", 192, True),
    ("icon-maskable-512.png", 512, True),
    ("apple-touch-icon.png", 180, False),
    ("favicon-32.png", 32, False),
]


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in TARGETS:
        write_png(OUT_DIR / name, size, render(size, maskable=maskable))
        print(f"wrote {name} ({size}x{size}{', maskable' if maskable else ''})")

    (OUT_DIR / "logo.svg").write_text(svg_logo(), encoding="utf-8")
    print("wrote logo.svg")


if __name__ == "__main__":
    main()
