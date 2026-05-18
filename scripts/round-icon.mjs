import sharp from 'sharp';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SRC = path.join(projectRoot, 'build', 'icon.png');
const OUT_BUILD = path.join(projectRoot, 'build', 'icon.png');
const OUT_RENDERER = path.join(projectRoot, 'src', 'renderer', 'public', 'icon.png');

const SIZE = 1024;
const RADIUS = 224;

const maskSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
    <rect x="0" y="0" width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/>
  </svg>`
);

const srcBuf = await readFile(SRC);

const resized = await sharp(srcBuf)
  .resize(SIZE, SIZE, { fit: 'fill' })
  .ensureAlpha()
  .toBuffer();

const masked = await sharp(resized)
  .composite([{ input: maskSvg, blend: 'dest-in' }])
  .png()
  .toBuffer();

await writeFile(OUT_BUILD, masked);
await writeFile(OUT_RENDERER, masked);

const s1 = await stat(OUT_BUILD);
const s2 = await stat(OUT_RENDERER);
console.log(`build/icon.png size: ${s1.size} bytes`);
console.log(`src/renderer/public/icon.png size: ${s2.size} bytes`);
