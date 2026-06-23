/**
 * R-REC-DESKTOP-AREA — recorder argv builder tests.
 *
 * 验证 [buildRecorderArgs](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/recorder.ts) 这把纯函数的契约：
 *   - darwin avfoundation：filter_complex 内含 crop=
 *   - win32 gdigrab：`-offset_x` / `-video_size` 原生区域
 *   - linux x11grab：`-i :0.0+X,Y` 原生区域
 *   - fps / 时长 / cursor 各自的开关
 *   - v2.3 gif-direct-only：永远 single-pass 直出 GIF，maxLongSide>0
 *     时 filter_complex 串入 scale 滤镜按最长边等比缩
 *
 * recorder.ts 间接 import electron.systemPreferences；stub 掉避免
 * node-only 环境 throw。binaries.ts 也走 electron app.getPath，一并 stub。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false, getAppPath: vi.fn(() => '/tmp') },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted') },
  screen: { getAllDisplays: vi.fn(() => []), getPrimaryDisplay: vi.fn(() => ({ id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 } })) },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []) }),
  shell: { openExternal: vi.fn() },
}));

const { buildRecorderArgs, toEvenSize, toEvenOffset, parseAvfoundationScreenDevices, extractFfmpegStderrSummary, formatFfmpegExitError } = await import('../../src/main/recorder');

const baseParams = {
  region: { displayId: 1, x: 100, y: 200, w: 640, h: 480 },
  mode: 'gif-direct' as const,
  fps: 15,
  maxDurationSec: 20,
  captureCursor: true,
  captureAudio: false,
  softMaxBytes: 2 * 1024 * 1024,
  maxBytes: 4 * 1024 * 1024,
  maxWidth: 720,
  // 默认 0 = 不缩放，让既有 crop 断言保持有效（区域 = 输出尺寸）。
  maxLongSide: 0,
};

describe('buildRecorderArgs (gif-direct only)', () => {
  it('darwin: emits avfoundation + filter_complex with crop, no audio when captureAudio=false', () => {
    const argv = buildRecorderArgs({
      platform: 'darwin',
      params: baseParams,
      avfoundationDeviceIndex: 1,
      outputPath: '/tmp/out.gif',
    });
    const joined = argv.join(' ');
    expect(joined).toContain('-f avfoundation');
    expect(joined).toContain('-framerate 15');
    expect(joined).toContain('-capture_cursor 1');
    expect(joined).toContain('-i 1:none');
    expect(joined).toContain('-filter_complex');
    expect(joined).toContain('crop=640:480:100:200');
    expect(joined).toContain('palettegen=stats_mode=single');
    expect(joined).toContain('paletteuse=new=1');
    expect(joined).toContain('-f gif');
    expect(joined).toContain('-t 20');
    expect(argv[argv.length - 1]).toBe('/tmp/out.gif');
  });

  it('darwin: captureAudio=true 在 gif-direct 下被忽略（GIF 没音轨）', () => {
    const argv = buildRecorderArgs({
      platform: 'darwin',
      params: { ...baseParams, captureAudio: true },
      avfoundationDeviceIndex: 2,
      outputPath: '/tmp/out.gif',
    });
    // 入参形如 `${idx}:none`，永远不出现 `${idx}:${idx}` 这种音频映射
    expect(argv.join(' ')).toContain('-i 2:none');
    expect(argv.join(' ')).not.toContain('-i 2:2');
  });

  it('darwin: throws without avfoundationDeviceIndex', () => {
    expect(() => buildRecorderArgs({
      platform: 'darwin',
      params: baseParams,
      outputPath: '/tmp/out.gif',
    })).toThrow(/avfoundationDeviceIndex/);
  });

  it('win32: emits gdigrab with offset + video_size + filter_complex (no crop prefix)', () => {
    const argv = buildRecorderArgs({
      platform: 'win32',
      params: baseParams,
      outputPath: 'C:\\tmp\\out.gif',
    });
    const joined = argv.join(' ');
    expect(joined).toContain('-f gdigrab');
    expect(joined).toContain('-offset_x 100');
    expect(joined).toContain('-offset_y 200');
    expect(joined).toContain('-video_size 640x480');
    expect(joined).toContain('-i desktop');
    expect(joined).toContain('-draw_mouse 1');
    expect(joined).toContain('-filter_complex');
    // win 的 filter graph 不应再加 crop（gdigrab 抓出来本来就是区域）
    const fcIdx = argv.indexOf('-filter_complex');
    expect(argv[fcIdx + 1]).not.toContain('crop=');
    expect(joined).toContain('-f gif');
  });

  it('linux: emits x11grab with screen offset syntax + filter_complex (no crop prefix)', () => {
    const argv = buildRecorderArgs({
      platform: 'linux',
      params: baseParams,
      outputPath: '/tmp/out.gif',
    });
    const joined = argv.join(' ');
    expect(joined).toContain('-f x11grab');
    expect(joined).toContain('-i :0.0+100,200');
    expect(joined).toContain('-video_size 640x480');
    expect(joined).toContain('-filter_complex');
    const fcIdx = argv.indexOf('-filter_complex');
    expect(argv[fcIdx + 1]).not.toContain('crop=');
    expect(joined).toContain('-f gif');
  });

  it('clamps fps to 1..60 (rounded int)', () => {
    const argv1 = buildRecorderArgs({
      platform: 'linux',
      params: { ...baseParams, fps: 0 },
      outputPath: '/tmp/out.gif',
    });
    expect(argv1.join(' ')).toContain('-framerate 1');
    const argv2 = buildRecorderArgs({
      platform: 'linux',
      params: { ...baseParams, fps: 999 },
      outputPath: '/tmp/out.gif',
    });
    expect(argv2.join(' ')).toContain('-framerate 60');
  });

  it('clamps maxDurationSec to 1..600 (rounded int)', () => {
    const argv1 = buildRecorderArgs({
      platform: 'linux',
      params: { ...baseParams, maxDurationSec: 0 },
      outputPath: '/tmp/out.gif',
    });
    expect(argv1.join(' ')).toContain('-t 1');
    const argv2 = buildRecorderArgs({
      platform: 'linux',
      params: { ...baseParams, maxDurationSec: 99999 },
      outputPath: '/tmp/out.gif',
    });
    expect(argv2.join(' ')).toContain('-t 600');
  });

  it('captureCursor=false sets capture_cursor / draw_mouse to 0', () => {
    const darwin = buildRecorderArgs({
      platform: 'darwin',
      params: { ...baseParams, captureCursor: false },
      avfoundationDeviceIndex: 1,
      outputPath: '/tmp/out.gif',
    });
    expect(darwin.join(' ')).toContain('-capture_cursor 0');
    const win = buildRecorderArgs({
      platform: 'win32',
      params: { ...baseParams, captureCursor: false },
      outputPath: 'C:\\tmp\\out.gif',
    });
    expect(win.join(' ')).toContain('-draw_mouse 0');
  });

  it('always includes -y and -f gif output, never libx264 / mp4', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const argv = buildRecorderArgs({
        platform,
        params: baseParams,
        avfoundationDeviceIndex: platform === 'darwin' ? 1 : undefined,
        outputPath: '/tmp/out.gif',
      });
      expect(argv).toContain('-y');
      expect(argv).toContain('-f');
      expect(argv).toContain('gif');
      expect(argv).not.toContain('libx264');
      expect(argv).not.toContain('-c:v');
      expect(argv).not.toContain('yuv420p');
      expect(argv).not.toContain('-movflags');
    }
  });

  /* ------------------------------------------------------------------ */
  /*  R-REC-DESKTOP-AREA #long-side-scale — maxLongSide 触发 scale 滤镜   */
  /* ------------------------------------------------------------------ */

  it('gif-direct: maxLongSide=800 在 split 之前串 scale 滤镜', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const argv = buildRecorderArgs({
        platform,
        params: { ...baseParams, maxLongSide: 800 },
        avfoundationDeviceIndex: platform === 'darwin' ? 1 : undefined,
        outputPath: '/tmp/out.gif',
      });
      const fcIdx = argv.indexOf('-filter_complex');
      expect(fcIdx).toBeGreaterThan(-1);
      const fc = argv[fcIdx + 1];
      // scale 必须在 split 之前出现
      const scalePos = fc.indexOf('scale=');
      const splitPos = fc.indexOf('split');
      expect(scalePos).toBeGreaterThan(-1);
      expect(splitPos).toBeGreaterThan(-1);
      expect(scalePos).toBeLessThan(splitPos);
      // 表达式中常数等于 800
      expect(fc).toContain('min(800,iw)');
      expect(fc).toContain('min(800,ih)');
    }
  });

  it('gif-direct: maxLongSide=600 / 1080 对应 expression 中常数等于 L', () => {
    for (const L of [600, 1080]) {
      const argv = buildRecorderArgs({
        platform: 'linux',
        params: { ...baseParams, maxLongSide: L },
        outputPath: '/tmp/out.gif',
      });
      const fcIdx = argv.indexOf('-filter_complex');
      const fc = argv[fcIdx + 1];
      expect(fc).toContain(`min(${L},iw)`);
      expect(fc).toContain(`min(${L},ih)`);
      // -2 保偶
      expect(fc).toContain('-2');
    }
  });

  it('gif-direct: maxLongSide<=0 不串 scale，filter graph 与旧版相同', () => {
    for (const longSide of [0, -1]) {
      const argv = buildRecorderArgs({
        platform: 'linux',
        params: { ...baseParams, maxLongSide: longSide },
        outputPath: '/tmp/out.gif',
      });
      const fcIdx = argv.indexOf('-filter_complex');
      const fc = argv[fcIdx + 1];
      expect(fc).not.toContain('scale=');
      // 仍然是 split + palettegen + paletteuse
      expect(fc).toContain('split');
      expect(fc).toContain('palettegen=stats_mode=single');
      expect(fc).toContain('paletteuse=new=1');
    }
  });

  it('gif-direct: 区域已小于 maxLongSide 时表达式仍含 min(L,iw) 由 ffmpeg 运行时自然 no-op', () => {
    // 区域 320x200, maxLongSide=800：表达式照写 min(800, 320) 由 ffmpeg 解出 320
    const argv = buildRecorderArgs({
      platform: 'linux',
      params: { ...baseParams, region: { displayId: 1, x: 0, y: 0, w: 320, h: 200 }, maxLongSide: 800 },
      outputPath: '/tmp/out.gif',
    });
    const fcIdx = argv.indexOf('-filter_complex');
    const fc = argv[fcIdx + 1];
    expect(fc).toContain('min(800,iw)');
    expect(fc).toContain('min(800,ih)');
  });
});

