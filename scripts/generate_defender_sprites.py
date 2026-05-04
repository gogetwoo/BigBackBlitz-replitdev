"""Generate top-view HBCU defender sprite PNGs for Big Back Blitz.

Produces, per variant:
  - idle_0.png            (1 frame)
  - run_0..run_7.png       (8 frame run cycle)
  - tackle_0..tackle_6.png (7 frame tackle sequence)

Sprites are 128x192 RGBA, centered pivot, helmet at top, legs at bottom.
This generator is a "designer pass" upgrade over the previous stand-in art:
proper top-view body proportions, shaded helmets with visible facemask
grids, shoulder pads with seams, school nameplate above the jersey number,
pant side stripes, two-tone socks, skin-tone forearms, and richer shading
to better match the HBCU reference sheets. The file layout is unchanged so
no game code changes are required.
"""
from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

CANVAS_W = 128
CANVAS_H = 192
OUT_ROOT = "artifacts/big-back-blitz/public/sprites/defender"

# Player's purple jersey/helmet for tackle ball carrier.
PLAYER_JERSEY = (75, 0, 130)
PLAYER_PANTS = (255, 215, 0)
PLAYER_HELMET = (60, 0, 100)
PLAYER_ACCENT = (255, 215, 0)
PLAYER_NUMBER = "82"
PLAYER_NAMEPLATE = "EAGLES"

SKIN = (138, 92, 64)
SKIN_SHADE = (96, 60, 40)
FACEMASK = (210, 210, 210)
FACEMASK_DARK = (120, 120, 120)

# (key, name, jersey, pants, helmet, accent, number, nameplate)
VARIANTS = [
    ("grambling",     "Grambling State",     (15, 15, 15),    (255, 184, 28),  (15, 15, 15),    (255, 184, 28),  "26", "TIGERS"),
    ("alcorn",        "Alcorn State",        (90, 15, 130),   (255, 200, 40),  (60, 5, 95),     (255, 215, 60),  "24", "BRAVES"),
    ("southern",      "Southern University", (40, 50, 130),   (255, 200, 40),  (40, 50, 130),   (255, 200, 40),  "20", "JAGUARS"),
    ("famu",          "Florida A&M",         (255, 100, 30),  (10, 80, 35),    (10, 80, 35),    (255, 200, 40),  "3",  "RATTLERS"),
    ("ncat",          "North Carolina A&T",  (20, 50, 110),   (255, 200, 40),  (20, 50, 110),   (255, 230, 70),  "25", "AGGIES"),
    ("morehouse",     "Morehouse",           (110, 20, 30),   (245, 245, 245), (110, 20, 30),   (255, 215, 0),   "22", "TIGERS"),
    ("hampton",       "Hampton",             (15, 35, 90),    (245, 245, 245), (15, 35, 90),    (245, 245, 245), "27", "PIRATES"),
    ("texassouthern", "Texas Southern",      (110, 20, 30),   (210, 210, 210), (110, 20, 30),   (255, 215, 0),   "23", "TIGERS"),
    ("prairieview",   "Prairie View A&M",    (95, 20, 130),   (255, 200, 40),  (95, 20, 130),   (255, 200, 40),  "21", "PANTHERS"),
    ("bethunecookman","Bethune-Cookman",     (130, 30, 35),   (255, 200, 40),  (130, 30, 35),   (255, 200, 40),  "29", "WILDCATS"),
]


def _font(size: int):
    for path in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/nix/store/.fonts/DejaVuSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _shade(rgb, amt):
    r, g, b = rgb[:3]
    if amt >= 0:
        f = amt
        return (int(r + (255 - r) * f), int(g + (255 - g) * f), int(b + (255 - b) * f))
    f = -amt
    return (int(r * (1 - f)), int(g * (1 - f)), int(b * (1 - f)))


def _rgba(rgb, a=255):
    return (rgb[0], rgb[1], rgb[2], a)


