import sharp from "sharp";
import path from "path";
import fs from "fs";

const POSTER = path.resolve(
  "../attached_assets/ChatGPT_Image_May_2,_2026,_10_30_57_PM_1777779387348.png",
);
const OUT_DIR = path.resolve("../artifacts/big-back-blitz/public/sprites/helmets");

// Grid layout for the poster (1314x1197).
// 6 columns, 5 rows. Header (title + subtitle) at top, footer at bottom.
// Determined empirically from the source image.
const GRID_LEFT = 0;
const GRID_RIGHT = 1314;
const COLS = 6;
const CELL_W = (GRID_RIGHT - GRID_LEFT) / COLS;
// Y-bands per row determined empirically from horizontal divider lines in
// the poster (gold dividers detected at y=354/569/784/989, plus header/footer).
// [helmetTopY, helmetBottomY] for each row — chosen tightly around the helmet
// graphic, well above the row's label text and below the previous row's label.
const ROW_BANDS: Array<[number, number]> = [
  [148, 290], // row 0
  [360, 502],
  [575, 717],
  [790, 932],
  [995, 1137],
];

// Map of helmet name -> grid cell (row, col), 0-indexed.
// null means not exported (we don't have these in our directory).
const HELMETS: Array<{ name: string; row: number; col: number } | null> = [
  { name: "bethune-cookman", row: 0, col: 0 },
  { name: "howard", row: 0, col: 1 },
  { name: "tuskegee", row: 0, col: 2 },
  { name: "alcorn", row: 0, col: 3 },
  { name: "alabama-state", row: 0, col: 4 },
  { name: "alabama-amm", row: 0, col: 5 },

  null, // auburn (row 1, col 0) - skip
  { name: "grambling", row: 1, col: 1 },
  { name: "famu", row: 1, col: 2 },
  { name: "south-carolina-state", row: 1, col: 3 },
  { name: "jackson-state", row: 1, col: 4 },
  { name: "langston", row: 1, col: 5 },

  { name: "southern", row: 2, col: 0 },
  { name: "prairie-view", row: 2, col: 1 },
  { name: "texas-southern", row: 2, col: 2 },
  null, // southern-u (band) - skip
  { name: "mississippi-valley-state", row: 2, col: 4 },
  { name: "maryland-eastern-shore", row: 2, col: 5 },

  { name: "winston-salem-state", row: 3, col: 0 },
  null, // benedict-college - skip
  null, // citadel - skip
  { name: "ncat", row: 3, col: 3 },
  { name: "hampton", row: 3, col: 4 },
  { name: "shaw", row: 3, col: 5 },

  { name: "delaware-state", row: 4, col: 0 },
  { name: "lincoln-pa", row: 4, col: 1 },
  { name: "uapb", row: 4, col: 2 },
  { name: "miles", row: 4, col: 3 },
  { name: "ecsu", row: 4, col: 4 },
  { name: "virginia-state", row: 4, col: 5 },
];

type RGBA = { r: number; g: number; b: number; a: number };

function lum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Process a single helmet cell:
 *  1. Crop helmet portion of the cell from the poster.
 *  2. Find tight bounding box of non-background pixels.
 *  3. Re-crop to bounding box + small padding.
 *  4. Background removal:
 *     - Flood-fill from cell edges with luminance threshold to mark exterior
 *       transparent pixels.
 *     - Apply soft alpha feathering on the boundary so darker helmets keep
 *       their full color but lose the dark halo.
 */
