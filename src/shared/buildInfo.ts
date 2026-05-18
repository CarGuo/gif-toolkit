/**
 * R-71 — Build provenance metadata.
 *
 * This file is the SINGLE source of truth for "what build is this?"
 * It is consumed by:
 *   - main process at startup (logged once next to `app ready` so
 *     every saved log has the build fingerprint at the top)
 *   - capabilities IPC + future "About" panel (renderer can show the
 *     version + commit + build time without hand-rolling a separate
 *     IPC dance)
 *
 * The DEFAULTS below describe a local `npm run dev` build that was
 * never stamped by the release pipeline. The `scripts/write-build-info.mjs`
 * script overwrites this file on CI with the real values right before
 * `npm run build` runs, so the constants get tree-baked into both the
 * main bundle (tsc) and the renderer bundle (vite). We deliberately do
 * NOT read this from environment variables at runtime — that would
 * mean every shipped binary embeds the CI runner's env at process
 * launch, which is brittle and forbids users from inspecting the
 * commit baked into a packaged app.
 *
 * If you find yourself adding a new field, also extend
 *   - scripts/write-build-info.mjs (CI writer)
 *   - .github/workflows/release.yml (env feeding the writer)
 *   - tests/shared/defaults.test.ts (or a new build-info test)
 * so the schema stays in lockstep across the matrix.
 */

export interface BuildInfo {
  /** Semver from the git tag that drove the build, e.g. "0.1.0".
   *  In dev builds this falls back to `package.json#version`. */
  version: string;
  /** 7-char git SHA that was checked out when the build ran. */
  commit: string;
  /** ISO-8601 timestamp set by the CI writer (UTC). */
  builtAt: string;
  /** GitHub Actions run number ("123") or "dev" for local builds.
   *  Useful when two consecutive tags need disambiguation. */
  runNumber: string;
  /** node version that the CI runner used (process.version output). */
  nodeVersion: string;
  /** Electron version that was packaged. Comes from
   *  `node_modules/electron/package.json` so it survives lockfile
   *  upgrades without manual edits. */
  electronVersion: string;
  /** "darwin-arm64" / "win32-x64" / "linux-x64" — the runner os/arch
   *  that produced THIS bundle (not the one the user is running on,
   *  use process.platform/process.arch for that). */
  buildPlatform: string;
}

/**
 * The default constant. CI overwrites the right-hand-side literals
 * before bundling. We keep the "dev" string fingerprint so a packaged
 * build that somehow shipped without being stamped is obviously
 * recognisable in logs and the About panel.
 */
export const BUILD_INFO: BuildInfo = {
  version: '0.0.0-dev',
  commit: 'unknown',
  builtAt: '1970-01-01T00:00:00.000Z',
  runNumber: 'dev',
  nodeVersion: 'dev',
  electronVersion: 'dev',
  buildPlatform: 'dev'
};

/** Compact one-line summary for log files. */
export function formatBuildInfo(info: BuildInfo = BUILD_INFO): string {
  return (
    `gif-toolkit ${info.version} (commit ${info.commit}, run ${info.runNumber}, ` +
    `built ${info.builtAt} on ${info.buildPlatform}, ` +
    `node ${info.nodeVersion}, electron ${info.electronVersion})`
  );
}