def _ellipse_aa(img, box, fill, outline=None, width=2):
    """Anti-aliased ellipse via 2x supersample."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    big = Image.new("RGBA", (w * 2, h * 2), (0, 0, 0, 0))
    bd = ImageDraw.Draw(big)
    bd.ellipse((0, 0, w * 2 - 1, h * 2 - 1), fill=fill,
               outline=outline, width=width * 2 if outline else 0)
    big = big.resize((w, h), Image.LANCZOS)
    img.alpha_composite(big, (x0, y0))


def _gradient_ellipse(img, box, base, light_amt=0.35, dark_amt=-0.30):
    """Top-lit ellipse: bright top-left, dark bottom-right. Approximated by
    stacking three nested ellipses with offsets."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    # Base
    _ellipse_aa(img, box, _rgba(base), outline=(0, 0, 0, 220), width=1)
    # Shadow (lower-right)
    sh = (x0 + int(w * 0.18), y0 + int(h * 0.22), x1, y1)
    _ellipse_aa(img, sh, _rgba(_shade(base, dark_amt), 180))
    # Highlight (upper-left)
    hl = (x0 + int(w * 0.12), y0 + int(h * 0.08),
          x0 + int(w * 0.62), y0 + int(h * 0.55))
    _ellipse_aa(img, hl, _rgba(_shade(base, light_amt), 200))


