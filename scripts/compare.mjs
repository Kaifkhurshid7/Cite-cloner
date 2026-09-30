// node scripts/compare.mjs <workspace-id> <out.jpg> [mobile] – side-by-side original vs generated
import sharp from 'sharp';
const [id, out, mobile] = process.argv.slice(2);
const dir = `workspaces/${id}/.capture/`;
const kind = mobile ? 'mobile' : 'desktop';
const W = mobile ? 390 : 700;
const a = await sharp(dir + `original-${kind}.jpg`).resize({ width: W }).toBuffer();
const b = await sharp(dir + `generated-${kind}.jpg`).resize({ width: W }).toBuffer();
const [ma, mb] = [await sharp(a).metadata(), await sharp(b).metadata()];
await sharp({ create: { width: W * 2 + 20, height: Math.max(ma.height, mb.height), channels: 3, background: '#888' } })
  .composite([{ input: a, left: 0, top: 0 }, { input: b, left: W + 20, top: 0 }]).jpeg().toFile(out);
