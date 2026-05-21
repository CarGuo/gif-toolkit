#!/usr/bin/env node
/**
 * Render macOS tray-icon template images from a hand-tuned SVG glyph.
 *
 * Why a dedicated SVG instead of recolouring build/icon.png?
 *   The brand logo is a full-colour app icon: a white rounded-square
 *   tile holding a colourful image-stack + arrows + play-triangle.
 *   When you reduce that to an alpha mask at 18×18 (the macOS menu
 *   bar tray size), every non-transparent pixel gets re-painted with
 *   one tone, and the dominant non-transparent region IS the white
 *   squircle base — so the result is a completely unidentifiable
 *   solid blob. Setting setTemplateImage(true) on it gives a white
 *   square in the menu bar.
 *
 *   macOS HIG menu-bar extras want a *glyph*, not a re-coloured app
 *   icon. We hand-authored build/icons/trayTemplate.svg distilling
 *   the brand into two recognisable strokes (loop arrows + play
 *   triangle) that stay legible at 18px. Sharp rasterises that SVG
 *   to PNG. The output already has black RGB + transparent
 *   background, so no per-pixel re-tinting step is needed — we just
 *   round-trip through sharp to lock dimensions and strip metadata.
 *
 * Outputs:
 *   build/icons/trayTemplate.png       18×18 (1× menu bar)
 *   build/icons/trayTemplate@2x.png    36×36 (2× retina)
 *
 * Run with:  node scripts/build-tray-template.mjs
 */
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function renderGlyph(svgPath, outPath, size) {
  const svg = readFileSync(svgPath);
  // density=size*4 oversamples the SVG before downscale so anti-
  // aliased edges stay clean at the small target. We then resize
  // with `fit: contain` and a fully transparent background so the
  // template image's alpha channel matches the glyph's ink, not a
  // bounding box.
  await sharp(svg, { density: size * 8 })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`[build-tray-template] wrote ${outPath} (${size}x${size})`);
}

const root = process.cwd();
const src = path.join(root, 'build', 'icons', 'trayTemplate.svg');
await renderGlyph(src, path.join(root, 'build', 'icons', 'trayTemplate.png'), 18);
await renderGlyph(src, path.join(root, 'build', 'icons', 'trayTemplate@2x.png'), 36);
