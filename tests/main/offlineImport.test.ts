/**
 * R-55 Fix #3 — Tests for offline page / media import.
 *
 * These tests pin the three input shapes documented in
 * `src/main/offlineImport.ts`:
 *
 *   1. Single image / video file → one synthesised SniffedMedia with
 *      a `file://` URL.
 *   2. Single .html file with sibling assets on disk → relative refs
 *      resolve to `file://` URLs; missing refs are dropped (warning).
 *   3. .mhtml multipart/related → primary text/html part walked, with
 *      Content-Location → staged temp file rewriting so the resulting
 *      SniffResult exposes only `file://` URLs that exist on disk.
 *
 * We deliberately avoid network and avoid Electron — the module is
 * pure Node + cheerio so the entire surface can be unit tested with
 * temp dirs.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// `src/main/offlineImport.ts` transitively imports `./logger`, which
// in turn registers an `ipcMain.handle(...)` at module load time. In
// the vitest node environment there is no Electron, so we stub the
// minimum surface needed by every main-side module under test.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { importOfflinePath } from '../../src/main/offlineImport';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'giftk-offline-test-'));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('importOfflinePath — single media file', () => {
  it('synthesises a single video item from a stand-alone .mp4', async () => {
    const p = path.join(tmp, 'demo.mp4');
    fs.writeFileSync(p, Buffer.from([0, 1, 2, 3]));
    const r = await importOfflinePath(p);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].kind).toBe('video');
    expect(r.items[0].url).toBe(pathToFileURL(p).toString());
    expect(r.items[0].sizeBytes).toBe(4);
    expect(r.warnings).toHaveLength(0);
  });

  it('synthesises a single image item from a stand-alone .png', async () => {
    const p = path.join(tmp, 'a.png');
    fs.writeFileSync(p, Buffer.from([0]));
    const r = await importOfflinePath(p);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].kind).toBe('image');
    expect(r.items[0].url).toBe(pathToFileURL(p).toString());
  });

  it('classifies .gif as gif (not image), so the processor picks the right pipeline', async () => {
    const p = path.join(tmp, 'a.gif');
    fs.writeFileSync(p, Buffer.from([0]));
    const r = await importOfflinePath(p);
    expect(r.items[0].kind).toBe('gif');
  });

  it('throws on unsupported extensions instead of silently producing zero items', async () => {
    const p = path.join(tmp, 'demo.xyz');
    fs.writeFileSync(p, Buffer.from([0]));
    await expect(importOfflinePath(p)).rejects.toThrow(/不支持的离线导入类型/);
  });
});

describe('importOfflinePath — html + sibling _files/', () => {
  it('resolves relative <img>, <video>, <source> refs that exist on disk', async () => {
    const filesDir = path.join(tmp, 'page_files');
    fs.mkdirSync(filesDir);
    fs.writeFileSync(path.join(filesDir, 'cover.jpg'), Buffer.from([0]));
    fs.writeFileSync(path.join(filesDir, 'clip.mp4'), Buffer.from([0]));

    fs.writeFileSync(
      path.join(tmp, 'page.html'),
      `<!doctype html><html><head><title>Saved page</title></head><body>
        <img src="page_files/cover.jpg">
        <video><source src="page_files/clip.mp4" type="video/mp4"></video>
      </body></html>`
    );

    const r = await importOfflinePath(path.join(tmp, 'page.html'));
    expect(r.title).toBe('Saved page');
    expect(r.items).toHaveLength(2);
    expect(r.items.find((i) => i.kind === 'image')?.url).toBe(
      pathToFileURL(path.join(filesDir, 'cover.jpg')).toString()
    );
    expect(r.items.find((i) => i.kind === 'video')?.url).toBe(
      pathToFileURL(path.join(filesDir, 'clip.mp4')).toString()
    );
  });

  it('drops references whose target file is missing', async () => {
    fs.writeFileSync(
      path.join(tmp, 'page.html'),
      `<!doctype html><html><body><img src="missing.jpg"></body></html>`
    );
    const r = await importOfflinePath(path.join(tmp, 'page.html'));
    expect(r.items).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('keeps absolute http(s) refs as-is so the normal downloader can fetch them', async () => {
    fs.writeFileSync(
      path.join(tmp, 'page.html'),
      `<!doctype html><html><body><img src="https://cdn.example.com/x.jpg"></body></html>`
    );
    const r = await importOfflinePath(path.join(tmp, 'page.html'));
    expect(r.items).toHaveLength(1);
    expect(r.items[0].url).toBe('https://cdn.example.com/x.jpg');
  });

  it('rejects parent-traversal paths and ignores absolute on-disk paths', async () => {
    // Sneaky src that tries to escape the page directory.
    fs.writeFileSync(
      path.join(tmp, 'page.html'),
      `<!doctype html><html><body>
        <img src="../../../etc/passwd">
        <img src="/etc/hosts">
      </body></html>`
    );
    const r = await importOfflinePath(path.join(tmp, 'page.html'));
    expect(r.items).toHaveLength(0);
  });
});

describe('importOfflinePath — directory input', () => {
  it('treats a directory as the saved-page root and finds the .html inside', async () => {
    const dir = path.join(tmp, 'My Site');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><html><head><title>Dir</title></head><body></body></html>`
    );
    const r = await importOfflinePath(dir);
    expect(r.title).toBe('Dir');
  });

  it('errors when no .html exists in the chosen directory', async () => {
    const dir = path.join(tmp, 'empty');
    fs.mkdirSync(dir);
    await expect(importOfflinePath(dir)).rejects.toThrow(/没有 \.html/);
  });
});

describe('importOfflinePath — .mhtml', () => {
  it('parses a tiny multipart/related archive and rewrites refs to staged file:// URLs', async () => {
    // Build a minimal mhtml with one html part and one image part.
    // Both base64-encoded so the test is byte-exact.
    const boundary = '----=_NextPart_test';
    const htmlBody =
      '<!doctype html><html><head><title>MHT</title></head>' +
      '<body><img src="https://cdn.example.com/a.png"></body></html>';
    const imgBytes = Buffer.from([1, 2, 3, 4, 5]);

    const lines: string[] = [];
    lines.push(`From: <Saved by Test>`);
    lines.push(`Subject: =?utf-8?Q?Test?=`);
    lines.push(`MIME-Version: 1.0`);
    lines.push(`Content-Type: multipart/related; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: text/html`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push(`Content-Location: https://example.com/page.html`);
    lines.push('');
    lines.push(Buffer.from(htmlBody, 'utf8').toString('base64'));
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: image/png`);
    lines.push(`Content-Transfer-Encoding: base64`);
    lines.push(`Content-Location: https://cdn.example.com/a.png`);
    lines.push('');
    lines.push(imgBytes.toString('base64'));
    lines.push(`--${boundary}--`);
    lines.push('');

    const mhtmlPath = path.join(tmp, 'archive.mhtml');
    fs.writeFileSync(mhtmlPath, lines.join('\r\n'));

    const r = await importOfflinePath(mhtmlPath);
    expect(r.title).toBe('MHT');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].kind).toBe('image');
    // The img src in the html points to the absolute URL; offlineImport
    // should rewrite it to the staged file:// for a.png.
    expect(r.items[0].url.startsWith('file://')).toBe(true);
    expect(r.items[0].url.endsWith('.png')).toBe(true);
  });

  it('throws a clear error when the boundary is missing', async () => {
    const mhtmlPath = path.join(tmp, 'bad.mhtml');
    fs.writeFileSync(
      mhtmlPath,
      'Content-Type: text/html\r\n\r\n<html></html>'
    );
    await expect(importOfflinePath(mhtmlPath)).rejects.toThrow(/multipart\/related/);
  });
});
