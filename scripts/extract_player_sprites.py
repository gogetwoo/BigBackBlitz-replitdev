"""Extract individual player sprite frames from the Alcorn State #82 reference sheet.

Each cell on the sheet has a white interior background; the surrounding sheet
chrome is dark navy. We chroma-key out white-ish pixels to make each sprite
transparent, then auto-crop to the figure bounds and center it on a uniform
canvas so frames can be swapped in-game with no jitter.
"""
from __future__ import annotations

from PIL import Image
import numpy as np
import os

SRC = "attached_assets/file_000000007a84722f9d76371dbe8f5855_1777751362281.png"
OUT_DIR = "artifacts/big-back-blitz/public/sprites/player"

# Uniform output canvas (centered pivot at canvas center)
CANVAS_W = 128
CANVAS_H = 192

# Cell coordinates on the reference sheet: (state_name, frame_index, x0, x1, y0, y1)
# y bands: row1 sprite content y=94..270; row2 y=310..490; row3 y=526..710
# y values include enough vertical room to capture the whole figure (helmet to feet).
ROW1_Y = (90, 272)   # idle / running / sprint
ROW2_Y = (302, 492)  # jump / slide / dive / lane change
ROW3_Y = (518, 712)  # duck-roll / catch / celebration / stumble

# IDLE — picked first and a slightly different stance for breathing variation
IDLE_CELLS = [
    (20, 72),
    (153, 209),
]

# RUNNING (8 frames) — full cycle from the running strip
RUNNING_CELLS = [
    (375, 439),
    (460, 519),
    (538, 593),
    (605, 673),
    (702, 767),
    (804, 863),
    (892, 948),
    (963, 1030),
]

# SPRINT (4 frames)
SPRINT_CELLS = [
    (1241, 1310),
    (1320, 1385),
    (1396, 1460),
    (1470, 1524),
]

# JUMP (3 frames: anticipation, peak, land) — pick frames 1, 3, 5
JUMP_CELLS = [
    (19, 76),
    (183, 246),
    (357, 422),
]

# SLIDE (3 frames)
SLIDE_CELLS = [
    (457, 512),
    (534, 621),
    (647, 727),
]

# LANE CHANGE LEFT (2 frames)
LANE_LEFT_CELLS = [
    (1104, 1166),
    (1188, 1266),
]

# LANE CHANGE RIGHT (2 frames) — last cell on the row sometimes only contains
# an arrow indicator, so we take the two leftmost figure cells of the right group
LANE_RIGHT_CELLS = [
    (1301, 1367),
    (1379, 1432),
]

# DUCK / ROLL (used for dodge animation — replaces the bare 360° spin)
DODGE_CELLS = [
    (9, 73),
    (94, 150),
    (168, 235),
    (245, 307),
]

# CATCH (2 frames)
CATCH_CELLS = [
    (420, 495),
    (511, 557),
]

# CELEBRATION (3 frames)
CELEBRATION_CELLS = [
    (809, 873),
    (896, 970),
    (988, 1069),
]

# STUMBLE / HIT (2 frames)
STUMBLE_CELLS = [
    (1197, 1265),
    (1280, 1345),
]


def chroma_key(rgb: np.ndarray) -> np.ndarray:
    """Build an alpha channel from an RGB array.

    Pixels close to pure white become fully transparent; near-white pixels
    fade smoothly so anti-aliased edges stay clean. Dark / saturated pixels
    stay fully opaque.
    """
    r, g, b = rgb[..., 0].astype(np.int32), rgb[..., 1].astype(np.int32), rgb[..., 2].astype(np.int32)
    mn = np.minimum(np.minimum(r, g), b)
    mx = np.maximum(np.maximum(r, g), b)
    # White detection: very bright AND very low chroma
    chroma = mx - mn
    # Score 0 = transparent, 255 = opaque
    # Opaque if mean is dark OR there is significant color
    mean = (r + g + b) // 3
    # Soft thresholds
    bright_t = 235
    chroma_t = 20
    alpha = np.where(
        (mean >= bright_t) & (chroma <= chroma_t),
        0,
        255,
    ).astype(np.uint8)
    # Soften edges: pixels that are bright-ish but have a little chroma get
    # a partial alpha based on how white-ish they are
    soft_band = (mean >= 200) & (mean < bright_t) & (chroma < chroma_t + 10)
    if soft_band.any():
        # Linear ramp from full opacity (mean=200) to transparent (mean=235)
        ramp = np.clip((bright_t - mean) / (bright_t - 200), 0, 1)
        alpha[soft_band] = (ramp[soft_band] * 255).astype(np.uint8)
    return alpha


