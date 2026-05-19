# R-81 — Surface gifsicle optimize knobs (lossy / colors / -O / dither)

**Status**: ENFORCED · Round 67 (user-facing functional gap)

## Origin

Round-67 user feedback (verbatim, Chinese), with screenshots of
[ManualOptimizeModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ManualOptimizeModal.tsx)
and
[OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx):

> 这些处理的地方,为什么都没有 gif optimize,这个不是很重要的能力啊?

Background: the GIF pipeline had been calling `gifsicle -O3
--lossy=N --colors=N` internally for many rounds, but **none of the
four knobs were exposed to the user**. The "更狠压" preset in
ManualOptimizeModal only moved `maxBytes / fps / maxWidth`, never
touched `lossy / colors`. The follow-up `AskUserQuestion` decided to
ship the **full set of four knobs** (lossy ceiling, colors floor,
`-O` lock, dither lock) rather than a partial fix.

## Forced rules (do NOT regress)

### 1. Type sources of truth: literals + clamped ranges

* Literal unions and constants live in
  [src/shared/types/process.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/process.ts):
  * `GifOptimizeLevel = 1 | 2 | 3` (`-O1` / `-O2` / `-O3`)
  * `GifDither = 'none' | 'floyd-steinberg' | 'ordered'`
  * `GIF_OPTIMIZE_LEVELS` / `GIF_DITHER_MODES` arrays drive every
    UI dropdown (single source of truth — DO NOT inline `[1,2,3]`
    in renderer code).
  * `GIF_LOSSY_MAX = 200` / `GIF_COLORS_MIN = 2` /
    `GIF_COLORS_MAX = 256` — clamp ceilings used in every layer.
* `ProcessOptions` adds 4 optional fields: `lossyCeiling?`,
  `colorsFloor?`, `optimizeLevel?`, `dither?`.
  `DEFAULT_OPTIONS` = `{ lossyCeiling: 200, colorsFloor: 2,
  optimizeLevel: 3, dither: 'floyd-steinberg' }` — the legacy
  behaviour pre-R-81. Reverse-assertion: do NOT change defaults to
  something more aggressive globally; that's what
  ManualOptimizeModal presets are for.
* [src/shared/types/toolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/toolbox.ts)
  `ToolboxParams` mirrors the same 4 fields so the toolbox
  (manual-only path) and the main pipeline share the same vocabulary.

### 2. Ceiling vs lock semantics — DO NOT fuse them

* `lossyCeiling` and `colorsFloor` are **bounds for the adaptive
  search** in
  [compressLoop](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts):
  * `lossyCeiling` is the **upper bound** of `--lossy=N` Phase B
    binary search (algorithm may pick anything ≤ ceiling).
  * `colorsFloor` is the **lower bound** of `--colors=N` Phase C
    geometric shrink (algorithm may stop at any value ≥ floor).
* `optimizeLevel` and `dither` are **locks** — every gifsicle
  invocation in the run uses exactly the user-supplied value, no
  per-phase override.
* Reverse-assertion: do NOT pass `lossyCeiling` to gifsicle as a
  literal `--lossy=ceiling`; that defeats the whole point of the
  adaptive search. The algorithm explores `[0..ceiling]` and picks
  the smallest that hits target size.

### 3. gifsicleOptimize signature — opts wins, defaults preserve legacy

