/**
 * R-51 — Pure helpers backing `systemChromeSniff.ts` (the spawn-real-Chrome
 * + CDP path that bypasses Cloudflare's TLS/HTTP2 fingerprint check by
 * delegating the actual TCP/TLS handshake to the user's installed Chrome
 * binary).
 *
 * Everything in this file is side-effect-free and synchronously testable —
 * no spawn, no fs writes, no electron imports — so the unit suite can lock
 * the platform path lists, stdout port parsing, and user-data-dir hashing
 * without booting an Electron host.
 *
 * R-59 NOTE — `resolveRealChromeProfileDir` and `isChromeProfileLocked`
 * use READ-ONLY fs probes (existsSync). They remain side-effect-free.
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Catalogue of known stable distribution channels. Order matters: we try
 * the listed channel first because that is the one most users will have
 * actually upgraded recently (and therefore the one whose JA3/JA4
 * fingerprint Cloudflare's whitelist is most likely to recognise).
 *
 * The `arg` field carries any flag that disambiguates a multi-app binary
 * (currently only Edge needs `--app-name=Edge`-style hint, none required
 * today, kept for future-proofing).
 */
export interface BrowserCandidate {
  /** Canonical short name surfaced in logs / UI. */
  id: 'chrome' | 'edge' | 'brave' | 'chromium';
  /** Human-readable label used in error messages and renderer dropdown. */
  label: string;
  /** Absolute filesystem path to probe (one entry; `getCandidatePaths`
   *  expands the per-platform list). */
  exePath: string;
}

/**
 * Per-platform default candidate executable paths, in priority order.
 * Each entry must be probe-able with `fs.existsSync` — we deliberately do
 * NOT shell out to `which`/`where` here because spawning a child process
 * just to ask "is X installed" multiplies sniff latency for the common
 * case where Chrome lives at the canonical install dir.
 *
 * NOTE: Only common stable installs are listed. If the user installed
 * Chrome to a non-standard prefix (e.g. `~/.local/google-chrome`), they
 * can fall back to the embedded webview path; we prefer to fail fast
 * with a clear error than to silently launch some unrelated binary.
 */
