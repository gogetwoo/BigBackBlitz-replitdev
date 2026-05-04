"""Generate 3-frame defender run sprites from a shared sheet.

Input:
  artifacts/big-back-blitz/public/sprites/defender/run_sheet.png

Output (per HBCU variant):
  artifacts/big-back-blitz/public/sprites/defender/<variant>/run_0.png
  artifacts/big-back-blitz/public/sprites/defender/<variant>/run_1.png
  artifacts/big-back-blitz/public/sprites/defender/<variant>/run_2.png

Notes:
  - Black background is converted to transparent.
  - Only template uniform colors are remapped: blue uniform + gold accent.
  - Skin, cleats, and white socks remain untouched.
"""
from __future__ import annotations

from dataclasses import dataclass
import colorsys
import os
from pathlib import Path
from typing import Iterable, List, Tuple

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SHEET_PATH = ROOT / "artifacts" / "big-back-blitz" / "public" / "sprites" / "defender" / "run_sheet.png"
OUT_ROOT = ROOT / "artifacts" / "big-back-blitz" / "public" / "sprites" / "defender"

OUT_W = 128
OUT_H = 192
FRAME_COUNT = 3


@dataclass(frozen=True)
class Palette:
  jersey: Tuple[int, int, int]
  pants: Tuple[int, int, int]
  helmet: Tuple[int, int, int]
  accent: Tuple[int, int, int]


VARIANT_PALETTES: dict[str, Palette] = {
  "grambling":      Palette((15, 15, 15), (255, 184, 28), (15, 15, 15), (255, 184, 28)),
  "alcorn":         Palette((90, 15, 130), (255, 200, 40), (60, 5, 95), (255, 215, 60)),
  "southern":       Palette((40, 50, 130), (255, 200, 40), (40, 50, 130), (255, 200, 40)),
  "famu":           Palette((255, 100, 30), (10, 80, 35), (10, 80, 35), (255, 200, 40)),
  "ncat":           Palette((20, 50, 110), (255, 200, 40), (20, 50, 110), (255, 230, 70)),
  "morehouse":      Palette((110, 20, 30), (245, 245, 245), (110, 20, 30), (255, 215, 0)),
  "hampton":        Palette((15, 35, 90), (245, 245, 245), (15, 35, 90), (245, 245, 245)),
  "texassouthern":  Palette((110, 20, 30), (210, 210, 210), (110, 20, 30), (255, 215, 0)),
  "prairieview":    Palette((95, 20, 130), (255, 200, 40), (95, 20, 130), (255, 200, 40)),
  "bethunecookman": Palette((130, 30, 35), (255, 200, 40), (130, 30, 35), (255, 200, 40)),
}


def _rgb_to_hsv01(rgb: Tuple[int, int, int]) -> Tuple[float, float, float]:
  return colorsys.rgb_to_hsv(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0)


def _hsv01_to_rgb(h: float, s: float, v: float) -> Tuple[int, int, int]:
  r, g, b = colorsys.hsv_to_rgb(max(0.0, min(1.0, h)), max(0.0, min(1.0, s)), max(0.0, min(1.0, v)))
  return (int(round(r * 255)), int(round(g * 255)), int(round(b * 255)))


def _is_bg_black(r: int, g: int, b: int, a: int) -> bool:
  return a > 0 and r <= 10 and g <= 10 and b <= 10


def _to_transparent_background(img: Image.Image) -> Image.Image:
  out = img.convert("RGBA")
  px = out.load()
  w, h = out.size
  for y in range(h):
    for x in range(w):
      r, g, b, a = px[x, y]
      if _is_bg_black(r, g, b, a):
        px[x, y] = (0, 0, 0, 0)
  return out


def _find_column_ranges(alpha_img: Image.Image) -> List[Tuple[int, int]]:
  w, h = alpha_img.size
  px = alpha_img.load()
  cols = []
  for x in range(w):
    active = False
    for y in range(h):
      if px[x, y][3] > 0:
        active = True
        break
    cols.append(active)

  ranges: List[Tuple[int, int]] = []
  in_run = False
  start = 0
  for i, active in enumerate(cols):
    if active and not in_run:
      in_run = True
      start = i
    elif not active and in_run:
      ranges.append((start, i - 1))
      in_run = False
  if in_run:
    ranges.append((start, w - 1))
  return ranges


