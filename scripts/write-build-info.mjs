#!/usr/bin/env node
// R-71 — Stamp src/shared/buildInfo.ts with real build metadata.
//
// Why a code-rewrite (and not, say, a JSON file we read at runtime)?
// We want the build fingerprint to be tree-baked into BOTH the main
// bundle (tsc -p tsconfig.main.json) and the renderer bundle (vite),
// so `npm run start` from a packaged app can show it without paying
// any I/O cost on launch and without exposing a side-channel that
// could be tampered with after packaging. The cleanest way to do
// that is to rewrite the constant literal that both bundlers parse
// statically and inline at compile time.
//
// Inputs (read in priority order):
//   1. CLI flags (mostly for local debugging) — none right now.
//   2. Environment variables exported by the CI runner:
//        GIFTK_VERSION         — semver from the tag (e.g. "0.1.0").
//        GIFTK_COMMIT          — short SHA (we'll truncate if long).
//        GIFTK_RUN_NUMBER      — GitHub Actions run number.
//        GIFTK_BUILD_PLATFORM  — "<os>-<arch>" string.
//      Anything missing falls back to `git rev-parse` / `process.*`
//      so a developer running this script locally still gets sane
//      values rather than the placeholder defaults.
//   3. node_modules/electron/package.json — for the bundled Electron
//      version. Read directly from disk so a future Electron upgrade
//      doesn't require touching this script.
//   4. package.json#version — used as the fallback when GIFTK_VERSION
//      isn't set (e.g. on a manual `npm run prebuild`).
//
// The script is intentionally idempotent: re-running it is safe, and
// it always writes the WHOLE file (it doesn't try to do a surgical
// regex-replace inside the existing literal). That makes it cheap to
// reason about and easy to diff in CI logs.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const target = path.join(repoRoot, 'src', 'shared', 'buildInfo.ts');

function tryGitSha() {
  try {
    return execSync('git rev-parse --short=7 HEAD', { cwd: repoRoot })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function readPkgVersion(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const pkgVersion = readPkgVersion(path.join(repoRoot, 'package.json'));
const electronVersion = readPkgVersion(
  path.join(repoRoot, 'node_modules', 'electron', 'package.json')
);

// CI sets GIFTK_VERSION from the tag without the leading 'v'. Fall
// back to package.json so a hand-rolled `npm run prebuild` still
// produces a stamped binary that isn't labelled "0.0.0-dev".
const versionRaw = process.env.GIFTK_VERSION || pkgVersion;
// Trim a leading "v" to be tolerant of `GIFTK_VERSION=v1.2.3` callers.
const version = versionRaw.replace(/^v/, '');

const commitRaw = process.env.GIFTK_COMMIT || tryGitSha();
const commit = commitRaw.slice(0, 7);

const runNumber = process.env.GIFTK_RUN_NUMBER || 'dev';

const buildPlatform =
  process.env.GIFTK_BUILD_PLATFORM ||
  `${process.platform}-${process.arch}`;

const builtAt = new Date().toISOString();

// We assemble the file as a string template instead of round-tripping
// JS AST. The shape MUST stay byte-compatible with the source file
// at src/shared/buildInfo.ts — any change to that file's surface
// area (added field, new export, etc.) means this template has to
// change in lockstep, otherwise the rewrite will silently delete
// fields. The defaults block in the template mirrors the real
// constant; only the right-hand literals are different per build.
const newSource = `/**
 * R-71 — Build provenance metadata.
 *
 * This file is the SINGLE source of truth for "what build is this?"
 * It is consumed by:
 *   - main process at startup (logged once next to \`app ready\` so
 *     every saved log has the build fingerprint at the top)
 *   - capabilities IPC + future "About" panel (renderer can show the
 *     version + commit + build time without hand-rolling a separate
 *     IPC dance)
 *
 * The DEFAULTS below describe a local \`npm run dev\` build that was
 * never stamped by the release pipeline. The \`scripts/write-build-info.mjs\`
 * script overwrites this file on CI with the real values right before
 * \`npm run build\` runs, so the constants get tree-baked into both the
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
   *  In dev builds this falls back to \`package.json#version\`. */
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
   *  \`node_modules/electron/package.json\` so it survives lockfile
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
  version: ${JSON.stringify(version)},
  commit: ${JSON.stringify(commit)},
  builtAt: ${JSON.stringify(builtAt)},
  runNumber: ${JSON.stringify(runNumber)},
  nodeVersion: ${JSON.stringify(process.version)},
  electronVersion: ${JSON.stringify(electronVersion)},
  buildPlatform: ${JSON.stringify(buildPlatform)}
};

/** Compact one-line summary for log files. */
export function formatBuildInfo(info: BuildInfo = BUILD_INFO): string {
  return (
    \`gif-toolkit \${info.version} (commit \${info.commit}, run \${info.runNumber}, \` +
    \`built \${info.builtAt} on \${info.buildPlatform}, \` +
    \`node \${info.nodeVersion}, electron \${info.electronVersion})\`
  );
}
`;

writeFileSync(target, newSource, 'utf8');
process.stdout.write(
  `[write-build-info] stamped ${path.relative(repoRoot, target)} → ` +
    `${version} / ${commit} / ${builtAt} / ${buildPlatform}\n`
);
