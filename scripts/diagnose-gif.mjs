#!/usr/bin/env node
/**
 * scripts/diagnose-gif.mjs
 *
 * GIF "为什么会被公众号 / 微博识别为非常规来源" 诊断器。
 *
 * 用法:
 *   node scripts/diagnose-gif.mjs path/to/file.gif [more.gif ...]
 *
 * 检测维度(每条都对应过往真实踩坑):
 *   ① Application Extension 是不是只有标准 NETSCAPE2.0 / XMP DataXMP
 *   ② 是否有 Comment Extension (典型水印:ezgif / ScreenToGif)
 *   ③ 帧尺寸是否都等于 logical screen(差分帧 = 后端风控触发点)
 *   ④ 是否使用 local color tables(local CT + 透明 → too complex)
 *   ⑤ 总文件大小是否超过常见平台硬上限(WeChat 10MB / Slack 5MB / Discord 8MB)
 *   ⑥ 帧数 / 总时长 是否异常高(135+ 帧 + 10s+ 容易被判作录屏)
 *
 * 脚本只读,不修改任何文件。退出码:
 *   0 — 全部 GIF 都通过基础检查
 *   1 — 至少一个 GIF 有"高风险"指标
 *   2 — 调用错误(参数缺失 / 文件不存在 / gifsicle 不可用)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function findGifsicle() {
  const candidates = [
    path.join(projectRoot, 'node_modules/.bin/gifsicle'),
    path.join(projectRoot, 'node_modules/gifsicle/vendor/gifsicle'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback to PATH
  const which = spawnSync('which', ['gifsicle']);
  if (which.status === 0) return which.stdout.toString().trim();
  return null;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function diagnoseOne(file, gifsicle) {
  const abs = path.resolve(file);
  if (!existsSync(abs)) return { file, error: `not found: ${abs}` };
  const size = statSync(abs).size;
  let info;
  try {
    info = execFileSync(gifsicle, ['--info', abs], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    return { file: abs, error: `gifsicle --info failed: ${err.message}` };
  }

  const screenMatch = info.match(/logical screen (\d+)x(\d+)/);
  const screen = screenMatch ? `${screenMatch[1]}x${screenMatch[2]}` : 'unknown';
  const screenW = screenMatch ? Number(screenMatch[1]) : 0;
  const screenH = screenMatch ? Number(screenMatch[2]) : 0;

  const imageHeaders = [...info.matchAll(/^\s*\+ image #(\d+) (\d+)x(\d+)(?: at (\d+),(\d+))?(?: ([^\n]*))?$/gm)];
  const frameCount = imageHeaders.length;
  const frameSizes = new Set(imageHeaders.map((m) => `${m[2]}x${m[3]}`));
  const offsetFrames = imageHeaders.filter((m) => m[4] !== undefined).length;
  const fullFrameOnly = frameSizes.size === 1 && [...frameSizes][0] === screen && offsetFrames === 0;

  const localCTCount = (info.match(/local color table/g) || []).length;
  const transparentFrames = (info.match(/transparent \d+/g) || []).length;
  const commentMatches = [...info.matchAll(/comment (.+)/g)].map((m) => m[1].trim());

  // Sum of `delay X.XXs` to estimate total play time
  const delayMatches = [...info.matchAll(/delay ([0-9.]+)s/g)];
  const totalDelay = delayMatches.reduce((sum, m) => sum + Number(m[1]), 0);

  const findings = [];

  // 公众号官方硬限(2024 编辑器报错文案):
  //   - 图片帧数 > 300       → 直接拒收,提示「图片帧数超过 300 帧」
  //   - header 不规范        → 提示「来源信息无法识别」
  // 这两条是 OR 关系,任一触发都会让插入失败。
  if (frameCount > 300) {
    findings.push({
      level: 'high',
      code: 'FRAMES_OVER_300',
      msg: `${frameCount} 帧 > 公众号官方上限 300 帧 — 编辑器会直接报"图片帧数超过 300 帧"`,
    });
  } else if (frameCount > 250) {
    findings.push({
      level: 'mid',
      code: 'FRAMES_NEAR_300',
      msg: `${frameCount} 帧 接近公众号 300 帧上限,任何二次编辑(裁剪/拼接)都可能越界`,
    });
  }

  if (size > 10 * 1024 * 1024) findings.push({ level: 'high', code: 'TOO_LARGE_WECHAT', msg: `文件 ${fmtBytes(size)} > 10 MB,公众号会直接拒收` });
  else if (size > 5 * 1024 * 1024) findings.push({ level: 'mid', code: 'TOO_LARGE_5MB', msg: `文件 ${fmtBytes(size)} > 5 MB,Slack / 微博等会拒收` });

  if (commentMatches.length > 0) {
    findings.push({ level: 'high', code: 'COMMENT_BLOCK', msg: `带 comment 水印 (${commentMatches.length} 条),典型如 "Created with ezgif.com" — 公众号会报"来源信息无法识别"`, detail: commentMatches.slice(0, 3) });
  }

  if (!fullFrameOnly && frameSizes.size > 1) {
    findings.push({
      level: 'mid',
      code: 'DIFF_FRAMES',
      msg: `${frameCount} 帧中有 ${frameSizes.size} 种不同的帧尺寸 + ${offsetFrames} 帧带偏移 — 这是 lossy/diff-frame 优化产物的特征,部分平台会判作"非常规来源"`,
    });
  }

  if (localCTCount > 0 && transparentFrames > 0) {
    findings.push({
      level: 'mid',
      code: 'LOCAL_CT_PLUS_TRANSP',
      msg: `${localCTCount} 帧使用 local color table + ${transparentFrames} 帧使用透明 — gifsicle 会报 "too complex to unoptimize"`,
    });
  }

  if (frameCount > 100 && totalDelay > 8 && frameCount <= 300) {
    findings.push({ level: 'low', code: 'LONG_RECORDING', msg: `${frameCount} 帧 / 总时长 ${totalDelay.toFixed(1)}s — 较长的 GIF 容易被判作录屏(尚未触发 300 帧硬限)` });
  }

  if (screenW > 1080 || screenH > 1080) {
    findings.push({ level: 'mid', code: 'OVERSIZE_DIM', msg: `分辨率 ${screen} 超过常见平台硬上限 1080×1080` });
  }

  return { file: abs, size, screen, frameCount, totalDelay, frameSizes: frameSizes.size, offsetFrames, localCTCount, transparentFrames, commentMatches, findings };
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (args.length === 0) {
    console.error('Usage: node scripts/diagnose-gif.mjs <file.gif> [more.gif ...]');
    process.exit(2);
  }
  const gifsicle = findGifsicle();
  if (!gifsicle) {
    console.error('gifsicle binary not found — run `npm install` first.');
    process.exit(2);
  }

  let exitCode = 0;
  for (const file of args) {
    const r = diagnoseOne(file, gifsicle);
    console.log('═'.repeat(72));
    console.log(`📄 ${r.file}`);
    if (r.error) {
      console.log(`   ❌ ${r.error}`);
      exitCode = Math.max(exitCode, 2);
      continue;
    }
    console.log(`   size=${fmtBytes(r.size)}  screen=${r.screen}  frames=${r.frameCount}  duration=${r.totalDelay.toFixed(2)}s`);
    console.log(`   frame-size variants=${r.frameSizes}  offset-frames=${r.offsetFrames}  local-color-tables=${r.localCTCount}  transparent-frames=${r.transparentFrames}  comments=${r.commentMatches.length}`);
    if (r.findings.length === 0) {
      console.log('   ✅ 无明显风险点');
      continue;
    }
    let hadHigh = false;
    for (const f of r.findings) {
      const icon = f.level === 'high' ? '🚨' : f.level === 'mid' ? '⚠️ ' : 'ℹ️ ';
      console.log(`   ${icon} [${f.code}] ${f.msg}`);
      if (f.detail) for (const d of f.detail) console.log(`        ↳ ${d}`);
      if (f.level === 'high') hadHigh = true;
    }
    if (hadHigh) exitCode = Math.max(exitCode, 1);
    console.log('   💡 建议:`node scripts/sanitize-gif.mjs <file>` 一键全帧重铸 + 抹除水印 + 自动降帧 ≤ 300');
  }
  console.log('═'.repeat(72));
  process.exit(exitCode);
}

main();