def draw_helmet(img, cx, cy, r, helmet, accent, scale=1.0):
    """Top-view football helmet: rounded oval with center stripe, facemask
    grid in front, specular highlight, drop shadow."""
    d = ImageDraw.Draw(img)
    # Drop shadow
    _ellipse_aa(img, (cx - r + 2, cy - r + 4, cx + r + 2, cy + r + 4),
                (0, 0, 0, 130))
    # Helmet shell with shading
    _gradient_ellipse(img, (cx - r, cy - r, cx + r, cy + r), helmet,
                      light_amt=0.50, dark_amt=-0.45)
    # Outline
    _ellipse_aa(img, (cx - r, cy - r, cx + r, cy + r),
                (0, 0, 0, 0), outline=(0, 0, 0, 230), width=1)
    # Center stripe (top to facemask)
    sw = max(2, int(r * 0.18))
    d.rectangle((cx - sw // 2, cy - r + 2, cx + sw // 2, cy + int(r * 0.55)),
                fill=_rgba(accent))
    # Stripe edge shadow
    d.line((cx - sw // 2, cy - r + 2, cx - sw // 2, cy + int(r * 0.55)),
           fill=(0, 0, 0, 120), width=1)
    # Facemask housing (lower front of helmet)
    fm_y0 = cy + int(r * 0.30)
    fm_y1 = cy + int(r * 0.95)
    fm_x0 = cx - int(r * 0.65)
    fm_x1 = cx + int(r * 0.65)
    # Chin guard plate
    _ellipse_aa(img, (fm_x0, fm_y0, fm_x1, fm_y1),
                _rgba(_shade(helmet, -0.55), 240))
    # Facemask bars (top view = horizontal bars stacked)
    for i, t in enumerate((0.28, 0.55, 0.82)):
        y = fm_y0 + int((fm_y1 - fm_y0) * t)
        d.line((fm_x0 + 3, y, fm_x1 - 3, y),
               fill=_rgba(FACEMASK if i != 1 else FACEMASK_DARK), width=2)
    # Vertical facemask post
    d.line((cx, fm_y0 + 2, cx, fm_y1 - 2), fill=_rgba(FACEMASK), width=1)
    # Specular highlight (top-left curve)
    hl = Image.new("RGBA", (r * 2, r * 2), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.ellipse((int(r * 0.18), int(r * 0.10),
                int(r * 0.95), int(r * 0.75)),
               fill=(255, 255, 255, 70))
    hl = hl.filter(ImageFilter.GaussianBlur(radius=2))
    img.alpha_composite(hl, (cx - r, cy - r))
    # Earhole shadow on each side
    for side in (-1, 1):
        ex = cx + side * int(r * 0.78)
        ey = cy + int(r * 0.15)
        _ellipse_aa(img, (ex - 3, ey - 5, ex + 3, ey + 5), (0, 0, 0, 200))


def draw_player(
    img: Image.Image,
    cx: int, cy: int,
    swing_phase: float,
    jersey, pants, helmet, accent, number, nameplate="",
    scale: float = 1.0,
    shadow: bool = True,
    pose: str = "run",
    flip: bool = False,
):
    """Top-view football player with shaded helmet, shoulder pads, jersey
    nameplate + number, pant stripes, two-tone socks, skin-tone forearms.
    """
    d = ImageDraw.Draw(img)

    s = scale
    body_w = int(58 * s)
    body_h = int(108 * s)

    if shadow:
        sh_w = int(body_w * 1.05)
        sh_h = int(body_h * 0.20)
        sh = Image.new("RGBA", (sh_w + 8, sh_h + 8), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.ellipse((2, 2, sh_w + 2, sh_h + 2), fill=(0, 0, 0, 130))
        sh = sh.filter(ImageFilter.GaussianBlur(radius=3))
        img.alpha_composite(sh, (cx - sh_w // 2 + 2, cy + body_h // 2 - sh_h + 4))

    if pose == "down":
        # Ball carrier flat on his back: wide flat torso, splayed limbs.
        torso_w = int(body_w * 1.20)
        torso_h = int(body_h * 0.55)

        # Splayed legs (knees-out)
        for side in (-1, 1):
            kx = cx + side * 14
            _ellipse_aa(img, (kx - 11, cy + 6, kx + 11, cy + 30),
                        _rgba(pants), outline=(0, 0, 0, 220), width=1)
            _ellipse_aa(img, (kx - 9, cy + 26, kx + 9, cy + 52),
                        _rgba(_shade(pants, -0.45)), outline=(0, 0, 0, 220), width=1)
            # Cleat
            _ellipse_aa(img, (kx - 8, cy + 46, kx + 8, cy + 56),
                        (20, 20, 20, 255), outline=(0, 0, 0, 230), width=1)
            # Pant side stripe
            d.line((kx + side * 9, cy + 8, kx + side * 9, cy + 28),
                   fill=_rgba(accent), width=2)

        # Splayed arms with skin forearms
        for side in (-1, 1):
            ax0 = cx + side * 24
            ax1 = cx + side * 46
            _ellipse_aa(img, (min(ax0, ax1) - 6, cy - 8,
                              max(ax0, ax1) + 6, cy + 8),
                        _rgba(jersey), outline=(0, 0, 0, 220), width=1)
            # Forearm (skin)
            fx = cx + side * 42
            _ellipse_aa(img, (fx - 7, cy - 4, fx + 7, cy + 8),
                        _rgba(SKIN), outline=(0, 0, 0, 200), width=1)
            # Glove
            gx = cx + side * 50
            _ellipse_aa(img, (gx - 5, cy - 2, gx + 5, cy + 8),
                        _rgba(_shade(jersey, -0.5)), outline=(0, 0, 0, 220), width=1)

        # Torso (jersey) — flat oval with shading
        _gradient_ellipse(img,
                          (cx - torso_w // 2, cy - torso_h // 2,
                           cx + torso_w // 2, cy + torso_h // 2),
                          jersey, light_amt=0.30, dark_amt=-0.30)

        # Nameplate
        if nameplate:
            nf = _font(8)
            tw = d.textlength(nameplate, font=nf)
            d.text((cx - tw / 2, cy - 18), nameplate,
                   fill=_rgba(accent), font=nf,
                   stroke_width=1, stroke_fill=(0, 0, 0, 220))
        # Number on chest
        f = _font(20)
        tw = d.textlength(number, font=f)
        d.text((cx - tw / 2, cy - 10), number,
               fill=_rgba(accent), font=f,
               stroke_width=1, stroke_fill=(0, 0, 0, 230))

        # Helmet at top — face-up so facemask visible
        hr = int(22 * s)
        hy = cy - int(body_h * 0.42)
        draw_helmet(img, cx, hy, hr, helmet, accent, scale=s)
        return

    # ── Upright stack ──
    leg_swing = math.sin(swing_phase * math.tau)
    arm_swing = math.sin(swing_phase * math.tau + math.pi)

    if pose == "idle":
        leg_swing *= 0.05
        arm_swing *= 0.10
    elif pose == "lunge":
        leg_swing = 0.9
        arm_swing = -0.9
    elif pose == "crouch":
        leg_swing *= 0.3
        arm_swing *= 0.3

    if flip:
        leg_swing = -leg_swing
        arm_swing = -arm_swing

    # ── Legs ──
    leg_top_y = cy + int(body_h * 0.10)
    leg_bot_y = cy + int(body_h * 0.50)
    leg_w = int(16 * s)
    sock_top = leg_top_y + int((leg_bot_y - leg_top_y) * 0.55)

    for side in (-1, 1):
        sw = leg_swing * side
        knee_x = cx + side * int(11 * s) + int(sw * 5 * s)
        foot_x = knee_x + int(sw * 8 * s)

        # Thigh (pants) with shading
        thigh_box = (knee_x - leg_w // 2 - 1, leg_top_y - 2,
                     knee_x + leg_w // 2 + 1, sock_top - 1)
        _ellipse_aa(img, thigh_box, _rgba(pants),
                    outline=(0, 0, 0, 220), width=1)
        # Pant inner shadow
        d.line((knee_x - side * (leg_w // 2 - 2), leg_top_y + 2,
                knee_x - side * (leg_w // 2 - 2), sock_top - 4),
               fill=_rgba(_shade(pants, -0.30)), width=2)
        # Pant side stripe (accent)
        d.line((knee_x + side * (leg_w // 2 - 1), leg_top_y + 4,
                knee_x + side * (leg_w // 2 - 1), sock_top - 4),
               fill=_rgba(accent), width=1)

        # Sock — two-tone (jersey color top, dark bottom)
        sock_box = (foot_x - leg_w // 2 + 1, sock_top - 4,
                    foot_x + leg_w // 2 - 1, leg_bot_y + 6)
        _ellipse_aa(img, sock_box, _rgba(jersey),
                    outline=(0, 0, 0, 220), width=1)
        # Stripe band
        sb_y = sock_top + 2
        d.rectangle((sock_box[0] + 1, sb_y, sock_box[2] - 1, sb_y + 2),
                    fill=_rgba(accent))
        # Cleat
        cleat_box = (foot_x - 9, leg_bot_y + 2, foot_x + 9, leg_bot_y + 14)
        _ellipse_aa(img, cleat_box, (20, 20, 20, 255),
                    outline=(0, 0, 0, 230), width=1)
        # Cleat highlight
        d.line((cleat_box[0] + 2, cleat_box[1] + 2,
                cleat_box[2] - 2, cleat_box[1] + 2),
               fill=(255, 255, 255, 90), width=1)

    # ── Belt ──
    belt = _shade(pants, -0.40)
    d.rectangle((cx - body_w // 2 + 6, leg_top_y - 5,
                 cx + body_w // 2 - 6, leg_top_y + 1),
                fill=_rgba(belt))
    d.line((cx - body_w // 2 + 6, leg_top_y - 5,
            cx + body_w // 2 - 6, leg_top_y - 5),
           fill=(0, 0, 0, 200), width=1)

    # ── Jersey / torso ──
    torso_w = int(body_w * 0.98)
    torso_h = int(body_h * 0.46)
    torso_y = cy - int(body_h * 0.10)
    _gradient_ellipse(img,
                      (cx - torso_w // 2, torso_y - torso_h // 2,
                       cx + torso_w // 2, torso_y + torso_h // 2),
                      jersey, light_amt=0.28, dark_amt=-0.28)

    # ── Nameplate (school name above number) ──
    if nameplate and pose != "down":
        nfs = max(7, int(8 * s))
        nf = _font(nfs)
        # Trim nameplate to fit
        plate = nameplate
        while d.textlength(plate, font=nf) > torso_w - 6 and len(plate) > 3:
            plate = plate[:-1]
        tw = d.textlength(plate, font=nf)
        d.text((cx - tw / 2, torso_y - int(torso_h * 0.32)),
               plate, fill=_rgba(accent), font=nf,
               stroke_width=1, stroke_fill=(0, 0, 0, 230))

    # ── Number ──
    fsize = int(20 * s)
    f = _font(fsize)
    tw = d.textlength(number, font=f)
    d.text((cx - tw / 2, torso_y - fsize // 2 + int(2 * s)),
           number, fill=_rgba(accent), font=f,
           stroke_width=1, stroke_fill=(0, 0, 0, 230))

    # ── Shoulder pads (two halves with center seam) ──
    pad_w = int(body_w * 1.10)
    pad_h = int(body_h * 0.22)
    pad_y = cy - int(body_h * 0.30)
    pad_color = _shade(jersey, 0.08)

    # Left pad
    _gradient_ellipse(img,
                      (cx - pad_w // 2, pad_y - pad_h // 2,
                       cx - 1, pad_y + pad_h // 2),
                      pad_color, light_amt=0.30, dark_amt=-0.25)
    # Right pad
    _gradient_ellipse(img,
                      (cx + 1, pad_y - pad_h // 2,
                       cx + pad_w // 2, pad_y + pad_h // 2),
                      pad_color, light_amt=0.30, dark_amt=-0.25)
    # Center seam (neck channel)
    d.rectangle((cx - 4, pad_y - pad_h // 2 + 2,
                 cx + 4, pad_y + pad_h // 2 - 2),
                fill=_rgba(_shade(jersey, -0.55)))
    # Accent stripe across pads
    d.rectangle((cx - pad_w // 2 + 3, pad_y - 1,
                 cx + pad_w // 2 - 3, pad_y + 2),
                fill=_rgba(accent))

    # ── Arms (jersey sleeve + skin forearm + glove) ──
    for side in (-1, 1):
        sw = arm_swing * side
        sx = cx + side * int(body_w * 0.48)
        sy = pad_y + int(3 * s)
        ex = sx + side * int(8 * s) + int(sw * 6 * s)
        ey = sy + int(16 * s) + int(abs(sw) * 4 * s)
        # Sleeve (jersey)
        d.line((sx, sy, ex, ey), fill=_rgba(jersey), width=int(9 * s))
        # Sleeve cuff stripe
        d.line((ex - 2, ey - 1, ex + 2, ey + 1),
               fill=_rgba(accent), width=2)
        # Forearm (skin)
        fx = ex + side * int(2 * s) + int(sw * 3 * s)
        fy = ey + int(8 * s)
        d.line((ex, ey, fx, fy), fill=_rgba(SKIN), width=int(7 * s))
        # Glove
        _ellipse_aa(img, (fx - 5, fy - 4, fx + 5, fy + 6),
                    _rgba(_shade(jersey, -0.55)),
                    outline=(0, 0, 0, 230), width=1)
        # Glove highlight
        d.point((fx - 1, fy - 1), fill=(255, 255, 255, 160))

    # ── Helmet ──
    helm_r = int(24 * s)
    helm_y = cy - int(body_h * 0.46)
    draw_helmet(img, cx, helm_y, helm_r, helmet, accent, scale=s)


def draw_tackle_frame(img: Image.Image, frame: int,
                      jersey, pants, helmet, accent, number, nameplate):
    cx, cy = CANVAS_W // 2, CANVAS_H // 2

    if frame == 0:
        draw_player(img, cx, cy, 0.0, jersey, pants, helmet, accent, number,
                    nameplate, scale=1.0, pose="run")
    elif frame == 1:
        draw_player(img, cx, cy + 6, 0.25, jersey, pants, helmet, accent, number,
                    nameplate, scale=1.05, pose="lunge")
    elif frame == 2:
        draw_player(img, cx + 4, cy + 22, 0.5, PLAYER_JERSEY, PLAYER_PANTS,
                    PLAYER_HELMET, PLAYER_ACCENT, PLAYER_NUMBER, PLAYER_NAMEPLATE,
                    scale=0.85, pose="crouch", flip=True, shadow=False)
        draw_player(img, cx, cy - 4, 0.5, jersey, pants, helmet, accent, number,
                    nameplate, scale=1.0, pose="lunge")
    elif frame == 3:
        draw_player(img, cx + 2, cy + 18, 0.0, PLAYER_JERSEY, PLAYER_PANTS,
                    PLAYER_HELMET, PLAYER_ACCENT, PLAYER_NUMBER, PLAYER_NAMEPLATE,
                    scale=0.9, pose="down", shadow=False)
        draw_player(img, cx - 4, cy - 6, 0.5, jersey, pants, helmet, accent, number,
                    nameplate, scale=0.95, pose="crouch")
    elif frame == 4:
        draw_player(img, cx, cy + 14, 0.0, PLAYER_JERSEY, PLAYER_PANTS,
                    PLAYER_HELMET, PLAYER_ACCENT, PLAYER_NUMBER, PLAYER_NAMEPLATE,
                    scale=0.95, pose="down", shadow=False)
        draw_player(img, cx + 2, cy - 8, 0.75, jersey, pants, helmet, accent, number,
                    nameplate, scale=1.0, pose="lunge")
    elif frame == 5:
        draw_player(img, cx - 6, cy + 12, 0.0, PLAYER_JERSEY, PLAYER_PANTS,
                    PLAYER_HELMET, PLAYER_ACCENT, PLAYER_NUMBER, PLAYER_NAMEPLATE,
                    scale=1.0, pose="down", shadow=False)
        draw_player(img, cx + 8, cy - 10, 0.0, jersey, pants, helmet, accent, number,
                    nameplate, scale=0.9, pose="crouch")
    else:
        draw_player(img, cx - 10, cy + 16, 0.0, PLAYER_JERSEY, PLAYER_PANTS,
                    PLAYER_HELMET, PLAYER_ACCENT, PLAYER_NUMBER, PLAYER_NAMEPLATE,
                    scale=0.95, pose="down", shadow=False)
        draw_player(img, cx + 14, cy - 4, 0.0, jersey, pants, helmet, accent, number,
                    nameplate, scale=1.0, pose="idle")


def make_canvas() -> Image.Image:
    return Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 0))


def save(img: Image.Image, variant: str, name: str) -> None:
    out_dir = os.path.join(OUT_ROOT, variant)
    os.makedirs(out_dir, exist_ok=True)
    img.save(os.path.join(out_dir, f"{name}.png"))


def main() -> None:
    cx, cy = CANVAS_W // 2, CANVAS_H // 2
    for key, _name, jersey, pants, helmet, accent, number, nameplate in VARIANTS:
        img = make_canvas()
        draw_player(img, cx, cy, 0.0, jersey, pants, helmet, accent, number,
                    nameplate, scale=1.0, pose="idle")
        save(img, key, "idle_0")

        for i in range(8):
            img = make_canvas()
            phase = i / 8.0
            draw_player(img, cx, cy, phase, jersey, pants, helmet, accent, number,
                        nameplate, scale=1.0, pose="run")
            save(img, key, f"run_{i}")

        for i in range(7):
            img = make_canvas()
            draw_tackle_frame(img, i, jersey, pants, helmet, accent, number, nameplate)
            save(img, key, f"tackle_{i}")

        print(f"  generated {key}")


if __name__ == "__main__":
    main()
