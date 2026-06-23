/**
 * useGlobalDropZone — extracts the window-level drag-over / drop
 * fallback that lived inline in App.tsx (lines 814-852 of the
 * pre-Step-11B blob).
 *
 * Behaviour
 * ---------
 * On the **home** view (and ONLY the home view) we attach a
 * window-level `dragover` + `drop` pair so a user can drop a media
 * file anywhere on the page and have it routed into
 * `runOfflineImport`. The toolbox / history / uploads tabs each own
 * their own drop targets (e.g. ToolboxPanel.handleDrop) and would
 * fight with a global listener — which is exactly the cross-tab
 * pollution this skip-on-non-home behaviour fixes.
 *
 * The handlers preserve the exact semantics of the original inline
 * implementation:
 *   - `dragover` — only react if the drag actually carries Files
 *     (so dragging text or a div around the page doesn't change the
 *     cursor). Setting `dropEffect = 'copy'` is what makes the OS
 *     show the green "drop here" badge.
 *   - `drop` — short-circuit on `e.defaultPrevented` (R-68: a child
 *     React onDrop already consumed the drop and we'd otherwise
 *     duplicate the import). Then peek at the Electron-only
 *     non-standard `path` property on the dropped File — that
 *     property exists when the file came from the OS file picker
 *     (vs. a renderer-fetched blob). If we get a path, dispatch
 *     `runOfflineImport(path, { includeStaticImages: false })`.
 *
 * R-10 note
 * ---------
 * Reading `(File).path` is the **one** place renderer code is allowed
 * to look at a local filesystem path — Electron exposes it as a
 * non-standard convenience and the path is then immediately handed
 * to main via `runOfflineImport` (which itself goes through the
 * `window.giftk.importOfflinePage` IPC bridge). The renderer never
 * dereferences the path itself; please don't refactor this into a
 * `fs.readFile` call when migrating to a future File System Access
 * API.
 */
import { useEffect } from 'react';

export type AppView = 'home' | 'history' | 'toolbox' | 'uploads' | 'recorder';

export type RunOfflineImportFn = (
  path: string | undefined,
  opts?: { includeStaticImages?: boolean }
) => Promise<unknown> | unknown;

/**
 * Wires the window-level dragover/drop listeners that route OS file
 * drops on the home view into `runOfflineImport`. The hook is a no-op
 * (and tears down any previously-attached listeners) when `view !==
 * 'home'`.
 */
export function useGlobalDropZone(view: AppView, runOfflineImport: RunOfflineImportFn): void {
  useEffect(() => {
    if (view !== 'home') {
      // Toolbox / history / uploads do their own drop handling
      // (ToolboxPanel.handleDrop, etc.). Skipping the global listener
      // entirely on those tabs prevents the cross-tab pollution where
      // a toolbox-added file would appear in the home "已选媒体" grid.
      return;
    }
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      // Only react if the drag actually carries files.
      if (Array.from(e.dataTransfer.types).indexOf('Files') < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      // R-68 — If a child React onDrop already called preventDefault,
      // it means an inner drop zone (e.g. a future home-side toolbox
      // embed) consumed the drop and our window-level fallback would
      // duplicate the work. Native `defaultPrevented` is reliable
      // across the React-synthetic / native boundary because React
      // dispatches preventDefault straight to the native event.
      if (e.defaultPrevented) return;
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      // Electron exposes a non-standard `path` on File when the file
      // came from the OS (vs. a renderer-fetched blob).
      const p = (f as File & { path?: string }).path;
      if (p) void runOfflineImport(p, { includeStaticImages: false });
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [runOfflineImport, view]);
}