/* ====================================================================== */
/*  R-REC-DESKTOP-AREA #even-pixel — toEvenSize / toEvenOffset edge cases */
/* ====================================================================== */

describe('toEvenSize', () => {
  it('已是偶数：原样返回', () => {
    expect(toEvenSize(640)).toBe(640);
    expect(toEvenSize(2)).toBe(2);
  });
  it('奇数：向下取偶', () => {
    expect(toEvenSize(275)).toBe(274);
    expect(toEvenSize(481)).toBe(480);
    expect(toEvenSize(3)).toBe(2);
  });
  it('小于 2 / 浮点 / 负数：clamp 到 2', () => {
    expect(toEvenSize(0)).toBe(2);
    expect(toEvenSize(-5)).toBe(2);
    expect(toEvenSize(1.9)).toBe(2);
    expect(toEvenSize(2.7)).toBe(2);
  });
});

describe('toEvenOffset', () => {
  it('允许 0（合法 offset）', () => {
    expect(toEvenOffset(0)).toBe(0);
  });
  it('奇数：向下取偶', () => {
    expect(toEvenOffset(101)).toBe(100);
    expect(toEvenOffset(1)).toBe(0);
  });
  it('负数：clamp 到 0', () => {
    expect(toEvenOffset(-7)).toBe(0);
  });
});

