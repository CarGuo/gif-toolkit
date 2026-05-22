/* ----------------------- R-UPDATE Client-side update check ----------------------- */

/**
 * R-UPDATE — Result of a single client-side update probe.
 *
 * Returned by:
 *   - main:    [checkLatestRelease](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/updater.ts)
 *   - IPC:     `updater:checkForUpdates`
 *   - event:   `updater:available` (silent startup check)
 *
 * The check is best-effort and never throws on the wire. On any
 * failure path (network blip, GitHub rate limit, malformed JSON,
 * timeout) the result has `error` set, `latest=null`, `hasUpdate=false`,
 * so renderers can render the "couldn't check" branch by reading
 * `error` directly without try/catch.
 *
 * `cached=true` means the value was served from the in-memory 6h
 * cache rather than a fresh HTTP roundtrip — used by the UI to label
 * "上次检查于 ..." without flickering an unnecessary loader.
 */
export interface UpdateCheckResult {
  /** Currently-running app version, from `app.getVersion()`. */
  current: string;
  /** Latest release tag (without leading `v`), or null on error. */
  latest: string | null;
  /** True iff `latest` is strictly newer than `current` per semver. */
  hasUpdate: boolean;
  /** GitHub release html_url — opens in browser via shell.openExternal. */
  htmlUrl: string | null;
  /** ISO-8601 publish timestamp from GitHub, or null. */
  publishedAt: string | null;
  /** Release name (e.g. "v0.1.2 - 2025-05-22"), or null. */
  releaseName: string | null;
  /** Markdown release body (changelog), truncated by GitHub itself. */
  body: string | null;
  /** Human-readable error message. null = success. */
  error: string | null;
  /** True iff served from the 6h in-memory cache. */
  cached: boolean;
  /** Epoch ms when this result was produced. */
  fetchedAt: number;
}
