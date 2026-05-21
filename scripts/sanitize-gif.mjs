#!/usr/bin/env node
/**
 * scripts/sanitize-gif.mjs
 *
 * 把 GIF 重铸成"公众号编辑器接受的最干净标准格式"。
 *
 * 公众号编辑器的两条硬性拒收规则(2024 报错原文):
 *   ① 「图片帧数超过 300 帧」  → 帧数必须 ≤ 300
 *   ② 「来源信息无法识别」      → header 里不能有非标 application
 *      extension / comment block,部分编辑器还会嫌弃 diff-frame
 *      (帧尺寸 ≠ logical screen)
 *
 * 本脚本的策略:
 *   ① 先用 gifsicle --info 数帧。如果 frames > 300,先用 ffmpeg 抽帧
 *      到 300 以下(等比例时间均匀采样,保留首尾帧)。
 *   ② 用 ffmpeg palettegen + paletteuse 重新编码,产出:
 *      - 单一 global color table (无 local CT)
 *      - 无 application extension(只有 ffmpeg 写入的 NETSCAPE2.0 LOOP)
 *      - 无 comment block
 *      - 加 `-gifflags -transdiff-offsetting` 关闭 ffmpeg 自身的
 *        透明差分 + 帧偏移压缩 → 全帧统一为 logical screen 尺寸
 *   ③ 用 gifsicle 做最终清洗(--no-extensions/--no-comments/--no-names)
 *      并强制 `-O0`(不做帧间优化,避免重新引入 diff-frame),配合
 *      `--lossy=80`(可调)在质量层面减小体积。
 *
 * 用法:
 *   node scripts/sanitize-gif.mjs path/to/file.gif [-o output.gif]
 *   node scripts/sanitize-gif.mjs *.gif                       # 批量
 *   node scripts/sanitize-gif.mjs file.gif --max-frames 250   # 自定上限
 *
 * 不指定 -o 时,产物默认放在源文件同目录,文件名后缀加 `.sanitized.gif`。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const WECHAT_MAX_FRAMES = 300;

function findBin(name) {
  const candidates = [
    path.join(projectRoot, `node_modules/.bin/${name}`),
    path.join(projectRoot, `node_modules/${name}-static/${name}`),
    path.join(projectRoot, `node_modules/${name}/vendor/${name}`),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const which = spawnSync('which', [name]);
  if (which.status === 0) return which.stdout.toString().trim();
  return null;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function parseArgs(argv) {
  const files = [];
  let outFile = null;
  let maxFrames = WECHAT_MAX_FRAMES;
  let lossy = 80; // gifsicle --lossy default; 0 = disable
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') outFile = argv[++i];
    else if (a === '--max-frames') maxFrames = Number(argv[++i]);
    else if (a === '--lossy') lossy = Number(argv[++i]);
    else if (a === '--no-lossy') lossy = 0;
    else files.push(a);
  }
  return { files, outFile, maxFrames, lossy };
}

function deriveOut(input) {
  const ext = path.extname(input);
  const base = input.slice(0, -ext.length);
  return `${base}.sanitized${ext || '.gif'}`;
}

function probeFrames(gifsicle, file) {
  const info = execFileSync(gifsicle, ['--info', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const frameCount = (info.match(/^\s*\+ image #/gm) || []).length;
  const delays = [...info.matchAll(/delay ([0-9.]+)s/g)].map((m) => Number(m[1]));
  const totalDelay = delays.reduce((s, d) => s + d, 0);
  // Average source fps (used for derived output rate calculation when downsampling)
  const avgDelay = delays.length > 0 ? totalDelay / delays.length : 0.04;
  const srcFps = avgDelay > 0 ? 1 / avgDelay : 25;
  return { frameCount, totalDelay, srcFps };
}

function sanitizeOne(input, outOverride, maxFrames, lossy, ffmpeg, gifsicle) {
  const abs = path.resolve(input);
  if (!existsSync(abs)) throw new Error(`not found: ${abs}`);
  const out = outOverride ? path.resolve(outOverride) : deriveOut(abs);
  const tmp = `${out}.tmp.gif`;

  const beforeSize = statSync(abs).size;
  const probe = probeFrames(gifsicle, abs);
  console.log(`▶ ${abs}  (${fmtBytes(beforeSize)}, ${probe.frameCount} frames, ${probe.totalDelay.toFixed(2)}s @ ~${probe.srcFps.toFixed(1)}fps)`);

  // ── decide frame strategy ──
  let downsampleFps = null;
  if (probe.frameCount > maxFrames) {
    // Pick the largest fps that yields ≤ maxFrames over the same duration.
    // Adding a 5% safety margin so border rounding doesn't push us back over.
    const safeFrameBudget = Math.floor(maxFrames * 0.95);
    downsampleFps = Math.max(1, Math.floor(safeFrameBudget / Math.max(0.1, probe.totalDelay)));
    console.log(`  ⓘ ${probe.frameCount} > ${maxFrames} 上限 — 抽帧重采样到 ${downsampleFps} fps(预计 ≈ ${Math.round(downsampleFps * probe.totalDelay)} 帧)`);
  }

  // Step ① ffmpeg re-encode: single global palette + (optional) frame downsample.
  // `new=0` 让 paletteuse 复用同一张全局调色板 → 不再产生 local CT。
  // `-gifflags '-transdiff-offsetting'` 关键!关闭 ffmpeg 自己的"用透明像素 + 帧偏移
  // 做差分压缩",否则产物里仍会出现多种帧尺寸 + 偏移帧(diff-frame 特征)。
  const filter = downsampleFps
    ? `fps=${downsampleFps},split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:new=0`
    : `split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:new=0`;
  console.log('  ① ffmpeg 重新编码(全局调色板 + 标准 NETSCAPE2.0 header + 关闭 transdiff)');
  execFileSync(ffmpeg, [
    '-y', '-i', abs,
    '-vf', filter,
    '-gifflags', '-transdiff-offsetting',
    '-an', tmp,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // Step ② gifsicle 二次保险:剥 extension/comment/name + LZW 重打包。
  //
  // 关键权衡(实测在 cdn_problem.gif 验证):
  //   - `-O3` 会重新引入 diff-frame 优化(出现多种帧尺寸 + 偏移帧),
  //     而公众号正是把"非 logical-screen 帧"判作「来源信息无法识别」。
  //   - `-O0` 完全不做帧间优化,产物体积约比 -O3 大 3 倍,但 header 100% 干净。
  //   - 我们选 `-O0` + `--lossy=N`(默认 80),用质量损失换体积,
  //     避免 -O3 引入的结构性 diff-frame。lossy=80 对视觉感知影响很小。
  const lossyArgs = lossy > 0 ? [`--lossy=${lossy}`] : [];
  console.log(`  ② gifsicle 剥 extension/comment + 无帧间优化 LZW 重打包(-O0${lossy > 0 ? ` --lossy=${lossy}` : ''})`);
  execFileSync(gifsicle, [
    '--no-extensions',
    '--no-comments',
    '--no-names',
    ...lossyArgs,
    '-O0',
    tmp,
    '-o', out,
  ]);

  try { unlinkSync(tmp); } catch { /* ignore */ }

  const afterSize = statSync(out).size;
  const delta = afterSize - beforeSize;
  const sign = delta >= 0 ? '+' : '';
  const after = probeFrames(gifsicle, out);
  console.log(`  ✅ ${out}`);
  console.log(`     ${fmtBytes(afterSize)} (${sign}${fmtBytes(delta)}), ${after.frameCount} frames`);
  if (after.frameCount > maxFrames) {
    console.log(`     ⚠️  仍然 > ${maxFrames} 帧,可能需要进一步降帧或缩短时长`);
  }
  return { in: abs, out, beforeSize, afterSize, beforeFrames: probe.frameCount, afterFrames: after.frameCount };
}

function main() {
  const { files, outFile, maxFrames, lossy } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('Usage: node scripts/sanitize-gif.mjs <file.gif> [-o out.gif] [--max-frames N] [--lossy N|--no-lossy]');
    console.error('       node scripts/sanitize-gif.mjs *.gif        (batch mode)');
    process.exit(2);
  }
  if (outFile && files.length > 1) {
    console.error('-o/--output only valid with a single input file (batch mode auto-derives names).');
    process.exit(2);
  }

  const ffmpeg = findBin('ffmpeg');
  const gifsicle = findBin('gifsicle');
  if (!ffmpeg || !gifsicle) {
    console.error(`missing binary: ffmpeg=${ffmpeg} gifsicle=${gifsicle}`);
    process.exit(2);
  }
  console.log(`ffmpeg:   ${ffmpeg}`);
  console.log(`gifsicle: ${gifsicle}`);
  console.log(`max-frames (公众号上限): ${maxFrames}`);
  console.log(`lossy:    ${lossy > 0 ? lossy : 'disabled'}`);
  console.log('');

  for (const f of files) sanitizeOne(f, outFile, maxFrames, lossy, ffmpeg, gifsicle);
}

main();
