"""Generate assets/icon.ico for MD Previewer.

Pure-Pillow rasterization at multiple sizes, packed into a single
multi-resolution .ico. No SVG renderer required.

Design:
  - Rounded square background with a vertical gradient
    (dark navy #1f2937  ->  accent blue #3b82f6).
  - Big white "M" centered.
  - On sizes >= 48 px, a small white down-arrow at the bottom-right
    of the M to convey "Markdown ->".
  - On 16/32 px we drop the arrow and thicken the M for legibility.

Run:
    python tools/make-icon/make_icon.py
"""

from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 32, 48, 64, 128, 256]

OUT_PATH = Path(__file__).resolve().parents[2] / "assets" / "icon.ico"

# Gradient endpoints (top -> bottom).
TOP_COLOR = (31, 41, 55)       # #1f2937
BOTTOM_COLOR = (59, 130, 246)  # #3b82f6
FG = (255, 255, 255, 255)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int, int]:
    return (
        int(a[0] + (b[0] - a[0]) * t),
        int(a[1] + (b[1] - a[1]) * t),
        int(a[2] + (b[2] - a[2]) * t),
        255,
    )


def make_background(size: int) -> Image.Image:
    """Rounded-square gradient background, painted at 4x supersample for AA."""
    s = size * 4
    grad = Image.new("RGBA", (s, s))
    px = grad.load()
    for y in range(s):
        t = y / max(1, s - 1)
        c = lerp(TOP_COLOR, BOTTOM_COLOR, t)
        for x in range(s):
            px[x, y] = c

    # Rounded-square mask.
    mask = Image.new("L", (s, s), 0)
    radius = int(s * 0.22)
    ImageDraw.Draw(mask).rounded_rectangle([(0, 0), (s - 1, s - 1)], radius=radius, fill=255)

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def find_bold_font(target_px: int) -> ImageFont.FreeTypeFont:
    """Locate a heavy sans font on the local system."""
    candidates = [
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\seguisb.ttf",
        r"C:\Windows\Fonts\segoeui.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, target_px)
            except OSError:
                continue
    return ImageFont.load_default()


def draw_m(img: Image.Image, size: int) -> None:
    """Draw a centered white 'M'."""
    draw = ImageDraw.Draw(img)
    # Tune font size: small icons need a relatively bigger glyph.
    if size <= 16:
        ratio = 0.95
        offset_y = -0.04
    elif size <= 32:
        ratio = 0.85
        offset_y = -0.04
    else:
        ratio = 0.72
        offset_y = -0.02

    target_px = max(8, int(size * ratio))
    font = find_bold_font(target_px)
    text = "M"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    x = (size - tw) // 2 - bbox[0]
    y = (size - th) // 2 - bbox[1] + int(size * offset_y)
    draw.text((x, y), text, font=font, fill=FG)


def draw_arrow(img: Image.Image, size: int) -> None:
    """Draw a small down-arrow at the bottom-right corner (sizes >= 48)."""
    if size < 48:
        return
    draw = ImageDraw.Draw(img)
    # Arrow bounding box (bottom-right quadrant).
    a = int(size * 0.32)
    margin = int(size * 0.08)
    x1 = size - margin
    y1 = size - margin
    x0 = x1 - a
    y0 = y1 - a

    # Filled triangle pointing down + a short vertical stem.
    cx = (x0 + x1) / 2
    stem_w = max(2, int(size * 0.045))
    stem_top = y0 + int(a * 0.05)
    stem_bot = y0 + int(a * 0.55)

    # Subtle dark backdrop disc so the arrow reads on the blue gradient.
    pad = int(size * 0.04)
    draw.ellipse(
        [(x0 - pad, y0 - pad), (x1 + pad, y1 + pad)],
        fill=(31, 41, 55, 230),
    )

    # Stem.
    draw.rectangle(
        [(cx - stem_w / 2, stem_top), (cx + stem_w / 2, stem_bot)],
        fill=FG,
    )
    # Head (triangle).
    head_h = int(a * 0.45)
    head_w = int(a * 0.75)
    draw.polygon(
        [
            (cx - head_w / 2, stem_bot),
            (cx + head_w / 2, stem_bot),
            (cx, stem_bot + head_h),
        ],
        fill=FG,
    )


def render(size: int) -> Image.Image:
    img = make_background(size)
    draw_m(img, size)
    draw_arrow(img, size)
    return img


def main() -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    frames = [render(s) for s in SIZES]
    # Pillow's ICO writer takes the highest-resolution frame as base and
    # downscales to each requested size; pass the largest and let the
    # `sizes=` kwarg embed every variant.
    base = frames[-1]
    base.save(
        OUT_PATH,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=frames[:-1],
    )
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size} bytes, {len(SIZES)} resolutions)")


if __name__ == "__main__":
    main()
