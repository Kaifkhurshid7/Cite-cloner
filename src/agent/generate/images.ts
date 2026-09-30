import sharp from 'sharp';
import type { ContentPart } from '../llm/types.js';

/**
 * Prepare a screenshot for a vision model: downscale + JPEG. Smaller images = fewer input tokens
 * (Claude bills ≈ w*h/750 tokens per image), so we send only the resolution the task needs.
 */
export async function imagePart(file: string, opts: { width: number; maxHeight?: number }): Promise<ContentPart> {
  const meta = await sharp(file).metadata();
  const w = Math.round(Math.min(opts.width, meta.width ?? opts.width));
  const resized = await sharp(file).resize({ width: w }).toBuffer();
  const h = (await sharp(resized).metadata()).height ?? 0;
  let img = sharp(resized);
  if (opts.maxHeight && h > opts.maxHeight) img = img.extract({ left: 0, top: 0, width: w, height: opts.maxHeight });
  const buf = await img.jpeg({ quality: 72 }).toBuffer();
  return { type: 'image', data: buf.toString('base64'), mediaType: 'image/jpeg' };
}

/** Split a tall full-page screenshot into readable tiles (APIs downscale very tall images to a sliver). */
export async function imageTiles(file: string, opts: { width: number; tileHeight: number; maxTiles: number }): Promise<ContentPart[]> {
  const meta = await sharp(file).metadata();
  const scale = Math.min(1, opts.width / (meta.width ?? opts.width));
  const w = Math.round((meta.width ?? opts.width) * scale);
  const resized = await sharp(file).resize({ width: w }).toBuffer();
  const total = (await sharp(resized).metadata()).height ?? 0;
  const tiles: ContentPart[] = [];
  for (let top = 0; top < total && tiles.length < opts.maxTiles; top += opts.tileHeight) {
    const height = Math.min(opts.tileHeight, total - top);
    if (height < 40) break;
    const buf = await sharp(resized).extract({ left: 0, top, width: w, height }).jpeg({ quality: 70 }).toBuffer();
    tiles.push({ type: 'image', data: buf.toString('base64'), mediaType: 'image/jpeg' });
  }
  return tiles;
}