def _bbox_for_xrange(img: Image.Image, x0: int, x1: int) -> Tuple[int, int, int, int]:
  px = img.load()
  w, h = img.size
  min_y = h
  max_y = 0
  for y in range(h):
    for x in range(max(0, x0), min(w, x1 + 1)):
      if px[x, y][3] > 0:
        min_y = min(min_y, y)
        max_y = max(max_y, y)
  if min_y > max_y:
    raise RuntimeError("failed to detect non-transparent pixels in frame range")
  return (x0, min_y, x1 + 1, max_y + 1)


def _extract_three_frames(sheet_rgba: Image.Image) -> List[Image.Image]:
  ranges = _find_column_ranges(sheet_rgba)
  if len(ranges) != FRAME_COUNT:
    raise RuntimeError(f"expected {FRAME_COUNT} frame columns, found {len(ranges)}")
  frames = []
  for x0, x1 in ranges:
    bbox = _bbox_for_xrange(sheet_rgba, x0, x1)
    frames.append(sheet_rgba.crop(bbox))
  return frames


def _is_accent_gold(h: float, s: float, v: float) -> bool:
  return 0.09 <= h <= 0.19 and s >= 0.42 and v >= 0.30


def _is_uniform_blue(r: int, g: int, b: int, h: float, s: float, v: float) -> bool:
  if 0.52 <= h <= 0.68 and s >= 0.30 and v >= 0.12:
    return True
  # Catch dark navy shades that can lose saturation.
  return b > r + 8 and b > g + 4 and b >= 30


def _retint_pixel(src_rgb: Tuple[int, int, int], target_rgb: Tuple[int, int, int]) -> Tuple[int, int, int]:
  sh, ss, sv = _rgb_to_hsv01(src_rgb)
  th, ts, tv = _rgb_to_hsv01(target_rgb)
  nh = th
  ns = min(1.0, ts * (0.60 + 0.40 * ss))
  nv = max(0.0, min(1.0, sv * (0.52 + 0.68 * tv)))
  _ = sh  # keep naming explicit; hue intentionally replaced by target hue
  return _hsv01_to_rgb(nh, ns, nv)


def _recolor_frame(frame: Image.Image, pal: Palette) -> Image.Image:
  out = frame.convert("RGBA")
  px = out.load()
  w, h = out.size

  for y in range(h):
    yn = y / max(1, h - 1)
    for x in range(w):
      r, g, b, a = px[x, y]
      if a == 0:
        continue

      h0, s0, v0 = _rgb_to_hsv01((r, g, b))
      if _is_accent_gold(h0, s0, v0):
        nr, ng, nb = _retint_pixel((r, g, b), pal.accent)
        px[x, y] = (nr, ng, nb, a)
        continue

      if _is_uniform_blue(r, g, b, h0, s0, v0):
        # Spatial split for blue template areas:
        # helmet (top), jersey/arms (middle), pants (lower).
        if yn < 0.24:
          target = pal.helmet
        elif yn > 0.56:
          target = pal.pants
        else:
          target = pal.jersey
        nr, ng, nb = _retint_pixel((r, g, b), target)
        px[x, y] = (nr, ng, nb, a)

  return out


def _fit_to_sprite_canvas(src: Image.Image) -> Image.Image:
  sw, sh = src.size
  scale = min(OUT_W / sw, OUT_H / sh)
  nw = max(1, int(round(sw * scale)))
  nh = max(1, int(round(sh * scale)))
  resized = src.resize((nw, nh), Image.Resampling.LANCZOS)

  out = Image.new("RGBA", (OUT_W, OUT_H), (0, 0, 0, 0))
  # bottom align for stable foot placement
  ox = (OUT_W - nw) // 2
  oy = OUT_H - nh
  out.alpha_composite(resized, (ox, oy))
  return out


def _ensure_dirs(variants: Iterable[str]) -> None:
  for v in variants:
    os.makedirs(OUT_ROOT / v, exist_ok=True)


def main() -> None:
  if not SHEET_PATH.exists():
    raise FileNotFoundError(f"missing run sheet: {SHEET_PATH}")

  sheet = Image.open(SHEET_PATH).convert("RGBA")
  sheet = _to_transparent_background(sheet)
  source_frames = _extract_three_frames(sheet)

  _ensure_dirs(VARIANT_PALETTES.keys())
  for variant, pal in VARIANT_PALETTES.items():
    for i, src_frame in enumerate(source_frames):
      recolored = _recolor_frame(src_frame, pal)
      fitted = _fit_to_sprite_canvas(recolored)
      out_path = OUT_ROOT / variant / f"run_{i}.png"
      fitted.save(out_path)
    print(f"generated run_0..run_2 for {variant}")


if __name__ == "__main__":
  main()

