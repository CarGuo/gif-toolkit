/* ----------------------- R-62 Cross-platform capability probe ----------------------- */

/**
 * R-62 — Severity hint for an unsupported / partially-supported feature.
 *
 *  - 'error'  : the feature is broken on this platform and any code path
 *               that reaches it will throw / fail loudly. Renderer must
 *               surface this prominently (red toast).
 *  - 'warn'   : the feature is wired but has not been validated on this
 *               OS / arch combo (e.g. Linux Snap/Flatpak Chrome
 *               detection) — show as yellow toast, allow user to dismiss
 *               permanently.
 *  - 'info'   : the feature is supported but has a known caveat (e.g.
 *               app icon falls back to .ico on platforms that don't
 *               render it perfectly) — soft hint, dismiss on click.
 */
export type CapabilitySeverity = 'error' | 'warn' | 'info';

/**
 * R-62 — A single platform issue surfaced at app startup. The
 * renderer iterates these and renders one toast per issue (deduped
 * against `localStorage.giftk.dismissedCaps` so users can suppress
 * known ones permanently).
 */
export interface CapabilityIssue {
  /** Stable identifier — used as the localStorage dismissal key.
   *  Format: '<platform>.<feature>' e.g. 'darwin.dock-icon-missing-icns'. */
  id: string;
  severity: CapabilitySeverity;
  /** Short, user-facing title (Chinese, <= 24 chars). */
  title: string;
  /** Longer body explaining the symptom and (if applicable) the fix.
   *  Markdown is NOT rendered — newlines become <br> only. */
  detail: string;
  /** Optional external doc link the toast surfaces as "了解更多". */
  docUrl?: string;
}

/**
 * R-62 — Result of `system:capabilities` IPC. Probed once on app
 * startup; cached in main for the lifetime of the process.
 */
export interface CapabilityReport {
  /** process.platform — 'darwin' / 'win32' / 'linux' / etc. */
  platform: NodeJS.Platform;
  /** process.arch — 'x64' / 'arm64' / 'arm' / etc. */
  arch: string;
  /** True if the bundled app icon could be resolved to a PNG (mac/linux
   *  display correctly) rather than only a 32×32 .ico. */
  hasHiResIcon: boolean;
  /** Whether ffmpeg / ffprobe / gifsicle / yt-dlp resolved to a usable
   *  binary. Each entry has the path we'd invoke and whether `--version`
   *  succeeded. */
  binaries: {
    ffmpeg: { path: string; ok: boolean; version: string };
    ffprobe: { path: string; ok: boolean; version: string };
    gifsicle: { path: string; ok: boolean; version: string };
    ytdlp: { path: string; ok: boolean; version: string };
  };
  /** All issues that should be surfaced to the user as toasts. Empty
   *  array is the happy path. */
  issues: CapabilityIssue[];
}
