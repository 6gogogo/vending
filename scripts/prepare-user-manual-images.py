#!/usr/bin/env python3
"""根据版本化清单生成用户手册截图。

源图保持不变；输出图仅执行确定性的裁切、遮盖和编号标记。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "docs" / "用户手册" / "截图清单.json"
GREEN = "#087A63"
PALE = "#F3F8F5"
INK = "#17312B"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path("C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf" if bold else "C:/Windows/Fonts/simsun.ttc"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def resolve(path: str) -> Path:
    return (REPO_ROOT / path).resolve()


def add_redaction(draw: ImageDraw.ImageDraw, item: dict) -> None:
    box = tuple(item["box"])
    draw.rounded_rectangle(box, radius=8, fill=PALE, outline=GREEN, width=2)
    label = item.get("label", "已隐藏")
    font = load_font(16, bold=True)
    text_box = draw.textbbox((0, 0), label, font=font)
    text_width = text_box[2] - text_box[0]
    text_height = text_box[3] - text_box[1]
    x = box[0] + max(8, (box[2] - box[0] - text_width) // 2)
    y = box[1] + max(5, (box[3] - box[1] - text_height) // 2)
    draw.text((x, y), label, font=font, fill=INK)


def add_marker(draw: ImageDraw.ImageDraw, marker: dict, radius: int) -> None:
    x = int(marker["x"])
    y = int(marker["y"])
    label = str(marker["label"])
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=GREEN, outline="white", width=3)
    font = load_font(max(14, int(radius * 1.15)), bold=True)
    text_box = draw.textbbox((0, 0), label, font=font)
    text_width = text_box[2] - text_box[0]
    text_height = text_box[3] - text_box[1]
    draw.text((x - text_width / 2, y - text_height / 2 - 2), label, font=font, fill="white")


def process_image(item: dict, force: bool) -> tuple[Path, tuple[int, int]]:
    source = resolve(item["source"])
    output = resolve(item["output"])
    if not source.exists():
        raise FileNotFoundError(f"截图源不存在：{source}")
    if output.exists() and not force and output.stat().st_mtime >= source.stat().st_mtime:
        with Image.open(output) as existing:
            return output, existing.size

    with Image.open(source) as opened:
        image = opened.convert("RGB")
    crop = item.get("crop")
    if crop:
        image = image.crop(tuple(crop))

    draw = ImageDraw.Draw(image)
    for redaction in item.get("redactions", []):
        add_redaction(draw, redaction)
    marker_radius = 16 if image.width <= 500 else 20
    for marker in item.get("markers", []):
        add_marker(draw, marker, marker_radius)

    output.parent.mkdir(parents=True, exist_ok=True)
    image.save(output, format="PNG", optimize=True)
    return output, image.size


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    forbidden = tuple(manifest.get("forbiddenSourceFragments", []))
    generated = []
    for item in manifest["images"]:
        source = item["source"]
        if any(fragment in source for fragment in forbidden):
            raise ValueError(f"禁止引用旧截图：{source}")
        output, size = process_image(item, args.force)
        generated.append((output.relative_to(REPO_ROOT).as_posix(), size))

    for output, size in generated:
        print(f"{output} {size[0]}x{size[1]}")
    print(f"已生成 {len(generated)} 张手册截图。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
