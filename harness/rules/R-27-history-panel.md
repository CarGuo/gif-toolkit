# R-27 — Persistent history panel, per-record output dir, single-item re-run

**Status**: ENFORCED · Round 44 (user-facing UX feedback)

## Origin

Round-44 user feedback (verbatim, Chinese):

> 增加历史任务管理页面,每次解析有历史记录,可以再二次处理,每个历史页面还可以打开自己的结果目录

Two follow-up `AskUserQuestion` answers narrowed the scope:

1. **二次处理形态** — 「逐条重跑」 (per-media re-run, NOT a wholesale
   "restore the run into the home view" flow). The user wants to
   poke at *one* asset from an old session without re-sniffing the
   page.
2. **历史保留上限** — 「最近 30 条」, hard cap, FIFO-evicted. We
   intentionally don't go higher: the records embed full
   `SniffedMedia[]` and `ProcessOptions`, so unbounded growth would
   eventually breach the ~5MB localStorage quota.

## Forced rules (do NOT regress)

### 1. localStorage shape: versioned key, no binary blobs

* Key is `giftk.history.v1` —
  [HISTORY_STORAGE_KEY](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useHistory.ts#L35-L36).
  Future schema migrations bump the suffix; old code paths must
  never silently re-interpret a `v2` blob as `v1`.
* Records store **URLs only** for thumbnails / posters — never bytes,
  never base64, never blob-urls. Anything binary belongs on disk
  under the batch's outputDir, NOT in browser storage.
* `readAll()` filters out malformed entries field-by-field
  ([lines 83-90](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useHistory.ts#L83-L90))
  so a partially corrupted blob doesn't crash the panel.
* `writeAll()` swallows quota exceptions silently — history is a
  convenience, never a hard dependency. Reverse-assertion: do NOT
  surface `QuotaExceededError` to the user as a toast/alert.

### 2. mergeProgressIntoRecord: monotonic terminal status

* See
  [mergeProgressIntoRecord](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useHistory.ts#L188-L208).
* Once a task reaches `done | failed | cancelled | skipped`, a later
  emit with a non-terminal status (e.g. a stale `converting` event
  that was queued before `done` reached the renderer) MUST NOT
  overwrite it. Reverse-assertion: any code path that calls
  `setHistory(... task: 'pending')` after a `done` emit is a bug.
* Outputs are deduped via `new Set([...prev, ...next])` so the same
  file path doesn't appear twice in the per-record table.

### 3. registerOutputDir: never throw

*
  [ipcMain.handle('app:registerOutputDir')](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L426-L467)
  validates twice:
  * `statSync(p).isDirectory()` — the path on disk still exists and
    is a directory (the user might have moved/deleted the folder
    manually);
  * `underDefault(norm) || underAllowed(norm)` — the path is a
    descendant of either the system default user folder or one
    that's already been allowed in this session.
* On any failure (missing dir, outside-jail, IPC race), it returns
  `{ ok: false }`. **It MUST NOT throw**, because the renderer
  hydration loop calls it for every persisted history entry on
  mount; one bad record would otherwise nuke the whole history
  panel.
* Reverse-assertion: the body of the handler never has a bare
  `throw` outside a `try { } catch { }` that converts to
  `{ ok: false }`.

### 4. HistoryPanel is presentational only

*
  [HistoryPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/HistoryPanel.tsx)
  has zero direct dependencies on `localStorage` or `window.giftk`.
  It takes a `history: HistoryRecord[]` and five callbacks. This
  one-way data-flow makes it trivial to unit-test
  ([HistoryPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/HistoryPanel.test.tsx))
  and to slot into Storybook later.
* Reverse-assertion: `import` of `useHistory` (the hook) inside
  `HistoryPanel.tsx` is a layering violation.

### 5. "重跑" disabled with an actionable tooltip

* For images: `disabled={true}` + tooltip `image 不支持处理` — image
  conversion has no pipeline today, so re-run would silently
  no-op.
* For embeds whose direct URL was never resolved at sniff time:
  `disabled={true}` + tooltip `该 embed 当时未解析直链,无法直接重跑`.
  The user is expected to re-sniff the page if they want to retry
  the embed resolution; we do NOT re-trigger `yt-dlp` from history.
* For everything else: enabled, and clicking it dispatches the
  single media via `onReprocessOne(rec, m)`, which uses the
  **snapshotted** `rec.options` — not the current form values.
  This matches the user's mental model of "回到那次处理时的设置".

### 6. Active record id lives in a ref, not state

*
  [activeHistoryIdRef](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx#L59-L60)
  is a `useRef`, not `useState`. We don't want to re-render the
  whole tree on every progress event just to update which record
  the next emit lands in.
* Sniff success points the ref at the new record id. Sniffs that
  return only warnings (timeout / parse error) reset the ref to
  `null` so subsequent stray progress events don't accidentally
  splice into an unrelated record.

## Files of record

* [src/renderer/components/useHistory.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/useHistory.ts)
* [src/renderer/components/HistoryPanel.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/HistoryPanel.tsx)
* [src/main/index.ts (registerOutputDir)](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts#L426-L467)
* [src/preload/index.ts (registerOutputDir bridge)](file:///Users/guoshuyu/workspace/gif-toolkit/src/preload/index.ts#L67-L74)
* [src/renderer/App.tsx (mount hydrate, sniff push, dispatchBatch / onProcessOne write-back, tab switcher, reprocess callback)](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
* [src/renderer/styles.css (R-27 section)](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/styles.css#L1072-L1331)
* [tests/renderer/useHistory.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/useHistory.test.ts)
* [tests/renderer/HistoryPanel.test.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/tests/renderer/HistoryPanel.test.tsx)
