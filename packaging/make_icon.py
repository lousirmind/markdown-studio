#!/usr/bin/env python3
"""Draw the Markdown Studio application icon.

Renders a 1024x1024 PNG (gradient squircle + document sheet + M↓ mark) and
derives the macOS .icns bundle via sips/iconutil. Run from the repo root:

    python3 packaging/make_icon.py
"""

import os
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
SIZE = 1024
MARGIN = 96
RADIUS = 196
SCALE = 2  # supersampling factor for crisp edges

INDIGO = (79, 70, 229)
VIOLET = (147, 51, 234)
ROSE = (192, 38, 211)
INK = (55, 48, 163)
LIGHT = (224, 231, 255)


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def mix(c1, c2, t):
    return (lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t))


def squircle_mask(size, margin, radius):
    w = size * SCALE
    mask = Image.new("L", (w, w), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        [margin * SCALE, margin * SCALE, w - margin * SCALE, w - margin * SCALE],
        radius=radius * SCALE,
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def gradient(size):
    img = Image.new("RGB", (size, size))
    pixels = img.load()
    for y in range(size):
        for x in range(size):
            t = min(1.0, max(0.0, 0.18 + (x / size) * 0.55 + (y / size) * 0.45))
            if t < 0.55:
                color = mix(INDIGO, VIOLET, t / 0.55)
            else:
                color = mix(VIOLET, ROSE, (t - 0.55) / 0.45)
            pixels[x, y] = color
    return img


def rounded_line(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def build_icon():
    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Outer soft shadow under the squircle.
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [MARGIN, MARGIN + 22, SIZE - MARGIN, SIZE - MARGIN + 22],
        radius=RADIUS,
        fill=(24, 16, 74, 110),
    )
    base.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(34)))

    # Gradient body masked into the squircle.
    mask = squircle_mask(SIZE, MARGIN, RADIUS)
    body = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    body.paste(gradient(SIZE), (0, 0), mask)
    base.alpha_composite(body)

    # Soft top-left sheen for depth.
    sheen = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        [MARGIN - 120, MARGIN - 260, SIZE - MARGIN - 40, MARGIN + 500],
        fill=(255, 255, 255, 46),
    )
    sheen = sheen.filter(ImageFilter.GaussianBlur(90))
    sheen_masked = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    sheen_masked.paste(sheen, (0, 0), mask)
    base.alpha_composite(sheen_masked)

    # Inner border highlight.
    border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle(
        [MARGIN + 4, MARGIN + 4, SIZE - MARGIN - 4, SIZE - MARGIN - 4],
        radius=RADIUS - 4,
        outline=(255, 255, 255, 68),
        width=5,
    )
    base.alpha_composite(border)

    # Document sheet with its own shadow.
    page_box = (312, 250, 712, 774)
    page_shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(page_shadow).rounded_rectangle(
        [page_box[0], page_box[1] + 18, page_box[2], page_box[3] + 18],
        radius=48,
        fill=(22, 14, 72, 96),
    )
    base.alpha_composite(page_shadow.filter(ImageFilter.GaussianBlur(22)))

    page = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(page).rounded_rectangle(page_box, radius=48, fill=(255, 255, 255, 252))
    base.alpha_composite(page)

    draw = ImageDraw.Draw(base)

    # Big "M" mark.
    font_candidates = [
        "/System/Library/Fonts/Supplemental/Arial Black.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/SFNS.ttf",
    ]
    font = None
    for path in font_candidates:
        if os.path.exists(path):
            font = ImageFont.truetype(path, 238)
            break
    if font is None:
        font = ImageFont.load_default()

    letter = "M"
    bbox = draw.textbbox((0, 0), letter, font=font)
    m_w = bbox[2] - bbox[0]
    m_h = bbox[3] - bbox[1]
    m_x = page_box[0] + 40 - bbox[0]
    m_y = page_box[1] + 66 - bbox[1]
    draw.text((m_x, m_y), letter, font=font, fill=INK)

    # Down arrow next to the M (Markdown mark).
    arrow_cx = page_box[2] - 78
    stem_w = 40
    stem_top = page_box[1] + 92
    stem_bottom = page_box[1] + 246
    draw.rounded_rectangle(
        [arrow_cx - stem_w // 2, stem_top, arrow_cx + stem_w // 2, stem_bottom],
        radius=12,
        fill=VIOLET,
    )
    head_half = 66
    head_top = stem_bottom - 10
    head_tip = head_top + 104
    draw.polygon(
        [
            (arrow_cx - head_half, head_top),
            (arrow_cx + head_half, head_top),
            (arrow_cx, head_tip),
        ],
        fill=VIOLET,
    )

    # Text lines under the mark.
    line_left = page_box[0] + 44
    line_right = page_box[2] - 44
    widths = [1.0, 0.82, 0.6]
    for i, ratio in enumerate(widths):
        y = page_box[1] + 356 + i * 62
        rounded_line(
            draw,
            [line_left, y, line_left + int((line_right - line_left) * ratio), y + 22],
            11,
            (199, 203, 246, 255),
        )

    # Small accent dot bottom-right of the page.
    draw.ellipse(
        [page_box[2] - 96, page_box[3] - 74, page_box[2] - 44, page_box[3] - 22],
        fill=(147, 51, 234, 255),
    )

    return base


def main():
    icon = build_icon()
    png_path = os.path.join(HERE, "icon_1024.png")
    icon.save(png_path, "PNG")

    iconset = os.path.join(HERE, "AppIcon.iconset")
    if os.path.isdir(iconset):
        shutil.rmtree(iconset)
    os.makedirs(iconset)

    sizes = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for px, name in sizes:
        subprocess.run(
            ["sips", "-z", str(px), str(px), png_path, "--out", os.path.join(iconset, name)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    icns_path = os.path.join(HERE, "icon.icns")
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns_path], check=True)
    print("wrote", png_path)
    print("wrote", icns_path)


if __name__ == "__main__":
    sys.exit(main())
