import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const docsDir = path.join(projectRoot, 'docs');
const imagesDir = path.join(docsDir, 'images');
const tmpDir = path.join(docsDir, '.mermaid-tmp');

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs';
const RENDER_WIDTH = 1600;
const SCALE = 2;

function extractMermaidBlocks(md, filename) {
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;
  let lastSeenImageRef = null;

  const imgRegex = /!\[[^\]]*\]\(\.\/images\/([^)]+\.png)\)/;

  while (i < lines.length) {
    const line = lines[i];

    const imgMatch = line.match(imgRegex);
    if (imgMatch) {
      lastSeenImageRef = imgMatch[1];
      i++;
      continue;
    }

    if (line.trim() === '```mermaid') {
      const startLine = i + 1;
      i++;
      const buf = [];
      while (i < lines.length && lines[i].trim() !== '```') {
        buf.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        throw new Error(`${filename}:${startLine}: unterminated \`\`\`mermaid block`);
      }
      i++;
      if (!lastSeenImageRef) {
        throw new Error(
          `${filename}:${startLine}: mermaid block is not preceded by an image ref like ![alt](./images/<name>.png)`
        );
      }
      blocks.push({
        outName: lastSeenImageRef,
        source: buf.join('\n'),
        atLine: startLine,
      });
      lastSeenImageRef = null;
      continue;
    }
    i++;
  }
  return blocks;
}

function buildHtml(mermaidSource) {
  const escaped = mermaidSource
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  #host { padding: 24px; display: inline-block; }
  .mermaid { font-size: 16px; }
</style>
</head>
<body>
  <div id="host"><pre class="mermaid">${escaped}</pre></div>
  <script type="module">
    import mermaid from '${MERMAID_CDN}';
    window.__mermaidReady = (async () => {
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose', flowchart: { htmlLabels: true, curve: 'basis' }, sequence: { useMaxWidth: false }, themeVariables: { fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif' } });
      const el = document.querySelector('.mermaid');
      const src = el.textContent;
      el.removeAttribute('data-processed');
      const { svg } = await mermaid.render('mmd-out', src);
      el.innerHTML = svg;
      window.__mermaidDone = true;
    })().catch((e) => { window.__mermaidError = String(e && (e.stack || e.message || e)); });
  </script>
</body>
</html>`;
}

async function renderOne(browser, source, outFile) {
  const page = await browser.newPage({ viewport: { width: RENDER_WIDTH, height: 200 }, deviceScaleFactor: SCALE });
  await page.setContent(buildHtml(source), { waitUntil: 'load' });

  await page.waitForFunction(() => {
    return window.__mermaidDone === true || typeof window.__mermaidError === 'string';
  }, { timeout: 30000 });

  const err = await page.evaluate(() => window.__mermaidError || null);
  if (err) {
    await page.close();
    throw new Error(`mermaid render failed: ${err}`);
  }

  const host = await page.locator('#host').first();
  const buf = await host.screenshot({ omitBackground: false, type: 'png' });
  await page.close();

  await writeFile(outFile, buf);
}

async function main() {
  if (!existsSync(docsDir)) {
    throw new Error(`docs dir not found at ${docsDir}`);
  }
  await mkdir(imagesDir, { recursive: true });
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const all = (await readdir(docsDir)).filter(
    (f) => f.endsWith('.md') && !f.startsWith('.')
  );

  const queue = [];
  for (const file of all) {
    const full = path.join(docsDir, file);
    const md = await readFile(full, 'utf8');
    let blocks;
    try {
      blocks = extractMermaidBlocks(md, file);
    } catch (e) {
      console.error(`✗ ${file}: ${e.message}`);
      process.exit(1);
    }
    for (const blk of blocks) queue.push({ file, ...blk });
  }

  if (queue.length === 0) {
    console.log('No mermaid blocks found in docs/*.md.');
    return;
  }

  console.log(`Found ${queue.length} mermaid block(s) across ${all.length} doc(s).`);

  const browser = await chromium.launch({ headless: true });
  try {
    for (const item of queue) {
      const outFile = path.join(imagesDir, item.outName);
      console.log(`▶ rendering ${item.file}#${item.atLine}  →  docs/images/${item.outName}`);
      try {
        await renderOne(browser, item.source, outFile);
      } catch (e) {
        console.error(`  failed:`, e.message);
        throw e;
      }
      // sanity check via sharp + fs.stat
      const meta = await sharp(outFile).metadata();
      const st = await stat(outFile);
      console.log(`  ✓ ${meta.width}x${meta.height} ${(st.size / 1024).toFixed(1)} KB`);
    }
  } finally {
    await browser.close();
  }

  await rm(tmpDir, { recursive: true, force: true });
  console.log(`\n✓ Rendered ${queue.length} diagrams to docs/images/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
