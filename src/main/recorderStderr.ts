/**
 * R-REC-DESKTOP-AREA #error-msg — ffmpeg stderr 关键行抽取
 * -------------------------------------------------------------
 * ffmpeg 死时往 stderr 倾倒大量噪声（fps 列表 / capability
 * descriptors / configuration banner / [tbr/tbn/tbc] 帧率元数据等），
 * 之前 `stderrBuf.slice(-500)` 会把真正的致命行（"Capture screen 0
 * not found" / "Permission denied" / "Invalid argument"）淹没成乱码
 * 片段，用户复制给我们也看不出什么。
 *
 * 本模块把 stderr 按行拆开，按"信号强度"打分（match 越强分越高），
 * 挑出 Top N 关键行作为最终摘要。
 *
 * 抽到独立模块的原因（R-82 抽纯模块单测精神 + recorder.ts 已到 600
 * 行上限）：纯函数 → 跨平台无依赖 → 单测覆盖；recorder.ts close
 * handler import 后直接 const msg = formatFfmpegExitError(...) 即可。
 */

/** 关键词权重表：越靠前权重越大，匹配即记最高分。
 *  顺序刻意按"用户最关心"排：权限 > 设备不存在 > 编码失败 > 通用 error。
 *  全部 case-insensitive。 */
const FFMPEG_STDERR_KEYWORDS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /permission denied/i,                  weight: 100 },
  { pattern: /operation not permitted/i,            weight: 100 },
  { pattern: /screen recording.*not.*(granted|allowed)/i, weight: 100 },
  { pattern: /(input\/output|i\/o) error/i,         weight: 90 },
  { pattern: /no such (file|device)/i,              weight: 90 },
  { pattern: /not found/i,                          weight: 85 },
  { pattern: /cannot (find|open|allocate|read|write)/i, weight: 85 },
  { pattern: /could not (find|open|allocate|read|write)/i, weight: 85 },
  { pattern: /selected framerate.*not supported/i,  weight: 80 },
  { pattern: /selected pixel format.*not supported/i, weight: 80 },
  { pattern: /invalid (argument|data|device|input)/i, weight: 75 },
  { pattern: /failed to (open|init|spawn|allocate)/i, weight: 75 },
  { pattern: /device or resource busy/i,            weight: 75 },
  { pattern: /codec not currently supported/i,      weight: 70 },
  { pattern: /\b(fatal|panic)\b/i,                  weight: 65 },
  { pattern: /\berror\b/i,                          weight: 50 },
  { pattern: /\bfailed\b/i,                         weight: 45 },
  { pattern: /\bunable to\b/i,                      weight: 40 },
];

/** 行级噪声黑名单：即使本行有 "error" 字样也不取（这些是 ffmpeg 启动
 *  时打印的 build configuration / library version 噪声）。
 *  注意：不能粗暴用 `^\s*\[?AVFoundation` 过滤，否则会吞掉真错（如
 *  "[AVFoundation @ 0xabc] Capture screen 5 not found"）。 */
const FFMPEG_STDERR_NOISE: RegExp[] = [
  /^\s*ffmpeg version /i,
  /^\s*built with /i,
  /^\s*configuration:/i,
  /^\s*lib(av|sw|postproc)/i,
  // AVFoundation 设备列表段标题（精确匹配三种 banner）
  /AVFoundation (video|audio|screen) devices:\s*$/i,
  // 设备枚举行 `[N] FaceTime HD Camera` / `[N] Capture screen 0`
  /\[\d+\] (Capture screen|FaceTime|iPhone|OBS|MacBook|Apple|Built-in|USB|Continuity|Logitech|HD)/,
  // capability fps 段 `1920x1080@[30.000000 60.000000]fps`
  /^\s*\[.*@ 0x[0-9a-f]+\] \d+(\.\d+)?x\d+(\.\d+)?@\[/i,
  // input/output stream meta
  /^\s*\[.*\] Stream #\d+:\d+/i,
  /^\s*Press \[q\]/i,
  /^\s*Output #\d+,/i,
  /^\s*Input #\d+,/i,
  /^\s*Metadata:/i,
  /^\s*Duration:/i,
  /^\s*encoder\s*:/i,
  /^\s*handler_name\s*:/i,
];

interface ScoredStderrLine {
  line: string;
  score: number;
  /** 行序号（0-based），同分时取后出现者（更接近死亡时刻）。 */
  index: number;
}

/** 把 raw stderr 拆行 → 过滤噪声 → 关键词打分 → 取 Top N。
 *  返回拼好的多行摘要字符串（已截断到 maxChars）。
 *
 *  特殊情况：
 *   - 完全没匹到关键词 → 退化为"最后 maxFallbackLines 行非噪声行"
 *   - 完全是噪声 / 空 → 返回 ''（调用方自己拼 "unknown error"）
 */
export function extractFfmpegStderrSummary(
  raw: string,
  opts: { maxLines?: number; maxChars?: number; maxFallbackLines?: number } = {},
): string {
  const maxLines = opts.maxLines ?? 5;
  const maxChars = opts.maxChars ?? 600;
  const maxFallbackLines = opts.maxFallbackLines ?? 3;

  if (!raw || raw.trim() === '') return '';

  const rawLines = raw.split(/\r?\n/).map((l) => l.trimEnd());
  const cleaned: ScoredStderrLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || line.length === 0) continue;
    if (FFMPEG_STDERR_NOISE.some((rx) => rx.test(line))) continue;
    // 去掉前缀的 [xxx @ 0x123] 让摘要更紧凑
    const stripped = line.replace(/^\s*\[[^\]]+@ 0x[0-9a-f]+\]\s*/i, '').trim();
    if (!stripped) continue;
    let score = 0;
    for (const { pattern, weight } of FFMPEG_STDERR_KEYWORDS) {
      if (pattern.test(stripped)) {
        if (weight > score) score = weight;
      }
    }
    cleaned.push({ line: stripped, score, index: i });
  }

  if (cleaned.length === 0) return '';

  // 取 score > 0 的 top N（同分时按 index 倒序——更接近死亡的行优先）；
  // 如果一条关键行都没有，退化为最后 maxFallbackLines 行
  const scored = cleaned.filter((c) => c.score > 0);
  let picked: ScoredStderrLine[];
  if (scored.length > 0) {
    scored.sort((a, b) => (b.score - a.score) || (b.index - a.index));
    picked = scored.slice(0, maxLines).sort((a, b) => a.index - b.index);
  } else {
    picked = cleaned.slice(-maxFallbackLines);
  }

  const text = picked.map((p) => p.line).join('\n');
  if (text.length <= maxChars) return text;
  // 超长时从尾部截，保留最后的致命信息
  return '…' + text.slice(text.length - maxChars + 1);
}

/** 组装最终给用户看的 ffmpeg 失败消息：固定头 `ffmpeg 录制失败
 *  (exit code=X signal=Y)` + 关键行抽取；如果抽取为空则附最后 200
 *  字符兜底。纯函数方便单测。 */
export function formatFfmpegExitError(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}): string {
  const head = `ffmpeg 录制失败 (exit code=${input.code} signal=${input.signal ?? 'null'})`;
  const summary = extractFfmpegStderrSummary(input.stderr);
  if (summary) return `${head}\n${summary}`;
  // 完全没关键行也没非噪声行 → 退到尾部裸切，但只切 200 而非 500
  const tail = (input.stderr ?? '').slice(-200).trim();
  return tail ? `${head}\n${tail}` : head;
}
