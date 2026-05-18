import { statSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { log } from './logger';
import { getFfmpegPath, getFfprobePath, getGifsiclePath, findPackageDir } from './binaries';
import { ytdlpBinaryPath, findYtdlpBinarySync } from './resolver/ytdlp';
import type { CapabilityIssue, CapabilityReport } from '../shared/types';

/**
 * R-62 / R-66 — Cross-platform capability probe. Run once on app
 * startup, cache the result, and let the renderer surface a toast for
 * every issue.
 *
 * R-66 design principle (after user feedback):
 *   "issues" 只描述「该功能在当前平台真的不可用」的硬阻塞情况,绝不
 *   作为「待下载 / 待签名 / 默认图标 / 平台未实机验证」这类纯提示性
 *   信息的载体。后者本质上不影响功能在「当前会话」可用与否,在启动
 *   banner 上推 toast 反而会让用户每次启动都看到一堆"问题"造成误读。
 *
 * 因此只保留以下硬阻塞:
 *   - ffmpeg / ffprobe / gifsicle 不可执行 (severity: error)
 *   - linux 在 x64/arm64 之外的 arch 上运行 (severity: error)
 *
 * 移除的(R-66 — 用户明确反馈这些不该当作问题):
 *   - yt-dlp 待下载 — 这是 lazy auto-download,首次用到时再处理,
 *     resolver 会在 catch YtDlpNotInstalledError 时自下载或友好报错。
 *   - darwin/linux icon-no-png — 仅 dev 模式且 build/icon.png 缺失才
 *     触发,packaged build 会从 .icns/.png 自动注入。
 *   - linux.unverified — Linux 适配代码已写,无实机自测仅是开发警告,
 *     运行时若真不能用其他硬阻塞已能覆盖。
 *   - darwin.unsigned / win32.unsigned — 用户已经能启动到这一步,
 *     不影响 in-session 功能可用性。
 *   - win32.arm64-not-packaged — x64 仿真模式实际可运行,不阻塞。
 */

let cached: CapabilityReport | null = null;

function probeBinary(label: string, bin: string, args: string[]): Promise<{ path: string; ok: boolean; version: string }> {
  return new Promise((resolve) => {
    if (!bin) { resolve({ path: '', ok: false, version: '' }); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res: { path: string; ok: boolean; version: string }): void => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    try {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        log(`cap probe ${label}: timeout`);
        finish({ path: bin, ok: false, version: '' });
      }, 5000);
      child.stdout?.on('data', (d) => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', (d) => { stderr += d.toString('utf8'); });
      child.on('error', (e) => {
        clearTimeout(t);
        log(`cap probe ${label}: ${e.message}`);
        finish({ path: bin, ok: false, version: '' });
      });
      child.on('close', (code) => {
        clearTimeout(t);
        const out = `${stdout}\n${stderr}`;
        const firstLine = out.split(/\r?\n/).find((s) => s.trim().length > 0) || '';
        const ok = code === 0 || /version/i.test(firstLine);
        finish({ path: bin, ok, version: firstLine.trim() });
      });
    } catch (e) {
      log(`cap probe ${label}: ${(e as Error).message}`);
      finish({ path: bin, ok: false, version: '' });
    }
  });
}

