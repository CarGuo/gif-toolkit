/**
 * R-UPDATE — Lightweight client-side update check (no auto-download, no signing).
 *
 * Why this module exists:
 *   The release pipeline (`.github/workflows/release.yml`, R-71) builds and
 *   publishes UN-SIGNED binaries to GitHub Releases. `electron-updater`'s
 *   full auto-download flow refuses to apply unsigned updates on macOS and
 *   throws warnings on Windows, so we deliberately stop one step short:
 *   we just *detect* a newer release and surface it to the user, who then
 *   downloads the installer themselves from the rendered Releases page.
 *
 *   This keeps three things out of the dependency tree:
 *     - electron-updater (and its squirrel/nsis update channels)
 *     - Apple Developer ID cert + notarization
 *     - Windows Authenticode cert
 *
 * What we expose:
 *   - parseSemver / compareSemver — pure helpers, easy to unit-test.
 *   - pickRelease                  — pure release-shape adapter; no IO.
 *   - checkLatestRelease(opts)     — IO entry. Caches results for 6h
 *     in-memory to avoid hammering the GitHub API on every focus
 *     change. Tray and renderer paths converge here so a manual
 *     "检查更新" within the cache window is instant.
 *
 * Tested in tests/main/updater.test.ts — fetcher is dependency-injected
 * to avoid coupling to electron's main-process `net` module under vitest.
 */
import { app, net } from 'electron';
import type { UpdateCheckResult } from '../shared/types/update';

export type { UpdateCheckResult } from '../shared/types/update';

/** GitHub release shape we actually depend on (subset of the v3 REST schema). */
export interface GithubReleasePayload {
  tag_name: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  body?: string;
  prerelease?: boolean;
  draft?: boolean;
}

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** e.g. 'beta.1' for 1.2.3-beta.1; null for stable releases. */
  prerelease: string | null;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Parse a semver string. Tolerates a leading "v" (GitHub tags often use it).
 * Returns null if the input doesn't match the simplified semver shape; the
 * caller should treat null as "couldn't determine — assume not newer".
 */
export function parseSemver(input: string | undefined | null): ParsedSemver | null {
  if (!input) return null;
  const trimmed = input.trim();
  const m = SEMVER_RE.exec(trimmed);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * Compare two semvers. Returns:
 *   <0 if a < b
 *    0 if a == b
 *   >0 if a > b
 * Stable releases beat prereleases of the same x.y.z (semver §11). If
 * either side is unparseable the comparison falls back to 0 — refusing
 * to claim an update exists when we can't be sure.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : 1;
}

/**
 * Pure projection: GitHub release JSON + current version → result shape.
 * Split out from checkLatestRelease so we can unit-test without IO.
 */
export function pickRelease(
  release: GithubReleasePayload | null,
  currentVersion: string,
  fetchedAt: number
): UpdateCheckResult {
  if (!release || !release.tag_name) {
    return {
      current: currentVersion,
      latest: null,
      hasUpdate: false,
      htmlUrl: null,
      publishedAt: null,
      releaseName: null,
      body: null,
      error: 'no-release',
      cached: false,
      fetchedAt,
    };
  }
  const latest = release.tag_name.replace(/^v/, '');
  const cmp = compareSemver(latest, currentVersion);
  // R-UPDATE — Drafts and prereleases are surfaced as "info" only:
  // we keep the fields populated so the UI can still show them, but
  // never set `hasUpdate=true`. The user opted into stable-only auto
  // notifications; a draft GitHub release leaking via the public
  // /releases/latest endpoint must NOT trigger the modal popup.
  const stable = !release.draft && !release.prerelease;
  return {
    current: currentVersion,
    latest,
    hasUpdate: stable && cmp > 0,
    htmlUrl: release.html_url ?? null,
    publishedAt: release.published_at ?? null,
    releaseName: release.name ?? null,
    body: release.body ?? null,
    error: null,
    cached: false,
    fetchedAt,
  };
}

