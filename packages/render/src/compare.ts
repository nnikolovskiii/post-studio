// Pixel comparison, same method as job 239 (LUX-6 Figma pack): mean channel error over RGB
// (0–1, i.e. mean |a−b| / 255) and the share of pixels whose largest channel error exceeds 16.
import sharp from "sharp";

export interface PixelDiff {
  width: number;
  height: number;
  /** mean |a − b| / 255 over all RGB channels. */
  meanChannelError: number;
  /** Largest single channel difference (0–255). */
  maxChannelError: number;
  /** Pixels where some channel differs by more than `threshold`. */
  pixelsOver: number;
  pixelsOverFraction: number;
  threshold: number;
  /**
   * The same count after a 1 px Gaussian blur of both images. Edge anti-aliasing and text gamma
   * (Chrome renders glyph edges darker than a plain path fill) mostly vanish; content that moved
   * by a pixel or more, or is missing, still shows. This is the "no layout drift" number.
   */
  blurredPixelsOver: number;
  blurredPixelsOverFraction: number;
  /**
   * Pixels (in either image) with no pixel within `radius` px in the other image that is within
   * `threshold`. Anti-aliasing, hinting and 1 px rounding drop out; anything moved further,
   * recoloured, missing or extra still counts. The larger of the two directions.
   */
  shiftTolerantPixelsOver: number;
  shiftTolerantPixelsOverFraction: number;
  radius: number;
}

async function rgb(input: Buffer | string, blur?: number): Promise<{ data: Buffer; width: number; height: number }> {
  let img = sharp(input).flatten({ background: "#ffffff" }).removeAlpha();
  if (blur) img = sharp(await img.png().toBuffer()).blur(blur);
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function unmatched(A: Buffer, B: Buffer, w: number, h: number, threshold: number, r: number): number {
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      let ok = false;
      for (let dy = -r; dy <= r && !ok; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = (yy * w + xx) * 3;
          if (Math.abs(A[i] - B[j]) <= threshold && Math.abs(A[i + 1] - B[j + 1]) <= threshold && Math.abs(A[i + 2] - B[j + 2]) <= threshold) {
            ok = true;
            break;
          }
        }
      }
      if (!ok) count++;
    }
  }
  return count;
}

export async function comparePng(a: Buffer | string, b: Buffer | string, threshold = 16, radius = 1): Promise<PixelDiff> {
  const [A, B] = await Promise.all([rgb(a), rgb(b)]);
  if (A.width !== B.width || A.height !== B.height) throw new Error(`size differs: ${A.width}×${A.height} vs ${B.width}×${B.height}`);
  let sum = 0;
  let max = 0;
  let over = 0;
  for (let i = 0; i < A.data.length; i += 3) {
    let px = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.data[i + c] - B.data[i + c]);
      sum += d;
      if (d > px) px = d;
    }
    if (px > max) max = px;
    if (px > threshold) over++;
  }
  const pixels = A.width * A.height;
  let blurred = 0;
  if (over) {
    const [a1, b1] = await Promise.all([rgb(a, 1), rgb(b, 1)]);
    for (let i = 0; i < a1.data.length; i += 3) {
      if (Math.abs(a1.data[i] - b1.data[i]) > threshold || Math.abs(a1.data[i + 1] - b1.data[i + 1]) > threshold || Math.abs(a1.data[i + 2] - b1.data[i + 2]) > threshold) blurred++;
    }
  }
  const shifted = over ? Math.max(unmatched(A.data, B.data, A.width, A.height, threshold, radius), unmatched(B.data, A.data, A.width, A.height, threshold, radius)) : 0;
  return {
    width: A.width,
    height: A.height,
    meanChannelError: sum / (pixels * 3 * 255),
    maxChannelError: max,
    pixelsOver: over,
    pixelsOverFraction: over / pixels,
    threshold,
    blurredPixelsOver: blurred,
    blurredPixelsOverFraction: blurred / pixels,
    shiftTolerantPixelsOver: shifted,
    shiftTolerantPixelsOverFraction: shifted / pixels,
    radius,
  };
}

/** Visual diff: grey copy of `a` with differing pixels in red (for reports). */
export async function diffImage(a: Buffer | string, b: Buffer | string, threshold = 16): Promise<Buffer> {
  const [A, B] = await Promise.all([rgb(a), rgb(b)]);
  const out = Buffer.alloc(A.data.length);
  for (let i = 0; i < A.data.length; i += 3) {
    const d = Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
    if (d > threshold) out.set([255, 0, 0], i);
    else {
      const g = Math.round(0.3 * A.data[i] + 0.59 * A.data[i + 1] + 0.11 * A.data[i + 2]);
      const v = 255 - Math.round((255 - g) * 0.35);
      out.set([v, v, v], i);
    }
  }
  return sharp(out, { raw: { width: A.width, height: A.height, channels: 3 } }).png().toBuffer();
}

/** Raw RGB (3 bytes per pixel) → PNG, e.g. a decoded video frame for comparePng. */
export function rgbToPng(raw: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