describe('buildRecorderArgs — even-pixel applies to x/y too', () => {
  it('darwin: 奇数 region.x/y 也偶数化到 crop expression', () => {
    const argv = buildRecorderArgs({
      platform: 'darwin',
      params: { ...baseParams, region: { displayId: 1, x: 101, y: 203, w: 275, h: 223 } },
      avfoundationDeviceIndex: 1,
      outputPath: '/tmp/out.gif',
    });
    expect(argv.join(' ')).toContain('crop=274:222:100:202');
  });
  it('win32: 奇数 offset 偶数化到 -offset_x/-offset_y', () => {
    const argv = buildRecorderArgs({
      platform: 'win32',
      params: { ...baseParams, region: { displayId: 1, x: 101, y: 203, w: 275, h: 223 } },
      outputPath: 'C:\\tmp\\out.gif',
    });
    const j = argv.join(' ');
    expect(j).toContain('-offset_x 100');
    expect(j).toContain('-offset_y 202');
    expect(j).toContain('-video_size 274x222');
  });
  it('linux: 奇数 offset 偶数化到 :0.0+X,Y', () => {
    const argv = buildRecorderArgs({
      platform: 'linux',
      params: { ...baseParams, region: { displayId: 1, x: 101, y: 203, w: 275, h: 223 } },
      outputPath: '/tmp/out.gif',
    });
    const j = argv.join(' ');
    expect(j).toContain('-i :0.0+100,202');
    expect(j).toContain('-video_size 274x222');
  });
});