export interface CheckLatestOptions {
  /** GitHub `${owner}/${repo}`. Defaults to CarGuo/gif-toolkit. */
  repo?: string;
  /** Network timeout in ms. Default 8s — fast enough that the
   *  startup check feels invisible if the user is offline. */
  timeoutMs?: number;
  /** Force-bypass the 6h in-memory cache. Wired from the tray /
   *  TopBar "检查更新" button so manual clicks are always fresh. */
  force?: boolean;
  /** Override for tests. Defaults to electron's main-process `net`. */
  fetcher?: (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;
  /** Override for tests. Defaults to app.getVersion(). */
  currentVersion?: string;
  /** Clock injection — also useful in tests. Defaults to Date.now. */
  now?: () => number;
}

const DEFAULT_REPO = 'CarGuo/gif-toolkit';
const DEFAULT_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cached: UpdateCheckResult | null = null;

/** Test-only: clear the in-memory cache between unit tests. */
export function _resetUpdaterCache(): void {
  cached = null;
}

/**
 * The default Electron-net fetcher. Kept tiny on purpose — we only need
 * status + raw body. We DON'T follow redirects manually because GitHub's
 * release endpoint returns 200 directly; if that ever changes we'll see
 * a 302 in the status field and the caller will short-circuit cleanly.
 */
function defaultFetcher(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = net.request({ method: 'GET', url, redirect: 'follow' });
    // GitHub REST API requires a User-Agent header — without it we get a 403.
    req.setHeader('User-Agent', 'gif-toolkit-updater');
    req.setHeader('Accept', 'application/vnd.github+json');
    const chunks: Buffer[] = [];
    let status = 0;
    req.on('response', (res) => {
      status = res.statusCode;
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => finish(() => resolve({ status, body: Buffer.concat(chunks).toString('utf8') })));
      res.on('error', (e) => finish(() => reject(e)));
    });
    req.on('error', (e) => finish(() => reject(e)));
    const timer = setTimeout(() => finish(() => {
      try { req.abort(); } catch { /* ignore */ }
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/**
 * The single IO entry. Handles cache, JSON parse, and any fetch
 * failure — never throws; instead returns a result with `error` set.
 * Callers can rely on always getting a well-formed UpdateCheckResult.
 */
export async function checkLatestRelease(opts: CheckLatestOptions = {}): Promise<UpdateCheckResult> {
  const now = opts.now ?? Date.now;
  const currentVersion = opts.currentVersion ?? app.getVersion();
  const fetchedAt = now();

  if (!opts.force && cached && fetchedAt - cached.fetchedAt < CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  const repo = opts.repo ?? DEFAULT_REPO;
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = opts.fetcher ?? defaultFetcher;

  try {
    const { status, body } = await fetcher(url, timeoutMs);
    if (status === 404) {
      const result: UpdateCheckResult = {
        current: currentVersion,
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        publishedAt: null,
        releaseName: null,
        body: null,
        error: 'no-release',
        cached: false,
        fetchedAt,
      };
      cached = result;
      return result;
    }
    if (status < 200 || status >= 300) {
      return {
        current: currentVersion,
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        publishedAt: null,
        releaseName: null,
        body: null,
        error: `http ${status}`,
        cached: false,
        fetchedAt,
      };
    }
    let json: GithubReleasePayload | null = null;
    try {
      json = JSON.parse(body) as GithubReleasePayload;
    } catch {
      return {
        current: currentVersion,
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        publishedAt: null,
        releaseName: null,
        body: null,
        error: 'invalid-json',
        cached: false,
        fetchedAt,
      };
    }
    const result = pickRelease(json, currentVersion, fetchedAt);
    cached = result;
    return result;
  } catch (e) {
    return {
      current: currentVersion,
      latest: null,
      hasUpdate: false,
      htmlUrl: null,
      publishedAt: null,
      releaseName: null,
      body: null,
      error: (e as Error).message || 'network-error',
      cached: false,
      fetchedAt,
    };
  }
}