async function processHelmet(
  posterRaw: Buffer,
  posterW: number,
  posterH: number,
  channels: number,
  cell: { name: string; row: number; col: number },
): Promise<void> {
  const cellX = Math.round(GRID_LEFT + cell.col * CELL_W);
  const [bandTop, bandBottom] = ROW_BANDS[cell.row];
  const x0 = cellX + 4;
  const y0 = bandTop;
  const x1 = cellX + Math.round(CELL_W) - 4;
  const y1 = bandBottom;
  const cw = x1 - x0;
  const ch = y1 - y0;

  // Build RGBA buffer for this cell.
  const cellBuf = new Uint8ClampedArray(cw * ch * 4);
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const sIdx = ((y0 + py) * posterW + (x0 + px)) * channels;
      const dIdx = (py * cw + px) * 4;
      cellBuf[dIdx] = posterRaw[sIdx];
      cellBuf[dIdx + 1] = posterRaw[sIdx + 1];
      cellBuf[dIdx + 2] = posterRaw[sIdx + 2];
      cellBuf[dIdx + 3] = 255;
    }
  }

  // Flood fill from all edges. Mark background pixels.
  // Background = pixels within luminance threshold of pure black AND reachable
  // from cell edge through other near-black pixels.
  const BG_LUM = 32; // pixels with luminance below this can be background
  const isBg = new Uint8Array(cw * ch);
  const stack: number[] = [];
  const pushIfBg = (px: number, py: number) => {
    if (px < 0 || py < 0 || px >= cw || py >= ch) return;
    const idx = py * cw + px;
    if (isBg[idx]) return;
    const b = idx * 4;
    if (lum(cellBuf[b], cellBuf[b + 1], cellBuf[b + 2]) <= BG_LUM) {
      isBg[idx] = 1;
      stack.push(idx);
    }
  };
  for (let px = 0; px < cw; px++) {
    pushIfBg(px, 0);
    pushIfBg(px, ch - 1);
  }
  for (let py = 0; py < ch; py++) {
    pushIfBg(0, py);
    pushIfBg(cw - 1, py);
  }
  while (stack.length) {
    const idx = stack.pop()!;
    const px = idx % cw;
    const py = (idx - px) / cw;
    pushIfBg(px - 1, py);
    pushIfBg(px + 1, py);
    pushIfBg(px, py - 1);
    pushIfBg(px, py + 1);
  }

  // Compute alpha: 0 for flood-filled bg, 255 for non-bg. Then feather edges
  // so we don't get a sharp transition. We compute, for each non-bg pixel, the
  // distance (in pixels) to the nearest bg pixel and apply a small alpha ramp.
  // For darker helmets this also reduces dark halos because the boundary
  // pixel's dark color will fade with alpha rather than producing a fringe.
  const FEATHER = 1.5; // pixel ramp width
  const distToBg = new Float32Array(cw * ch);
  // 8-connected chamfer-ish distance via two passes.
  const INF = 1e9;
  for (let i = 0; i < cw * ch; i++) distToBg[i] = isBg[i] ? 0 : INF;
  // forward pass
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const i = py * cw + px;
      if (distToBg[i] === 0) continue;
      let d = distToBg[i];
      if (px > 0) d = Math.min(d, distToBg[i - 1] + 1);
      if (py > 0) d = Math.min(d, distToBg[i - cw] + 1);
      if (px > 0 && py > 0) d = Math.min(d, distToBg[i - cw - 1] + 1.4142);
      if (px < cw - 1 && py > 0) d = Math.min(d, distToBg[i - cw + 1] + 1.4142);
      distToBg[i] = d;
    }
  }
  // backward pass
  for (let py = ch - 1; py >= 0; py--) {
    for (let px = cw - 1; px >= 0; px--) {
      const i = py * cw + px;
      if (distToBg[i] === 0) continue;
      let d = distToBg[i];
      if (px < cw - 1) d = Math.min(d, distToBg[i + 1] + 1);
      if (py < ch - 1) d = Math.min(d, distToBg[i + cw] + 1);
      if (px < cw - 1 && py < ch - 1)
        d = Math.min(d, distToBg[i + cw + 1] + 1.4142);
      if (px > 0 && py < ch - 1) d = Math.min(d, distToBg[i + cw - 1] + 1.4142);
      distToBg[i] = d;
    }
  }

  // Apply alpha + edge "darkness suppression": for boundary pixels (small
  // distance to bg), if the pixel is itself dark, multiply alpha by how much
  // it differs from background luminance. This eats the dark halo without
  // touching well-saturated/light helmet pixels.
  for (let i = 0; i < cw * ch; i++) {
    const b = i * 4;
    if (isBg[i]) {
      cellBuf[b + 3] = 0;
      continue;
    }
    const d = distToBg[i];
    let alpha = 255;
    if (d < FEATHER) {
      alpha = Math.round((d / FEATHER) * 255);
    }
    // halo suppression for the very first ring of pixels next to bg
    if (d < 1.5) {
      const L = lum(cellBuf[b], cellBuf[b + 1], cellBuf[b + 2]);
      if (L < 60) {
        // scale alpha by how non-black this pixel is, relative to a soft floor
        const factor = Math.min(1, Math.max(0, (L - 20) / 40));
        alpha = Math.round(alpha * factor);
      }
    }
    cellBuf[b + 3] = alpha;
  }

  // Find tight bounding box of non-transparent pixels.
  let minX = cw,
    minY = ch,
    maxX = -1,
    maxY = -1;
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const a = cellBuf[(py * cw + px) * 4 + 3];
      if (a > 8) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
  }
  if (maxX < 0) {
    console.warn(`No helmet pixels found for ${cell.name}`);
    return;
  }
  const PAD = 3;
  minX = Math.max(0, minX - PAD);
  minY = Math.max(0, minY - PAD);
  maxX = Math.min(cw - 1, maxX + PAD);
  maxY = Math.min(ch - 1, maxY + PAD);
  const ow = maxX - minX + 1;
  const oh = maxY - minY + 1;
  const out = Buffer.alloc(ow * oh * 4);
  for (let py = 0; py < oh; py++) {
    for (let px = 0; px < ow; px++) {
      const sIdx = ((minY + py) * cw + (minX + px)) * 4;
      const dIdx = (py * ow + px) * 4;
      out[dIdx] = cellBuf[sIdx];
      out[dIdx + 1] = cellBuf[sIdx + 1];
      out[dIdx + 2] = cellBuf[sIdx + 2];
      out[dIdx + 3] = cellBuf[sIdx + 3];
    }
  }

  const outPath = path.join(OUT_DIR, `${cell.name}.png`);
  await sharp(out, {
    raw: { width: ow, height: oh, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`wrote ${cell.name}.png  ${ow}x${oh}`);
}

async function main() {
  if (!fs.existsSync(POSTER)) {
    throw new Error(`poster not found at ${POSTER}`);
  }
  const img = sharp(POSTER);
  const meta = await img.metadata();
  const channels = meta.channels ?? 3;
  const { data, info } = await img
    .raw()
    .toBuffer({ resolveWithObject: true });
  const posterW = info.width;
  const posterH = info.height;
  console.log(
    `loaded poster ${posterW}x${posterH} channels=${info.channels}`,
  );

  for (const cell of HELMETS) {
    if (!cell) continue;
    await processHelmet(data, posterW, posterH, info.channels, cell);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