function fileExists(p: string | undefined | null): boolean {
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveIconPaths(): { png: string | null; ico: string | null } {
  const candidatesPng = [
    path.join(__dirname, '..', '..', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'build', 'icon.png'),
    path.join(process.resourcesPath || '', 'icon.png')
  ];
  const candidatesIco = [
    path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'build', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico')
  ];
  return {
    png: candidatesPng.find((p) => fileExists(p)) ?? null,
    ico: candidatesIco.find((p) => fileExists(p)) ?? null
  };
}

/**
 * Probe whether the gifsicle binary we resolved is the @343dev vendored
 * copy AND whether the per-platform/arch sub-folder physically exists.
 * On ARM Linux the @343dev/gifsicle vendor tree may not include
 * `linux/gifsicle_arm64`, in which case we fall back to system PATH.
 *
 * R-63 — Use the walk-up `findPackageDir` helper instead of
 * `require.resolve('@343dev/gifsicle/package.json')`. The package's
 * `exports` map omits `./package.json`, so the legacy require throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED even when the vendor binary is
 * physically present in `node_modules/@343dev/gifsicle/vendor/<plat>/`.
 * That false negative was the trigger for the "gifsicle 不可用" toast
 * in the user's screenshot.
 */
function gifsicleVendorExists(): boolean {
  const pkgDir = findPackageDir('@343dev/gifsicle');
  if (!pkgDir) return false;
  const binaryName = `gifsicle_${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
  const binPath = path.join(pkgDir, 'vendor', process.platform, binaryName);
  return fileExists(binPath);
}

function buildIssues(opts: {
  platform: NodeJS.Platform;
  arch: string;
  hasIconPng: boolean;
  hasIconIco: boolean;
  ffmpegOk: boolean;
  ffprobeOk: boolean;
  gifsicleOk: boolean;
  ytdlpOk: boolean;
}): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];

  /* --- Hard-blocking binary failures ------------------------------ */
  // R-66 — Only these three binaries make the app actually unusable
  // when missing. yt-dlp is lazy-downloaded on first use (R-14
  // resolver auto-bootstrap), so absence is NOT a startup issue.
  if (!opts.ffmpegOk) {
    issues.push({
      id: `${opts.platform}.ffmpeg-missing`,
      severity: 'error',
      title: 'ffmpeg 不可用',
      detail: '未能定位或执行 ffmpeg 二进制。视频→GIF/WebP、修剪/速度/反向/旋转/裁剪等所有视频相关功能将不可用。\n请检查 ffmpeg-static 是否被 npm rebuild 正确解压。'
    });
  }
  if (!opts.ffprobeOk) {
    issues.push({
      id: `${opts.platform}.ffprobe-missing`,
      severity: 'error',
      title: 'ffprobe 不可用',
      detail: '未能定位或执行 ffprobe 二进制。媒体探测(分辨率 / 时长 / 帧率)将失败,工具箱的预览/裁剪面板会无法初始化。'
    });
  }
  if (!opts.gifsicleOk) {
    issues.push({
      id: `${opts.platform}.gifsicle-missing`,
      severity: 'error',
      title: 'gifsicle 不可用',
      detail: 'GIF 优化、resize、互转 等工具箱功能依赖 gifsicle。\n如果你在 ARM Linux,@343dev/gifsicle 可能没有提供该 arch 的 vendor 二进制,可改装系统 gifsicle (apt install gifsicle / brew install gifsicle)。'
    });
  }

  /* --- Linux unsupported arch (hard-blocking) --------------------- */
  // R-66 — keep linux-on-armv7 as a hard error because electron-builder
  // never produced a binary for that arch; the user is running on an
  // unblessed Electron build whose native modules may segfault. All
  // other linux-related "this matrix isn't tested" / icon hints have
  // been demoted to log-only (see file header).
  if (opts.platform === 'linux' && opts.arch !== 'x64' && opts.arch !== 'arm64') {
    issues.push({
      id: 'linux.unsupported-arch',
      severity: 'error',
      title: `Linux ${opts.arch} 不受支持`,
      detail: `当前进程架构为 ${opts.arch}。electron-builder linux target 只声明了 x64 + arm64,其他架构(armv7l 等)需要自行编译 Electron + native modules。`
    });
  }

  return issues;
}

/**
 * Public — probe & cache. The first call may take ~50-200ms (3-4
 * `--version` spawns running concurrently); subsequent calls are O(1).
 *
 * R-66 — Now async + uses non-blocking `spawn` (no spawnSync). Earlier
 * versions used `spawnSync(..., timeout: 5000)` which froze the main
 * process event loop for the full timeout when a binary couldn't
 * launch (macOS arm64 ffprobe-static first-launch ETIMEDOUT). That was
 * the user-reported "彩虹 loading 卡 5 秒" symptom; the renderer's
 * `useEffect` calling `system:capabilities` on mount triggered the
 * sync wait inside the main process and blocked BrowserWindow paint.
 */
export async function getCapabilityReport(): Promise<CapabilityReport> {
  if (cached) return cached;

  const platform = process.platform;
  const arch = process.arch;

  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const gifsiclePath = getGifsiclePath();
  // R-63 — Use the iterating sync finder so the probe sees the bundled
  // binary regardless of which candidate dir it ended up in. Falls back
  // to the canonical "expected" path for the diagnostics field if
  // nothing is on disk yet.
  // R-64 — Add explicit logging so future "yt-dlp 未就绪 / 待下载" reports
  // can be diagnosed: log whether the sync finder hit, and the exact
  // path we end up probing.
  const ytdlpFound = findYtdlpBinarySync();
  const ytdlpPath = ytdlpFound ?? ytdlpBinaryPath();
  log(`cap probe ytdlp: found=${ytdlpFound ?? '<none>'} probePath=${ytdlpPath}`);

  // Skip-on-missing for gifsicle / yt-dlp so we don't pay a spawn when
  // the file isn't there. Spawn the rest concurrently.
  const gifsicleSkip = !fileExists(gifsiclePath) && !gifsicleVendorExists();
  const ytdlpSkip = !fileExists(ytdlpPath);

  const [ffmpeg, ffprobe, gifsicle, ytdlp] = await Promise.all([
    probeBinary('ffmpeg', ffmpegPath, ['-version']),
    probeBinary('ffprobe', ffprobePath, ['-version']),
    gifsicleSkip
      ? Promise.resolve({ path: gifsiclePath, ok: false, version: '' })
      : probeBinary('gifsicle', gifsiclePath, ['--version']),
    ytdlpSkip
      ? Promise.resolve({ path: ytdlpPath, ok: false, version: '' })
      : probeBinary('ytdlp', ytdlpPath, ['--version'])
  ]);

  const icons = resolveIconPaths();

  const issues = buildIssues({
    platform,
    arch,
    hasIconPng: !!icons.png,
    hasIconIco: !!icons.ico,
    ffmpegOk: ffmpeg.ok,
    ffprobeOk: ffprobe.ok,
    gifsicleOk: gifsicle.ok,
    ytdlpOk: ytdlp.ok
  });

  cached = {
    platform,
    arch,
    hasHiResIcon: !!icons.png,
    binaries: { ffmpeg, ffprobe, gifsicle, ytdlp },
    issues
  };

  log(`capabilities: platform=${platform} arch=${arch} issues=${issues.length} ` +
    `[${issues.map((i) => `${i.severity}:${i.id}`).join(', ')}]`);

  return cached;
}

/** Clear the cache. Used by tests; main never calls this. */
export function _resetCapabilityCache(): void {
  cached = null;
}
