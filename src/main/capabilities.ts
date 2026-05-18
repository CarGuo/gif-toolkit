import { statSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { app } from 'electron';
import { log } from './logger';
import { getFfmpegPath, getFfprobePath, getGifsiclePath } from './binaries';
import { ytdlpBinaryPath } from './resolver/ytdlp';
import type { CapabilityIssue, CapabilityReport } from '../shared/types';

/**
 * R-62 — Cross-platform capability probe. Run once on app startup,
 * cache the result, and let the renderer surface a toast for every
 * issue.
 *
 * The probes here are intentionally conservative:
 *
 *  - We don't try to "fix" anything (no auto-download, no auto-rebuild).
 *  - We only report what we can deterministically detect from disk and
 *    `process.platform / process.arch`.
 *  - When the project explicitly hasn't been validated on a given OS
 *    (e.g. Linux Snap/Flatpak Chrome path detection added in R-61) we
 *    emit a 'warn'-severity issue so the user knows the path was wired
 *    blind.
 */

let cached: CapabilityReport | null = null;

function probeBinary(label: string, bin: string, args: string[]): { path: string; ok: boolean; version: string } {
  if (!bin) return { path: '', ok: false, version: '' };
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 5000 });
    if (r.error) {
      log(`cap probe ${label}: ${r.error.message}`);
      return { path: bin, ok: false, version: '' };
    }
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const firstLine = out.split(/\r?\n/).find((s) => s.trim().length > 0) || '';
    const ok = r.status === 0 || /version/i.test(firstLine);
    return { path: bin, ok, version: firstLine.trim() };
  } catch (e) {
    log(`cap probe ${label}: ${(e as Error).message}`);
    return { path: bin, ok: false, version: '' };
  }
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
 */
function gifsicleVendorExists(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkgJson = require.resolve('@343dev/gifsicle/package.json');
    const pkgDir = path.dirname(pkgJson);
    const binaryName = `gifsicle_${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
    const binPath = path.join(pkgDir, 'vendor', process.platform, binaryName);
    return fileExists(binPath);
  } catch {
    return false;
  }
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

  /* --- App icon --------------------------------------------------- */
  // mac dock and Linux desktop entries rely on .icns / hi-res .png. A
  // 32×32 .ico fallback works only for Windows; everywhere else it is
  // the Electron default atom logo.
  if (!opts.hasIconPng) {
    if (opts.platform === 'darwin') {
      issues.push({
        id: 'darwin.icon-no-png',
        severity: 'warn',
        title: 'macOS Dock 图标使用默认图',
        detail: '未找到 build/icon.png(高清 PNG 源图),mac Dock 将显示 Electron 默认图标。\n打包后会自动生成 .icns,但 dev 模式下需要把 PNG 放到 build/icon.png 才能替换 Dock。'
      });
    } else if (opts.platform === 'linux') {
      issues.push({
        id: 'linux.icon-no-png',
        severity: 'warn',
        title: 'Linux 桌面图标使用默认图',
        detail: '未找到 build/icon.png。Linux 的 AppImage/deb/desktop entry 需要 512×512 PNG 才能正确渲染图标。'
      });
    }
  }

  /* --- Binaries --------------------------------------------------- */
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
  if (!opts.ytdlpOk) {
    issues.push({
      id: `${opts.platform}.ytdlp-missing`,
      severity: 'warn',
      title: 'yt-dlp 未就绪',
      detail: '尚未在本地找到 yt-dlp 可执行文件。「真 Chrome 嗅探 / yt-dlp 直链」入口将无法解析 YouTube / Twitter / Bilibili 等需要直链解析的源。\n首次使用任一直链解析时会自动下载。'
    });
  }

  /* --- Linux untested matrix ------------------------------------- */
  if (opts.platform === 'linux') {
    issues.push({
      id: 'linux.unverified',
      severity: 'warn',
      title: 'Linux 平台尚未实机验证',
      detail: 'Linux 适配代码已写完(electron-builder AppImage/deb/tar.gz、Snap/Flatpak Chrome 路径、SingletonLock 检测),但作者无 Linux 实机自测。如遇问题请反馈 issue。'
    });
    if (opts.arch !== 'x64' && opts.arch !== 'arm64') {
      issues.push({
        id: 'linux.unsupported-arch',
        severity: 'error',
        title: `Linux ${opts.arch} 不受支持`,
        detail: `当前进程架构为 ${opts.arch}。electron-builder linux target 只声明了 x64 + arm64,其他架构(armv7l 等)需要自行编译 Electron + native modules。`
      });
    }
  }

  /* --- Windows arm64 ---------------------------------------------- */
  if (opts.platform === 'win32' && opts.arch === 'arm64') {
    issues.push({
      id: 'win32.arm64-not-packaged',
      severity: 'warn',
      title: 'Windows ARM64 未打包',
      detail: 'package.json 的 win.target 仅声明 x64;在 ARM64 Windows 上当前你正运行的应是 x64 仿真版(性能略差)。需要 ARM64 原生包请向 maintainer 提 issue。'
    });
  }

  /* --- Code signing ----------------------------------------------- */
  // We can't actually verify signing inside an unsigned/dev process,
  // but in packaged mode we can check the absence of a signing
  // identity by reading process.mas / process.windowsStore (both
  // false for self-built electron-builder dmg/nsis).
  if (app.isPackaged) {
    if (opts.platform === 'darwin') {
      issues.push({
        id: 'darwin.unsigned',
        severity: 'info',
        title: 'macOS 应用未签名',
        detail: '应用未通过 Apple Developer ID 签名/公证。首次启动可能被 Gatekeeper 拦截,需在「系统设置 → 隐私与安全」点「仍要打开」。'
      });
    } else if (opts.platform === 'win32') {
      issues.push({
        id: 'win32.unsigned',
        severity: 'info',
        title: 'Windows 应用未签名',
        detail: '应用未通过 Authenticode 代码签名。SmartScreen 可能弹出「未识别的发布者」警告,点「更多信息 → 仍要运行」即可。'
      });
    }
  }

  return issues;
}

/**
 * Public — probe & cache. The first call may take ~50ms (3-4
 * `--version` spawns); subsequent calls are O(1).
 */
export function getCapabilityReport(): CapabilityReport {
  if (cached) return cached;

  const platform = process.platform;
  const arch = process.arch;

  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  const gifsiclePath = getGifsiclePath();
  const ytdlpPath = ytdlpBinaryPath();

  const ffmpeg = probeBinary('ffmpeg', ffmpegPath, ['-version']);
  const ffprobe = probeBinary('ffprobe', ffprobePath, ['-version']);
  // gifsicle: prefer vendor existence check first so we don't pay a spawn
  // when we already know the file isn't there (ARM Linux case).
  let gifsicle: { path: string; ok: boolean; version: string };
  if (!fileExists(gifsiclePath) && !gifsicleVendorExists()) {
    gifsicle = { path: gifsiclePath, ok: false, version: '' };
  } else {
    gifsicle = probeBinary('gifsicle', gifsiclePath, ['--version']);
  }
  // yt-dlp: getYtdlpBinaryPath() returns the *expected* path even when
  // not yet downloaded. probe with --version; absence is a soft warn.
  let ytdlp: { path: string; ok: boolean; version: string };
  if (!fileExists(ytdlpPath)) {
    ytdlp = { path: ytdlpPath, ok: false, version: '' };
  } else {
    ytdlp = probeBinary('ytdlp', ytdlpPath, ['--version']);
  }

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