def largest_component(mask: np.ndarray) -> np.ndarray:
    """Return a boolean mask containing only the largest connected component
    of `mask`. 4-connectivity flood-fill, implemented manually to avoid
    pulling in scipy.
    """
    H, W = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    best = np.zeros_like(mask, dtype=bool)
    best_size = 0
    # Iterative flood-fill
    for sy in range(H):
        for sx in range(W):
            if not mask[sy, sx] or seen[sy, sx]:
                continue
            stack = [(sy, sx)]
            comp_pixels = []
            while stack:
                y, x = stack.pop()
                if y < 0 or y >= H or x < 0 or x >= W:
                    continue
                if seen[y, x] or not mask[y, x]:
                    continue
                seen[y, x] = True
                comp_pixels.append((y, x))
                stack.append((y + 1, x))
                stack.append((y - 1, x))
                stack.append((y, x + 1))
                stack.append((y, x - 1))
            if len(comp_pixels) > best_size:
                best_size = len(comp_pixels)
                best = np.zeros_like(mask, dtype=bool)
                for (y, x) in comp_pixels:
                    best[y, x] = True
    return best


def extract_frame(sheet: np.ndarray, x0: int, x1: int, y0: int, y1: int) -> Image.Image:
    """Extract a single frame, chroma-key the white background, and center it
    on a fixed canvas.
    """
    crop = sheet[y0:y1, x0:x1, :]
    alpha = chroma_key(crop)

    # Drop stray labels / dashed dividers by keeping only the largest connected
    # blob of opaque pixels (the figure itself).
    mask = alpha > 16
    if not mask.any():
        return Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    keep = largest_component(mask)
    alpha = np.where(keep, alpha, 0).astype(np.uint8)
    rgba = np.dstack([crop, alpha])

    if not (alpha > 16).any():
        return Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    ys, xs = np.where(alpha > 16)
    by0, by1 = ys.min(), ys.max() + 1
    bx0, bx1 = xs.min(), xs.max() + 1
    fig = rgba[by0:by1, bx0:bx1]
    fig_h, fig_w = fig.shape[:2]

    # Scale down to fit within canvas while preserving pixel-perfect aspect.
    # Most figures are ~50w x 170h. Leave a small margin.
    max_w = CANVAS_W - 8
    max_h = CANVAS_H - 8
    scale = min(max_w / fig_w, max_h / fig_h, 1.0)
    if scale < 1.0:
        new_w = max(1, int(round(fig_w * scale)))
        new_h = max(1, int(round(fig_h * scale)))
        fig_img = Image.fromarray(fig, "RGBA").resize((new_w, new_h), Image.LANCZOS)
    else:
        fig_img = Image.fromarray(fig, "RGBA")
        new_w, new_h = fig_w, fig_h

    # Center on canvas, anchored so the figure's center aligns with canvas center.
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
    px = (CANVAS_W - new_w) // 2
    py = (CANVAS_H - new_h) // 2
    canvas.paste(fig_img, (px, py), fig_img)
    return canvas


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    sheet_img = Image.open(SRC).convert("RGB")
    sheet = np.array(sheet_img)

    # Save reference sheet copy for design source-of-truth
    sheet_img.save(os.path.join(OUT_DIR, "reference_sheet.png"))

    groups: list[tuple[str, list[tuple[int, int]], tuple[int, int]]] = [
        ("idle", IDLE_CELLS, ROW1_Y),
        ("run", RUNNING_CELLS, ROW1_Y),
        ("sprint", SPRINT_CELLS, ROW1_Y),
        ("jump", JUMP_CELLS, ROW2_Y),
        ("slide", SLIDE_CELLS, ROW2_Y),
        ("lane_left", LANE_LEFT_CELLS, ROW2_Y),
        ("lane_right", LANE_RIGHT_CELLS, ROW2_Y),
        ("dodge", DODGE_CELLS, ROW3_Y),
        ("catch", CATCH_CELLS, ROW3_Y),
        ("celebration", CELEBRATION_CELLS, ROW3_Y),
        ("stumble", STUMBLE_CELLS, ROW3_Y),
    ]

    manifest: list[str] = []
    for state, cells, (y0, y1) in groups:
        for i, (x0, x1) in enumerate(cells):
            img = extract_frame(sheet, x0, x1, y0, y1)
            out = os.path.join(OUT_DIR, f"{state}_{i}.png")
            img.save(out)
            manifest.append(f"{state}_{i}.png")
            print(f"  wrote {out}")

    print(f"\nTotal frames: {len(manifest)}")


if __name__ == "__main__":
    main()
