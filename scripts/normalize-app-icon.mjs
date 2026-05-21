#!/usr/bin/env node
/**
 * scripts/normalize-app-icon.mjs
 *
 * 把 build/icon.png 标准化成"和系统其它 app 视觉密度一致"的应用图标,
 * 并派生出三大平台需要的资源:
 *
 *   - macOS  → build/icon.icns        (iconutil + iconset 多档位)
 *   - Win    → build/icon.ico         (sharp 多分辨率 PNG → ico)
 *   - Linux  → build/icons/*.png      (16/32/48/64/128/256/512/1024)
 *
 * macOS 视觉规范(Apple HIG / Big Sur+):
 *   - 1024×1024 画布
 *   - 内容 safe area = 824×824(占画布 80.4%,即每边 100px 透明 padding)
 *   - squircle 圆角(macOS Big Sur 起的"超椭圆"风格,圆角半径 ≈ 185px)
 *   - 纯白 / 浅色背景的图标也要在 safe area 内绘制,不能铺满画布
 *
 * 之所以 dock 上别的 app 看起来更小:它们都遵循 824×824 safe area;
 * 我们之前的 icon.png 是直接 1024×1024 全铺,所以视觉上比邻居"大一圈"。
 *
 * 执行流程:
 *   1. 读 build/icon.png(原始 1024×1024)
 *   2. resize 到 824×824(等比缩放,内容仍居中)
 *   3. 套 squircle mask(SVG path 切角)
 *   4. 在 1024×1024 透明画布上居中合成 → 写回 build/icon.png
 *   5. 派生 .icns / .ico / build/icons/*.png
 *
 * 用法:
 *   node scripts/normalize-app-icon.mjs               # 在原图基础上 normalize + 派生
 *   node scripts/normalize-app-icon.mjs --skip-norm   # 跳过 normalize,只重派生(用于已经手工调整过的 icon.png)
 *
 * 依赖:复用项目已有的 sharp(0.33+),iconutil 是 macOS 自带工具。
 * 在非 macOS 上只产出 .ico + build/icons/,跳过 .icns。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SRC = path.join(projectRoot, 'build/icon.png');
const ICONS_DIR = path.join(projectRoot, 'build/icons');
const ICNS_OUT = path.join(projectRoot, 'build/icon.icns');
const ICO_OUT = path.join(projectRoot, 'build/icon.ico');

/** Apple HIG-derived constants. 1024 / 824 ≈ 80.4 % → 12 % padding each side. */
const CANVAS = 1024;
const SAFE = 824;
/** macOS Big Sur+ squircle: corner radius ≈ 185 px on a 1024 canvas. */
const RADIUS = 185;

/** Standard PNG sizes electron-builder consumes for Linux + Windows. */
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

function squircleMaskSvg(size) {
  // We mask the SAFE-area image (824 px). The radius scales proportionally:
  //   rExpected / SAFE = RADIUS / CANVAS  →  rExpected = RADIUS * SAFE / CANVAS
  const r = Math.round((RADIUS * size) / CANVAS);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>` +
    `</svg>`,
  );
}

async function normalize() {
  if (!existsSync(SRC)) throw new Error(`missing ${SRC}`);
  const meta = await sharp(SRC).metadata();
  console.log(`▶ source: ${SRC}  ${meta.width}×${meta.height}  ${meta.format}`);

  // 1) Shrink content into 824×824 safe area.
  const inner = await sharp(SRC)
    .resize(SAFE, SAFE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // 2) Apply squircle mask on the 824 inner image.
  const masked = await sharp(inner)
    .composite([{ input: squircleMaskSvg(SAFE), blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 3) Compose onto a 1024×1024 transparent canvas, centred.
  const offset = Math.round((CANVAS - SAFE) / 2);
  const final = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: masked, top: offset, left: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  writeFileSync(SRC, final);
  console.log(`  ✓ normalized → ${SRC}  (${SAFE}×${SAFE} safe area + squircle in 1024 canvas)`);
}

async function emitPngs() {
  if (!existsSync(ICONS_DIR)) mkdirSync(ICONS_DIR, { recursive: true });
  for (const s of PNG_SIZES) {
    const out = path.join(ICONS_DIR, `${s}x${s}.png`);
    await sharp(SRC).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
  }
  console.log(`  ✓ emitted PNGs → ${ICONS_DIR}/{${PNG_SIZES.join(',')}}.png`);
}

async function emitIco() {
  // electron-builder's ico is a multi-resolution container. sharp can't
  // write .ico directly, so we hand-build it from PNG buffers.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = await Promise.all(sizes.map((s) =>
    sharp(SRC).resize(s, s, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer().then((data) => ({ s, data })),
  ));
  // ICONDIR header (6 bytes) + ICONDIRENTRY (16 bytes × n)
  const headerSize = 6 + 16 * pngs.length;
  let offset = headerSize;
  const entries = [];
  for (const { s, data } of pngs) {
    entries.push({ s, data, offset, length: data.length });
    offset += data.length;
  }
  const totalSize = headerSize + pngs.reduce((sum, p) => sum + p.data.length, 0);
  const buf = Buffer.alloc(totalSize);
  buf.writeUInt16LE(0, 0);            // reserved
  buf.writeUInt16LE(1, 2);            // type 1 = ICO
  buf.writeUInt16LE(pngs.length, 4);  // image count
  let pos = 6;
  for (const { s, length, offset: o } of entries) {
    buf.writeUInt8(s === 256 ? 0 : s, pos);          // width (0 means 256)
    buf.writeUInt8(s === 256 ? 0 : s, pos + 1);      // height
    buf.writeUInt8(0, pos + 2);                      // palette
    buf.writeUInt8(0, pos + 3);                      // reserved
    buf.writeUInt16LE(1, pos + 4);                   // planes
    buf.writeUInt16LE(32, pos + 6);                  // bits per pixel
    buf.writeUInt32LE(length, pos + 8);              // image size
    buf.writeUInt32LE(o, pos + 12);                  // image offset
    pos += 16;
  }
  for (const e of entries) {
    e.data.copy(buf, e.offset);
  }
  writeFileSync(ICO_OUT, buf);
  console.log(`  ✓ ico → ${ICO_OUT}  (${pngs.length} sizes: ${sizes.join('/')})`);
}

async function emitIcns() {
  if (process.platform !== 'darwin') {
    console.log('  ⓘ skip .icns (not on macOS — iconutil unavailable)');
    return;
  }
  // Apple's iconutil expects an .iconset directory with these exact names.
  const iconset = path.join(projectRoot, 'build/icon.iconset');
  if (existsSync(iconset)) rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const recipes = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [size, name] of recipes) {
    await sharp(SRC).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 }).toFile(path.join(iconset, name));
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', ICNS_OUT], { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
  console.log(`  ✓ icns → ${ICNS_OUT}`);
}

async function main() {
  const skipNorm = process.argv.includes('--skip-norm');
  if (!skipNorm) await normalize();
  else console.log('⚠ skipping normalize (--skip-norm) — assuming build/icon.png is already padded');

  await emitPngs();
  await emitIco();
  await emitIcns();

  // Mirror the canonical icon to renderer/public so the DOM <head> link
  // (and any in-app About panel) sees the same artwork.
  const rendererPublic = path.join(projectRoot, 'src/renderer/public');
  if (existsSync(rendererPublic)) {
    const dst = path.join(rendererPublic, 'icon.png');
    writeFileSync(dst, readFileSync(SRC));
    console.log(`  ✓ mirrored → ${dst}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
