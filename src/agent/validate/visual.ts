import fs from 'node:fs/promises';
import sharp from 'sharp';

/**
 * Perceptual-ish similarity between two screenshots in [0,1].
 * Both images are downscaled + blurred (so 1-2px offsets and anti-aliasing do not matter), the candidate is
 * resized onto the reference's grid, then we take 1 - mean absolute RGB difference.
 * Needs no model call and is accurate enough to rank sections for the refinement loop and to report progress.
 */
export async function similarity(referenceFile: string, candidateFile: string, width = 160): Promise<number> {
  try {
    await Promise.all([fs.access(referenceFile), fs.access(candidateFile)]);
  } catch {
    return 0;
  }
  const ref = sharp(referenceFile).resize({ width }).blur(1.2).removeAlpha();
  const { data: a, info } = await ref.raw().toBuffer({ resolveWithObject: true });
  const { data: b } = await sharp(candidateFile)
    .resize({ width: info.width, height: info.height, fit: 'fill' })
    .blur(1.2)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let diff = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) diff += Math.abs(a[i] - b[i]);
  const mean = diff / len / 255;
  // mean abs diff between unrelated web pages is typically ~0.25–0.4, so stretch the scale for readability
  return Math.max(0, Math.min(1, 1 - mean * 2));
}
