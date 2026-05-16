# R-26 — Spec failure vs runtime failure split, and resolving-stage progress

**Status**: ENFORCED · Round 43 (user-facing UX feedback)

## Origin

Round-43 user feedback (verbatim, Chinese):

1. "视频解析中的时候,你应该给一个解析进度在 ui 上,放一个红色感叹号太敏感了,换成黄色比较合理"
2. "如图这种失败不应该是重试,重试是转换失败,运行失败,网络失败的,这种失败属于是规格的,按键应该是强制允许"

The attached screenshot showed a `0px (2).gif` row labelled FAILED with the
error string `… longest side capped at 800px would shrink the short side
to 299px (< minSize 450px) …` — a `AspectRatioConstraintError` —
followed by a "重试" button. Re-running it with the same options would
fail identically. The user also pointed out that the static red
exclamation-mark / red chip used during embed resolution made the UI
look broken for the 5–15s a `yt-dlp` round-trip takes.

## Forced rules (do NOT regress)

### 1. Amber, not red, for non-fatal UX states

* `.thumb-error` and `.thumb-error-center` in
  [styles.css](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css)
  must use `var(--warn)` / `rgba(240,198,116,*)` (amber) not
  `var(--bad)` / `rgba(239,91,110,*)` (red). Thumbnail failure is an
  independent side-channel; it does NOT block conversion. Painting it
  red was over-dramatic and trained users to ignore real errors.
* Reverse assertion: a future contributor must NOT "harmonize" these
  back to red because the rest of the failure UI is red. Read this
  rule first.

### 2. Resolving chip is staged, not static

* `MediaGrid` exposes a `ResolvingChip` sub-component fed by
  `useResolveStageLabel(active)` in
  [MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx).
* Stage labels (`RESOLVE_STAGE_LABELS`) advance every 1500ms and
  **saturate** on the last stage — they must NOT loop, since looping
  visually feels like a restart and lies about progress.
* The chip carries `role="status"` + `aria-live="polite"` for SR users.
* We do NOT parse `yt-dlp` stdout to compute a real percent — that was
  evaluated and rejected as a much larger surface for marginal value.
  Stages are intentionally heuristic.

### 3. Spec failures are typed end-to-end

* `TaskProgress.errorCode` is a **closed string-literal union** in
  [shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts).
  Today: `'ASPECT_RATIO_OUT_OF_RANGE'`. Adding new categories MUST
  extend the union, never widen to plain `string`.
* `errorMeta` carries the numeric context (`origW`, `origH`, `minSide`,
  `maxSide`, `shortSideAtMax`) so the UI can render a human tooltip
  without re-parsing English error messages.
* `processor.ts` batch top-level `catch` maps
  `AspectRatioConstraintError` to an emit with `errorCode` + `errorMeta`;
  every other `Error` falls through to the original `error: msg` path.
* Reverse assertion: a contributor must NOT lossy-stringify the error at
  the IPC boundary. The class-based `instanceof` test happens main-side
  precisely because IPC drops `Error` subclass identity.

### 4. `forceAllowSmallSide` is private and single-shot

* `ProcessOptions.forceAllowSmallSide?: boolean` is **per-dispatch**.
  `App.onProcessOne(media, override?)` injects it only into that one
  call's `optBase`; the component-level `options` object is untouched.
  This guarantees the next batch / next task uses the original
  `minSize` again. Reverse assertion: contributors must NOT "promote"
  this to a global setting / persisted preference — that would silently
  bypass quality guardrails forever.
* `sanitizeOptions` (main-side) accepts the field **only if
  `obj.forceAllowSmallSide === true`** — strict boolean equality, NOT
  truthy. A renderer regression that sends the string `'true'`, the
  number `1`, or `{ value: true }` must be silently dropped.
* `processor.ts` uses the flag at the two `AspectRatioConstraintError`
  throw sites (compressGif and the video `initialWidth` IIFE) to bypass
  the throw, but logs an `aspect-ratio-bypass` phase failure /
  `log(...)` line so the diagnostic record still exists.

### 5. "强制允许" and "重试" are mutually exclusive

* In
  [TaskTable.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx)
  a row whose `errorCode === 'ASPECT_RATIO_OUT_OF_RANGE'` shows
  **only** the "强制允许" button (`force-allow-btn` class). Other
  failures show **only** the "重试" button. Both buttons MUST never
  render in the same row.
* If a host renders TaskTable without wiring `onForceAllow`, a spec
  failure renders **no button at all**. We deliberately do NOT fall
  back to "重试" — falling back would re-create the original UX bug
  (re-running a spec violation verbatim is meaningless).

## Test coverage

* [tests/renderer/TaskTable.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/TaskTable.test.tsx) — `TaskTable R-26 force-allow vs retry split` describe block:
  * Spec failure renders `强制允许`, NOT `重试`.
  * Runtime failure renders `重试`, NOT `强制允许`.
  * Click on `强制允许` calls `onForceAllow(media)` exactly once and does NOT call `onRetry`.
  * Spec failure with missing `onForceAllow` renders neither button (defensive).
* [tests/renderer/MediaGrid-resolving.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/MediaGrid-resolving.test.tsx) —
  * First stage label, role=status, advances on 1.5s tick, saturates
    on last stage, uses `card-embed-tag.resolving` (amber) class +
    `card-embed-spinner` element.
  * Resolving chip is suppressed when `resolveError` is set (failure
    chip path is unaffected).

## Related files

* [src/renderer/styles.css](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css)
* [src/renderer/components/MediaGrid.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/MediaGrid.tsx)
* [src/renderer/components/TaskTable.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/TaskTable.tsx)
* [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
* [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts)
* [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) (sanitizeOptions)
* [src/main/processor.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/processor.ts)