/* ====================================================================== */
/*  R-REC-DESKTOP-AREA #probe-device — parseAvfoundationScreenDevices     */
/*  五种 ffmpeg 输出格式 + macOS Sequoia 14.x+ 新 screen 段                */
/* ====================================================================== */

describe('parseAvfoundationScreenDevices', () => {
  it('典型 macOS 13 输出：video 段中含 Capture screen', () => {
    const out = `
[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] [1] Capture screen 0
[AVFoundation indev @ 0x123] [2] Capture screen 1
[AVFoundation indev @ 0x123] AVFoundation audio devices:
[AVFoundation indev @ 0x123] [0] MacBook Pro Microphone
`;
    const devs = parseAvfoundationScreenDevices(out);
    expect(devs).toEqual([
      { index: 1, label: 'Capture screen 0' },
      { index: 2, label: 'Capture screen 1' },
    ]);
  });

  it('macOS Sequoia 14.x+：屏幕设备移到独立 screen devices 段', () => {
    const out = `
[AVFoundation indev @ 0x456] AVFoundation video devices:
[AVFoundation indev @ 0x456] [0] FaceTime HD Camera
[AVFoundation indev @ 0x456] [1] iPhone Camera
[AVFoundation indev @ 0x456] AVFoundation screen devices:
[AVFoundation indev @ 0x456] [2] Capture screen 0
[AVFoundation indev @ 0x456] [3] Capture screen 1
[AVFoundation indev @ 0x456] AVFoundation audio devices:
[AVFoundation indev @ 0x456] [0] MacBook Pro Microphone
`;
    const devs = parseAvfoundationScreenDevices(out);
    expect(devs).toEqual([
      { index: 2, label: 'Capture screen 0' },
      { index: 3, label: 'Capture screen 1' },
    ]);
  });

  it('Continuity Camera 干扰：iPhone Camera 不应被当成屏幕', () => {
    const out = `
[AVFoundation indev @ 0x789] AVFoundation video devices:
[AVFoundation indev @ 0x789] [0] FaceTime HD Camera
[AVFoundation indev @ 0x789] [1] iPhone Camera
[AVFoundation indev @ 0x789] [2] OBS Virtual Camera
[AVFoundation indev @ 0x789] [3] Capture screen 0
`;
    const devs = parseAvfoundationScreenDevices(out);
    expect(devs).toEqual([{ index: 3, label: 'Capture screen 0' }]);
  });

  it('空输出：返回 []（让上层走显式失败路径）', () => {
    expect(parseAvfoundationScreenDevices('')).toEqual([]);
    expect(parseAvfoundationScreenDevices('totally unrelated stderr noise')).toEqual([]);
  });

  it('行尾带 capability 描述：仍能正确抽 index 与 label', () => {
    // 部分 ffmpeg build 在 list_devices 时把分辨率/帧率写在同一行
    const out = `
[AVFoundation indev @ 0xaaa] AVFoundation video devices:
[AVFoundation indev @ 0xaaa] [0] FaceTime HD Camera (1920x1080@30.00 fps)
[AVFoundation indev @ 0xaaa] [1] Capture screen 0 (3024x1964@60.00 fps)
[AVFoundation indev @ 0xaaa] AVFoundation audio devices:
[AVFoundation indev @ 0xaaa] [0] MacBook Pro Microphone
`;
    const devs = parseAvfoundationScreenDevices(out);
    expect(devs).toHaveLength(1);
    expect(devs[0].index).toBe(1);
    expect(devs[0].label).toMatch(/^Capture screen 0/);
  });

  it('去重：同 index 在两段出现只保留首次', () => {
    const out = `
[AVFoundation indev @ 0xbbb] AVFoundation video devices:
[AVFoundation indev @ 0xbbb] [2] Capture screen 0
[AVFoundation indev @ 0xbbb] AVFoundation screen devices:
[AVFoundation indev @ 0xbbb] [2] Capture screen 0
`;
    const devs = parseAvfoundationScreenDevices(out);
    expect(devs).toHaveLength(1);
    expect(devs[0].index).toBe(2);
  });
});