export function getCandidatePaths(
  platform: NodeJS.Platform,
  homeDir: string
): BrowserCandidate[] {
  if (platform === 'darwin') {
    return [
      { id: 'chrome', label: 'Google Chrome',
        exePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { id: 'chrome', label: 'Google Chrome (Canary)',
        exePath: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary' },
      { id: 'edge', label: 'Microsoft Edge',
        exePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { id: 'brave', label: 'Brave Browser',
        exePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { id: 'chromium', label: 'Chromium',
        exePath: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
      // Per-user installs (macOS users often install browsers to
      // `~/Applications/` to avoid the admin-password prompt at install).
      { id: 'chrome', label: 'Google Chrome (User)',
        exePath: path.join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome') },
      { id: 'edge', label: 'Microsoft Edge (User)',
        exePath: path.join(homeDir, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') }
    ];
  }
  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] ||
      path.join(homeDir, 'AppData', 'Local');
    return [
      { id: 'chrome', label: 'Google Chrome',
        exePath: path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe') },
      { id: 'chrome', label: 'Google Chrome (x86)',
        exePath: path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe') },
      { id: 'chrome', label: 'Google Chrome (User)',
        exePath: path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') },
      { id: 'edge', label: 'Microsoft Edge',
        exePath: path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe') },
      { id: 'edge', label: 'Microsoft Edge (x86)',
        exePath: path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe') },
      { id: 'brave', label: 'Brave Browser',
        exePath: path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') },
      { id: 'brave', label: 'Brave Browser (x86)',
        exePath: path.join(programFilesX86, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') },
      { id: 'brave', label: 'Brave Browser (User)',
        exePath: path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') }
    ];
  }
  // linux + others
  return [
    { id: 'chrome', label: 'Google Chrome',
      exePath: '/usr/bin/google-chrome' },
    { id: 'chrome', label: 'Google Chrome',
      exePath: '/usr/bin/google-chrome-stable' },
    { id: 'chromium', label: 'Chromium',
      exePath: '/usr/bin/chromium' },
    { id: 'chromium', label: 'Chromium',
      exePath: '/usr/bin/chromium-browser' },
    { id: 'edge', label: 'Microsoft Edge',
      exePath: '/usr/bin/microsoft-edge' },
    { id: 'edge', label: 'Microsoft Edge',
      exePath: '/usr/bin/microsoft-edge-stable' },
    { id: 'brave', label: 'Brave Browser',
      exePath: '/usr/bin/brave-browser' }
  ];
}

/**
 * Parse a Chrome/Chromium launch stdout/stderr line into a debugger port.
 * Chrome prints exactly one such line shortly after start when invoked
 * with `--remote-debugging-port=N`:
 *
 *   "DevTools listening on ws://127.0.0.1:54321/devtools/browser/<uuid>"
 *
 * Returns `null` if the line is not a DevTools banner. We accept both
 * `127.0.0.1` and `localhost` because some Chromium forks (Brave) print
 * the latter.
 */
export function parseDevToolsPort(line: string): number | null {
  const m = /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})\//i.exec(line);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

/**
 * Derive a stable per-host directory name for the isolated Chrome user
 * data folder. Same host => same dir, so cookies / login survive across
 * sniff sessions. We hash the lowercased host so the dirname does not
 * leak Unicode / slashes / weird URL chars onto disk.
 *
 * Falls back to a deterministic 'default' bucket when the URL is malformed
 * (cannot be parsed). Caller is expected to pass the raw URL the user
 * typed into the address bar.
 */
export function deriveProfileDirName(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host.toLowerCase();
    const hash = crypto.createHash('sha256').update(host).digest('hex').slice(0, 12);
    // Keep host visible in the path to aid manual debugging — strip any
    // non-ASCII / non-host chars so we never end up with a backslash on
    // Windows or a colon on macOS.
    const safeHost = host.replace(/[^a-z0-9.-]/g, '_').slice(0, 40);
    return `${safeHost}-${hash}`;
  } catch {
    return 'default-00000000';
  }
}

/**
 * Build the full Chrome/Chromium command-line args for a sniff session.
 * Centralised so unit tests can lock the exact flag set we ship — this
 * matters because adding `--disable-features=...` here changes Chrome's
 * advertised TLS extensions and would re-trigger Cloudflare retraining.
 *
 * `port=0` asks Chrome to pick a free port; we then read it back from
 * stdout via `parseDevToolsPort`.
 */
export function buildChromeArgs(opts: {
  url: string;
  userDataDir: string;
  port: number;
}): string[] {
  return [
    `--remote-debugging-port=${opts.port}`,
    `--user-data-dir=${opts.userDataDir}`,
    // Avoid the very visible "Welcome to Chrome" / "make this your default"
    // dialogs that would otherwise confuse a casual user the first time
    // we spawn Chrome with a brand-new profile dir.
    '--no-first-run',
    '--no-default-browser-check',
    // Suppress restore-pages-after-crash banner. Sniff sessions are
    // short-lived; a banner here would push the target page down and
    // confuse the user.
    '--disable-session-crashed-bubble',
    '--restore-last-session=false',
    // R-58 — anti-bot hardening for Cloudflare Turnstile / DataDome /
    // PerimeterX. Without these, simply attaching CDP via
    // `--remote-debugging-port` flips three bot-detection signals:
    //   1. `navigator.webdriver === true` — set by Blink whenever the
    //      AutomationControlled feature is on (and that feature is on
    //      whenever a remote debugger is attached).
    //   2. The default --enable-automation UA banner.
    //   3. Notification.permission auto-flipping to "denied" on a CDP
    //      target, which CF cross-checks against navigator.permissions.
    // Disabling AutomationControlled clears (1) — the cheapest, highest
    // ROI Turnstile-bypass flag in 2026. The combined --disable-features
    // also turns off the new-tab "What's New" surface and the welcome
    // tour (replaces what the earlier ChromeWhatsNewUI/WelcomeTour line
    // did, just folded into the anti-bot list to avoid Chrome merging
    // duplicate --disable-features into one and dropping our entries).
    //
    // NB: we INTENTIONALLY do NOT pass `--enable-automation`. Older
    // chrome-launcher templates include it; Chrome treats its presence
    // as an explicit "I am a robot" hint and CF / DataDome key off it.
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled,Translate,ChromeWhatsNewUI,WelcomeTour',
    '--password-store=basic',
    '--use-mock-keychain',
    opts.url
  ];
}

/**
 * R-59 — Resolve the OS-default Chrome / Edge / Brave user-data-dir.
 * Caller passes the resolved exe path so we can pick the matching profile
 * (e.g. Edge has its own dir under `Microsoft Edge`). Returns `null` if
 * the platform is unknown or the path doesn't exist on disk yet.
 *
 * macOS:
 *   ~/Library/Application Support/Google/Chrome
 * Windows:
 *   %LOCALAPPDATA%\Google\Chrome\User Data
 * Linux:
 *   ~/.config/google-chrome
 *
 * For Edge / Brave we inspect the exePath substring. This stays a pure
 * read-only fs probe — testable on a real machine, gracefully returns
 * null on unsupported hosts.
 */
export function resolveRealChromeProfileDir(exePath: string): string | null {
  const home = os.homedir();
  const lower = exePath.toLowerCase();
  const isEdge = lower.includes('microsoft edge') || lower.includes('msedge');
  const isBrave = lower.includes('brave');
  let candidate: string | null = null;
  if (process.platform === 'darwin') {
    if (isEdge) candidate = path.join(home, 'Library/Application Support/Microsoft Edge');
    else if (isBrave) candidate = path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser');
    else candidate = path.join(home, 'Library/Application Support/Google/Chrome');
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    if (isEdge) candidate = path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
    else if (isBrave) candidate = path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data');
    else candidate = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  } else if (process.platform === 'linux') {
    if (isEdge) candidate = path.join(home, '.config/microsoft-edge');
    else if (isBrave) candidate = path.join(home, '.config/BraveSoftware/Brave-Browser');
    else candidate = path.join(home, '.config/google-chrome');
  }
  if (!candidate) return null;
  try { return fs.existsSync(candidate) ? candidate : null; } catch { return null; }
}

/**
 * R-59 — Detect whether a Chrome profile dir is currently locked by a
 * live Chrome instance. If it is, spawning a second Chrome with the
 * same `--user-data-dir` will fail (or worse, silently merge into the
 * running instance and skip our `--remote-debugging-port` flag).
 *
 * Detection strategy:
 *   - macOS / Linux: SingletonLock is a symlink whose target encodes
 *     "<hostname>-<pid>"; if it exists *and* its target's pid is alive
 *     we treat the profile as locked. We only stat the symlink; if
 *     readlink fails (it's a regular file orphaned by a hard kill)
 *     we treat it as unlocked so the user is not stuck.
 *   - Windows: Chrome doesn't ship SingletonLock; instead it holds an
 *     exclusive handle on `<dir>\lockfile`. We probe by trying to
 *     open it with WRITE access — `existsSync` alone isn't enough.
 *     For now we fall back to existence + recent-mtime (< 5 s old)
 *     as a coarse signal; full lockfile probing requires native APIs.
 *
 * Conservative: returns `false` on any read error. The caller (the
 * "use real profile" code path) only consults this to decide whether
 * to ABORT before spawning, so a false-negative just means we let
 * Chrome try and fail with a clearer error. False-positive would be
 * worse (would block the user when nothing is actually running).
 */
export function isChromeProfileLocked(profileDir: string): boolean {
  if (!profileDir) return false;
  try {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const lockPath = path.join(profileDir, 'SingletonLock');
      let target: string;
      try {
        target = fs.readlinkSync(lockPath);
      } catch {
        // Not a symlink or doesn't exist → not locked.
        return false;
      }
      // Target format is "<hostname>-<pid>". Extract pid.
      const m = /-(\d+)$/.exec(target);
      if (!m) return false;
      const pid = Number(m[1]);
      if (!Number.isFinite(pid) || pid <= 0) return false;
      try {
        // signal 0 doesn't kill, only checks existence.
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    if (process.platform === 'win32') {
      const lockPath = path.join(profileDir, 'lockfile');
      if (!fs.existsSync(lockPath)) return false;
      try {
        const stat = fs.statSync(lockPath);
        // Chrome touches lockfile on every startup; a freshly-modified
        // file (< 30 s) is a strong hint Chrome is live. Not perfect
        // but adequate as a "you should close Chrome first" gate.
        return Date.now() - stat.mtimeMs < 30_000;
      } catch {
        return false;
      }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Type for a CDP `Network.responseReceived` payload (subset we read).
 */
export interface CdpResponseReceivedParams {
  requestId?: string;
  type?: string;
  response?: {
    url?: string;
    status?: number;
    mimeType?: string;
    headers?: Record<string, string>;
  };
}

/**
 * Reduce a CDP `Network.responseReceived` event to the `(url, mime)` tuple
 * downstream `acceptWebviewMedia` expects, OR null if the event is not a
 * candidate at all (HTTP error, non-http(s) scheme, missing URL).
 */
export function extractCdpCandidate(
  params: CdpResponseReceivedParams
): { url: string; mime: string | null } | null {
  const r = params?.response;
  if (!r || typeof r.url !== 'string') return null;
  const url = r.url;
  if (!/^https?:/i.test(url)) return null;
  const status = typeof r.status === 'number' ? r.status : 0;
  if (status >= 400) return null;
  const mime = typeof r.mimeType === 'string' && r.mimeType.length > 0 ? r.mimeType : null;
  return { url, mime };
}
