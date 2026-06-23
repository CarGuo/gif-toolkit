# R-COMPRESS-V2 — compressLoop / gifsicleMethod coherence

**Status**: ratified · **Source**: 2026-XX 全面 review 第 1 轮
"adaptiveStartLossy 双份 + Phase B 早退过冲 + color-reduction 与 doc
不一致 + Phase C/D 双解码缺注释 + recordBest soft-band 漂大"。

## 一句话

`compressLoop` 内的可调参数与 `gifsicleMethod` 的命令行分支必须**与
[processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)
导出的纯函数 / [ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
注释的方法语义保持 single source of truth**。任何"内联拷贝纯函数 +
独立调阈值" / "method picker 实际行为依赖外部 opts 偏移自己 doc"的写法
都会重蹈 C-01..C-05 覆辙。

## 五件修复（C-01..C-05）

### C-01 — adaptiveStartLossy 必须只有一处

- [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
  内**不得**内联 `adaptiveStartLossy(curMB, target)` 的"if ratio<=… return …"
  阶梯。**必须** `import { adaptiveStartLossy } from './processor-utils'`，
  以 [processor-utils.ts#L111-L119](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts#L111-L119)
  为唯一定义。
- 阈值与返回值改动**只在 processor-utils.ts 改一处**；
  [tests/main/processor-utils.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/processor-utils.test.ts)
  `describe('adaptiveStartLossy')` 是回归基线。

### C-02 — Phase B 早退必须对称

- `lossySearch` 的"first try 已满足"判断**必须**走
  [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)
  导出的 `decideEarlyAccept(lastSize, target, tol?)`。
- 三种合法返回：`'accept'` / `'refine-shrink'` / `'refine-grow'`；
  调用方必须能处理 grow 路径（即"产物比 target 小过头，反向降 lossy
  找回质量"）。
- ❌ 不得回到旧的 `if (lastSize <= target) return lastSize;` ——
  这等于对欠压零容忍，与 ACCEPT_TOL = ±12 % 的语义直接冲突，
  实测会让 best=2MB 的请求落到 0.5-1.0 MB 区间，肉眼可见劣化。

### C-03 — gifsicleMethod 的 picker 是 contract，不被 opts 反转

[ffmpeg.ts#L854-L1007](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts#L854-L1007)
的 `'color-reduction'` 和 `'color-dither'` 是**互为 A/B 对照**的两个方法：

- `'color-reduction'` **永远** emit `--no-dither`，与 `opts.dither` 无关。
- `'color-dither'` **永远** emit `--dither=floyd-steinberg` 或
  `--dither=ordered`（当 `opts.dither='none'` 时回退到 floyd-steinberg，
  因为"显式选 dither 后又说 none"是矛盾的，按 picker 命名取默认）。
- ❌ 不得让 `'color-reduction'` 在 colors<256 && opts.dither!=='none' 时
  silently 加 dither —— 这等于让两个 picker 在 UI 默认条件下输出同样的
  argv，A/B 体验消失，picker 失去意义。

### C-04 — Phase C/D resize 必须从 ORIGINAL `inputGif` 解码

`compressLoop` 的 Phase C
([processor.ts#L676-L688](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L676-L688))
与 Phase D
([processor.ts#L738-L745](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts#L738-L745))
调用 `imageResizeKeepAspect` 时**必须**传 `inputGif`，**不得**传 `curSrc`。

- 原因：`curSrc` 可能是 Phase B 已经做过 gifsicle `--lossy=N`/`--colors=K`
  的中间产物；再去 resize 等于"已损质再二次解码＋调色板再量化"，
  每多一次会肉眼可见地崩。
- sharp/ffmpeg 从原图重新解码代价是多一次 decode，但**严格更优 quality/byte**。
- ❌ 不得"refactor 简化"把 `inputGif` 换成 `curSrc` —— 必须保留 inline
  注释 `// C-04 — deliberately decode from the ORIGINAL inputGif`。

### C-05 — recordBest 必须 band-tiered + smaller-wins

- 选择 "better candidate" 的判定**必须**走
  [processor-utils.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor-utils.ts)
  导出的 `shouldReplaceBest(current, incoming, softMB, hardMB)`。
- 三档优先级：under-soft > under-hard > over-hard；同档**取更小**；
  tie 时**保留现有 best**（稳定性）。
- ❌ 不得复活旧的"已 underSoft 后 LARGER 替换 best"逻辑 —— 这会让 best
  从 1.4MB 漂到 1.99MB，浪费 soft cap 的全部用意。

## 验证

- 必跑：`npm run typecheck` + `npm run lint` + `npm run test:fast`
  （`tests/main/processor-utils.test.ts` 包含 `describe('decideEarlyAccept')`、
  `describe('shouldReplaceBest')`，`tests/main/gifsicleMethod.test.ts` 包含
  4 个 `(C-03)` case 锁定 picker 不变量）。
- 改动到 [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
  / [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts)
  的 `gifsicleMethod` 还需 `npm run test:e2e:smoke`（AGENTS.md §3 第 4 步）。

## 关联

- R-04 — 四阶段管线总框架
- R-05 — soft / hard 双目标语义
- R-12 — 不准为让测试通过而改测试
- R-16 — 新功能 / bug 修复必须随测试
- R-81 — gifsicle 4 旋钮全链路；C-03 是它的 picker 维度补丁
- R-82 — 双源 / barrel 的反面教材；C-01 是它的 in-file 版本