/* ====================================================================== */
/*  R-REC-DESKTOP-AREA #error-msg — extractFfmpegStderrSummary             */
/*  ffmpeg stderr 关键行抽取，把 fps/capability/build banner 噪声过滤掉    */
/* ====================================================================== */

describe('extractFfmpegStderrSummary', () => {
  it('空 / 全空白：返回空串（让 caller 走兜底）', () => {
    expect(extractFfmpegStderrSummary('')).toBe('');
    expect(extractFfmpegStderrSummary('   \n\n  \n')).toBe('');
  });

  it('只有 ffmpeg banner 噪声 / build configuration：返回空串', () => {
    const out = `
ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers
  built with Apple clang version 15.0.0
  configuration: --prefix=/opt/homebrew --enable-gpl
  libavutil      59. 39.100 / 59. 39.100
  libavcodec     61. 19.100 / 61. 19.100
`;
    expect(extractFfmpegStderrSummary(out)).toBe('');
  });

  it('Permission denied：抽到权限关键行（最高权重）', () => {
    const out = `
ffmpeg version 7.1
[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] [1] Capture screen 0
[AVFoundation indev @ 0x123] Failed to create AV capture input device: You don't have permission. Permission denied
`;
    const s = extractFfmpegStderrSummary(out);
    expect(s).toMatch(/permission denied/i);
    expect(s).not.toMatch(/configuration/i);
    expect(s).not.toMatch(/built with/i);
  });

  it('Capture screen N not found：抽到 not found 关键行，忽略前面 fps 噪声', () => {
    const out = `
[AVFoundation @ 0xabc] 1920x1080@[30.000000 30.000000]fps
[AVFoundation @ 0xabc] 1920x1080@[60.000000 60.000000]fps
[AVFoundation @ 0xabc] 640x480@[1.000000 60.000000]fps
[AVFoundation @ 0xabc] Selected video device: Capture screen 5
[AVFoundation @ 0xabc] Capture screen 5 not found.
`;
    const s = extractFfmpegStderrSummary(out);
    expect(s).toMatch(/not found/i);
    expect(s).not.toMatch(/fps/);
    expect(s).not.toMatch(/30\.000000/);
  });

  it('Selected framerate not supported：抽到帧率不兼容关键行', () => {
    const out = `
[AVFoundation @ 0x111] 640x480@[1.000000 60.000000]fps
[AVFoundation @ 0x111] Selected framerate (15.000000) is not supported by the device.
`;
    const s = extractFfmpegStderrSummary(out);
    expect(s).toMatch(/Selected framerate.*not supported/i);
  });

  it('多关键行：按权重排序后再按时间顺序输出，保留全部 top N', () => {
    const out = `
some noisy fps line ignored
[X @ 0x1] error: Invalid argument
[X @ 0x1] some unrelated warning
[X @ 0x1] Permission denied
`;
    const s = extractFfmpegStderrSummary(out, { maxLines: 3 });
    // 两个高权重关键行都应出现
    expect(s).toMatch(/permission denied/i);
    expect(s).toMatch(/invalid argument/i);
    // 行间用换行连接（多行格式）
    expect(s.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('退化路径：完全没匹中关键词但有非噪声行，取最后 N 行兜底', () => {
    const out = `
some random log line A
some random log line B
some random log line C
some random log line D
`;
    const s = extractFfmpegStderrSummary(out, { maxFallbackLines: 2 });
    expect(s).toContain('line C');
    expect(s).toContain('line D');
    expect(s).not.toContain('line A');
  });

  it('行内前缀 [xxx @ 0x123] 被剥离，让摘要紧凑', () => {
    const out = `[AVFoundation indev @ 0xabc] Permission denied`;
    const s = extractFfmpegStderrSummary(out);
    expect(s).toBe('Permission denied');
  });

  it('超长摘要被截到 maxChars（保留尾部，加 … 前缀）', () => {
    const longErr = Array.from({ length: 50 }, (_, i) => `[X @ 0x1] error: case ${i}`).join('\n');
    const s = extractFfmpegStderrSummary(longErr, { maxLines: 50, maxChars: 100 });
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.startsWith('…')).toBe(true);
  });
});

describe('formatFfmpegExitError', () => {
  it('正常 exit code + 关键行：head + summary', () => {
    const msg = formatFfmpegExitError({
      code: 1,
      signal: null,
      stderr: '[X @ 0x1] Permission denied\n',
    });
    expect(msg).toContain('exit code=1');
    expect(msg).toContain('signal=null');
    expect(msg).toContain('Permission denied');
    expect(msg).toContain('\n');
  });

  it('全噪声 stderr：head + 尾部 200 字符兜底', () => {
    const noise = 'ffmpeg version 7.1\n  configuration: --enable-gpl\n  libavcodec 61\n';
    const msg = formatFfmpegExitError({ code: 1, signal: null, stderr: noise });
    expect(msg).toContain('exit code=1');
    // 没有关键行抽取结果，但有 tail 兜底
    expect(msg).toContain('libavcodec');
  });

  it('空 stderr：只有 head', () => {
    const msg = formatFfmpegExitError({ code: -1, signal: 'SIGSEGV' as NodeJS.Signals, stderr: '' });
    expect(msg).toBe('ffmpeg 录制失败 (exit code=-1 signal=SIGSEGV)');
  });

  it('signal=null 时显示为字面 null 不报错', () => {
    const msg = formatFfmpegExitError({ code: 0, signal: null, stderr: '' });
    expect(msg).toContain('signal=null');
  });
});