* [gifsicleOptimize](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts#L495-L552)
  signature: `(input, output, lossy, colors, signal?, opts?: {
  optimizeLevel?: GifOptimizeLevel; dither?: GifDither })`.
* Emits `-O${level}` (default 3 when opts missing).
* When `colors < 256`: emits `--dither=floyd-steinberg` /
  `--dither=ordered` / `--no-dither` based on `dither`. When
  `colors === 256` no dither flag is needed (no quantization).
* Reverse-assertion: do NOT hardcode `-O3` anywhere; do NOT skip
  the `colors < 256` guard around dither (gifsicle warns about
  no-op flags when palette is full).

### 4. compressLoop guard rails — clamp before cache key

* `compressLoop` reads `lossyCeiling` / `colorsFloor` /
  `optimizeLevel` / `dither` from options at top, declares
  `clampLossy(n)` / `clampColors(n)` closures.
* Every `tryOptimize(lossy, colors)` call **must** clamp BEFORE
  building the dedup hash key — otherwise two different user-typed
  values that clamp to the same effective pair would generate two
  cache entries and waste a gifsicle invocation.
* Each tryOptimize call passes `{ optimizeLevel, dither }` through
  to gifsicleOptimize.
* `detail` log line includes `-O${level} dither=${dither}` for
  diagnostics. The `hasExplicit` quick-path (when caller already
  picked exact lossy/colors) goes through the same propagation
  chain.

### 5. IPC sanitization — main process is the last fence

* [main/index.ts sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts)
  must clamp all 4 fields:
  * `lossyCeiling` ∈ `[0, GIF_LOSSY_MAX]`
  * `colorsFloor` ∈ `[GIF_COLORS_MIN, GIF_COLORS_MAX]`
  * `optimizeLevel` ∈ `GIF_OPTIMIZE_LEVELS` (closed enum, fall back
    to default 3 on unknown)
  * `dither` ∈ `GIF_DITHER_MODES` (closed enum, fall back to
    `'floyd-steinberg'` on unknown)
* Same applies to `sanitizeToolboxParams` for the manual-only path.
* Reverse-assertion: do NOT trust renderer values; a malformed
  payload from a compromised preload bridge could otherwise crash
  gifsicle with a non-numeric flag.

### 6. UI surface — three places must agree

* **OptionsForm advanced drawer**: a collapsible
  `<details className="advanced-gif">` block at the bottom of
  [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx),
  with 4 controls in this order: lossy ceiling (NumField 0..200
  step 5) → colors floor (NumField 2..256 step 2) → `-O` level
  select → dither select. The drawer is collapsed by default to
  avoid intimidating casual users.
* **ManualOptimizeModal**: same 4 controls, plus the 4 preset
  chips (`size` / `fps` / `harder` / `fidelity`) **must actually
  move lossy/colors now**:
  * `harder` → `lossyCeiling: 160, colorsFloor: 64` (more
    aggressive search subspace)
  * `fidelity` → `lossyCeiling: 20, colorsFloor: 256` (highest
    quality subspace; effectively disables lossy)
  * `size` / `fps` → leave lossy/colors unset, let adaptive run
    free.
* **App.tsx propagation**: both
  [onProcessOne](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
  override and `onManualOptimizeConfirm` must forward the 4
  fields with defensive `typeof` checks + clamps before they
  reach the IPC layer.
* Reverse-assertion: do NOT add the 4 controls to one surface but
  not the others. Either all three places carry them or it's a
  regression.

### 7. PRESETS lock conventions

* Use `lossyCeiling` / `colorsFloor` (not direct lock values) when
  building preset overrides. The presets are about **shaping the
  adaptive search subspace**, not pinning a single gifsicle
  invocation.
* When a preset wants to disable lossy entirely, set
  `lossyCeiling: 20` (effectively "almost no lossy"), NOT
  `lossyCeiling: 0` — `0` would force gifsicle to skip the
  `--lossy` flag altogether, which is a different code path that
  the loop's binary search isn't tuned for.

### 8. Tests + smoke checklist

* The clamp helpers must have unit tests (range bounds,
  out-of-range fall-through to defaults, NaN / Infinity
  rejection).
* `gifsicleOptimize` integration test: assert `-O2` and
  `--dither=ordered` actually appear in the spawned argv when
  `opts: { optimizeLevel: 2, dither: 'ordered' }` is passed.
* SOP step 5 (R-80 smoke) still applies: any change here that
  touches the IPC contract must run `npm run dev` once and
  verify `gifsicle: using @343dev/gifsicle` log + at least one
  successful `tryOptimize lossy=N colors=N -O3 dither=fs detail`
  emit before merging.

## Reverse rules — what NOT to do

* DO NOT lower `DEFAULT_OPTIONS.lossyCeiling` below 200 to "make
  it pre-compress harder by default". Defaults are the
  pre-R-81 behaviour; presets are the place to be aggressive.
* DO NOT bypass `clampLossy / clampColors` and pass raw user
  values straight to gifsicle. The clamp must run before the
  cache hash key.
* DO NOT add a 5th knob (e.g. `interlace`, `careful`) without
  going through the same five-layer review (types → sanitize →
  gifsicleOptimize → UI in 3 places → propagation). Half-wired
  knobs are exactly the bug R-81 fixed.
* DO NOT make `optimizeLevel` or `dither` "smart" (e.g.
  auto-pick `-O1` for small files). They are explicit locks; the
  adaptive search is for `lossy/colors`, not for `-O/dither`.

## Anchors

| File | What lives here |
|---|---|
| [src/shared/types/process.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/process.ts) | `GifOptimizeLevel` / `GifDither` literals + `GIF_*` constants + `ProcessOptions` 4 fields + `DEFAULT_OPTIONS` |
| [src/shared/types/toolbox.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types/toolbox.ts) | `ToolboxParams` mirroring 4 fields |
| [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) | `sanitizeOptions` + `sanitizeToolboxParams` clamp |
| [src/main/ffmpeg.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ffmpeg.ts#L495-L552) | `gifsicleOptimize` signature + `-O${level}` / dither emit |
| [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts) | `compressLoop` clamp closures + `tryOptimize` propagation + `toolboxParamsToProcessOptions` mapping + `hasExplicit` path |
| [src/renderer/components/OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) | "advanced GIF optimize" collapsible drawer |
| [src/renderer/components/ManualOptimizeModal.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/ManualOptimizeModal.tsx) | 4 controls + PRESETS that actually move lossy/colors |
| [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx) | `onProcessOne` override + `onManualOptimizeConfirm` propagation |
