#!/usr/bin/env bash
# Stamp a fixed, school-specific jersey number onto every defender frame.
#
# The sprites originally rendered with random per-frame chest numbers, so
# the same school's player flickered through different numbers across
# idle/run/tackle. This script:
#   1. Paints a small jersey-color ellipse over the chest to fully mask
#      whatever digits were originally rendered there.
#   2. Stamps a single, school-appropriate number on top in the team's
#      accent color, so every variant has one consistent identity across
#      all 16 frames.
#
# Notes
# - Sprites are 128x192 with the player roughly centered. Per-frame chest
#   coordinates were tuned by eye against the existing renders.
# - Re-running this script is idempotent: the ellipse mask wipes any prior
#   stamp before the new one is drawn.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPR="$ROOT/public/sprites/defender"

# variant:number:patch:fill:stroke
#   patch  = jersey base color used to mask the original chest digits
#   fill   = digit fill color
#   stroke = digit outline color
VARIANTS=(
  "grambling:26:#0E0E0E:#FFD400:#000000"
  "alcorn:24:#301E5C:#D4A017:#1A0F33"
  "southern:20:#1B3F7A:#FFC72C:#0A2B5C"
  "famu:7:#E85D04:#1B5E20:#FFFFFF"
  "ncat:32:#162447:#FFC72C:#0A1F44"
  "morehouse:11:#5A0F1F:#FFFFFF:#3B0A14"
  "hampton:5:#0E1A3D:#FFFFFF:#0A2B5C"
  "texassouthern:14:#4A1E80:#FFFFFF:#2A0F4A"
  "prairieview:9:#2A0A4A:#FFC72C:#1A0530"
  "bethunecookman:33:#7A1A1A:#FFC72C:#5A0F1F"
)

# Per-frame chest centre (cx, cy) for a 128x192 sprite. The replacement
# number is centered on this point and the masking ellipse is drawn here.
declare -A CENTER=(
  [idle_0]="62,58"
  [run_0]="60,61"
  [run_1]="61,61"
  [run_2]="62,59"
  [run_3]="58,62"
  [run_4]="62,61"
  [run_5]="68,58"
  [run_6]="62,61"
  [run_7]="60,63"
  [tackle_0]="62,64"
  [tackle_1]="62,63"
  [tackle_2]="62,63"
  [tackle_3]="60,77"
  [tackle_4]="62,67"
  [tackle_5]="62,69"
  [tackle_6]="58,81"
)

POINTSIZE=17
ELLIPSE_RX=15
ELLIPSE_RY=11

for entry in "${VARIANTS[@]}"; do
  IFS=':' read -r variant number patch fill stroke_color <<<"$entry"
  dir="$SPR/$variant"
  if [[ ! -d "$dir" ]]; then
    echo "skip missing $dir" >&2
    continue
  fi

  # Single-digit numbers render narrower; nudge the text right so it sits
  # centered inside the masking ellipse.
  if (( ${#number} == 1 )); then
    text_xoff=4   # half a glyph width
  else
    text_xoff=9   # full glyph width
  fi
  text_yoff=9     # roughly half cap-height for pointsize 17

  for frame in "${!CENTER[@]}"; do
    IFS=',' read -r cx cy <<<"${CENTER[$frame]}"
    file="$dir/${frame}.png"
    if [[ ! -f "$file" ]]; then
      echo "skip missing $file" >&2
      continue
    fi
    tx=$((cx - text_xoff))
    ty=$((cy - text_yoff))
    convert "$file" \
      -fill "$patch" -stroke none \
      -draw "ellipse $cx,$cy $ELLIPSE_RX,$ELLIPSE_RY 0,360" \
      -font DejaVu-Sans-Bold -pointsize "$POINTSIZE" -gravity NorthWest \
      -fill "$fill" -stroke "$stroke_color" -strokewidth 2 \
      -annotate "+$tx+$ty" "$number" \
      -stroke none -fill "$fill" \
      -annotate "+$tx+$ty" "$number" \
      "$file" 2>/dev/null
  done
  echo "stamped $variant #$number"
done
