#!/usr/bin/env node
/**
 * Generate macOS tray-icon template images from build/icon.png.
 *
 * macOS menu-bar tray icons should be "template images": a single
 * colour mask (black RGB + original alpha). AppKit then re-tints
 * them per the menu bar's appearance (light/dark) so the icon
 * remains readable in both modes. Shipping a full-colour brand
 * logo as the tray image looks unprofessional on macOS — the
 * platform expects a glyph, not a coloured tile.
 *
 * Algorithm:
 *   1. Resize source PNG (build/icon.png) to N×N preserving alpha.
 *   2. For every pixel with alpha > 0, force RGB to (0, 0, 0).
 *      Alpha stays untouched — the silhouette remains exact.
 *   3. Write out the result as PNG.
 *
 * Outputs (committed to the repo so dev/CI builds don't need to
 * regenerate them):
 *   build/icons/trayTemplate.png      18×18 (1× macOS menu bar)
 *   build/icons/trayTemplate@2x.png   36×36 (2× retina)
 *
 * Run with:  node scripts/build-tray-template.mjs
 */
import sharp from 'sharp';
import path from 'node:path';

async function makeTemplate(srcPath, outPath, size) {
  const { data, info } = await sharp(srcPath)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
    }
  }
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toFile(outPath);
  console.log(`[build-tray-template] wrote ${outPath} (${size}x${size})`);
}

const root = process.cwd();
const src = path.join(root, 'build', 'icon.png');
await makeTemplate(src, path.join(root, 'build', 'icons', 'trayTemplate.png'), 18);
await makeTemplate(src, path.join(root, 'build', 'icons', 'trayTemplate@2x.png'), 36);
