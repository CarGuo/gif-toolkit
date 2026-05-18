/**
 * R-51 — Tests for the system-Chrome sniff pure helpers.
 *
 * These lock the *non-side-effecting* surface of `systemChromeSniffUtils.ts`:
 *  - Per-platform candidate path lists (priority order + per-user dirs).
 *  - DevTools port parser (handles 127.0.0.1 / localhost / garbage lines).
 *  - User-data-dir name derivation (stable + safe-on-disk).
 *  - Chrome command-line builder (exact flag set is part of the contract
 *    with Cloudflare's JA3 whitelist — adding/removing flags here can
 *    re-trigger a CF retraining cycle).
 *  - CDP `Network.responseReceived` candidate extractor (filters error
 *    responses + non-http schemes that the embedded path also rejects).
 */
import { describe, expect, it } from 'vitest';
import {
  getCandidatePaths,
  parseDevToolsPort,
  deriveProfileDirName,
  buildChromeArgs,
  extractCdpCandidate,
  resolveRealChromeProfileDir,
  isChromeProfileLocked
} from '../../src/main/systemChromeSniffUtils';

describe('getCandidatePaths', () => {
  it('returns macOS app bundle paths in priority order, with per-user fallbacks', () => {
    const list = getCandidatePaths('darwin', '/Users/alice');
    const exes = list.map((c) => c.exePath);
    expect(exes[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(exes).toContain('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    expect(exes).toContain('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    expect(exes).toContain('/Applications/Chromium.app/Contents/MacOS/Chromium');
    // Per-user install paths (no admin password needed).
    expect(exes).toContain('/Users/alice/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  });

  it('returns Windows .exe paths from Program Files / x86 / LocalAppData with priority', () => {
    const prevPF = process.env['ProgramFiles'];
    const prevPF86 = process.env['ProgramFiles(x86)'];
    const prevLAD = process.env['LOCALAPPDATA'];
    process.env['ProgramFiles'] = 'C:\\Program Files';
    process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)';
    process.env['LOCALAPPDATA'] = 'C:\\Users\\bob\\AppData\\Local';
    try {
      const list = getCandidatePaths('win32', 'C:\\Users\\bob');
      const exes = list.map((c) => c.exePath);
      // Chrome (system + x86 + per-user) MUST come before Edge / Brave so we
      // bias toward the binary CF's whitelist trusts the most. We match on
      // the executable basename + a Google-folder substring so the assertion
      // is robust to whichever path separator a non-Windows test runner
      // produced when joining the Windows-flavoured path fragments.
      const firstChrome = exes.findIndex((e) => /chrome\.exe$/i.test(e) && /Google/.test(e));
      const firstEdge = exes.findIndex((e) => /msedge\.exe$/i.test(e));
      const firstBrave = exes.findIndex((e) => /brave\.exe$/i.test(e));
      expect(firstChrome).toBeGreaterThanOrEqual(0);
      expect(firstEdge).toBeGreaterThan(firstChrome);
      expect(firstBrave).toBeGreaterThan(firstEdge);
      // Per-user install path must be present (built from $LOCALAPPDATA).
      expect(exes.some((e) => /AppData[\\/]Local[\\/]Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/i.test(e)))
        .toBe(true);
    } finally {
      if (prevPF === undefined) delete process.env['ProgramFiles']; else process.env['ProgramFiles'] = prevPF;
      if (prevPF86 === undefined) delete process.env['ProgramFiles(x86)']; else process.env['ProgramFiles(x86)'] = prevPF86;
      if (prevLAD === undefined) delete process.env['LOCALAPPDATA']; else process.env['LOCALAPPDATA'] = prevLAD;
    }
  });

  it('returns Linux /usr/bin candidates including google-chrome-stable and chromium-browser', () => {
    const list = getCandidatePaths('linux', '/home/carol');
    const exes = list.map((c) => c.exePath);
    expect(exes).toContain('/usr/bin/google-chrome');
    expect(exes).toContain('/usr/bin/google-chrome-stable');
    expect(exes).toContain('/usr/bin/chromium');
    expect(exes).toContain('/usr/bin/chromium-browser');
    expect(exes).toContain('/usr/bin/microsoft-edge');
    expect(exes).toContain('/usr/bin/brave-browser');
  });

  it('attaches a stable {id, label} pair to every candidate', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const list = getCandidatePaths(platform, '/home/x');
      for (const c of list) {
        expect(['chrome', 'edge', 'brave', 'chromium']).toContain(c.id);
        expect(typeof c.label).toBe('string');
        expect(c.label.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('parseDevToolsPort', () => {
  it('extracts the port from a 127.0.0.1 banner', () => {
    expect(parseDevToolsPort(
      'DevTools listening on ws://127.0.0.1:54321/devtools/browser/abcd'
    )).toBe(54321);
  });

  it('also accepts the localhost variant emitted by some Chromium forks', () => {
    expect(parseDevToolsPort(
      'DevTools listening on ws://localhost:9222/devtools/browser/xyz'
    )).toBe(9222);
  });

  it('is case-insensitive on the banner prefix', () => {
    expect(parseDevToolsPort(
      'devtools LISTENING on ws://127.0.0.1:8080/devtools/browser/xx'
    )).toBe(8080);
  });

  it('returns null on garbage / missing / out-of-range lines', () => {
    expect(parseDevToolsPort('')).toBeNull();
    expect(parseDevToolsPort('Some random log line')).toBeNull();
    // No port field.
    expect(parseDevToolsPort('DevTools listening on ws://127.0.0.1/devtools/browser/x')).toBeNull();
    // Port too long (regex caps at 5 digits) — but we still validate the
    // numeric range so >65535 returns null even if the regex matched.
    expect(parseDevToolsPort('DevTools listening on ws://127.0.0.1:99999/devtools/browser/x')).toBeNull();
  });
});

describe('deriveProfileDirName', () => {
  it('produces the same dirname for the same host across calls', () => {
    const a = deriveProfileDirName('https://chat.openai.com/c/foo');
    const b = deriveProfileDirName('https://chat.openai.com/different/path?q=1');
    expect(a).toBe(b);
  });

  it('produces different dirnames for different hosts', () => {
    const a = deriveProfileDirName('https://medium.com/abc');
    const b = deriveProfileDirName('https://patreon.com/abc');
    expect(a).not.toBe(b);
  });

  it('keeps the host visible (for manual debugging) but always 12-char hash suffix', () => {
    const name = deriveProfileDirName('https://chat.openai.com/c/foo');
    expect(name).toMatch(/^chat\.openai\.com-[0-9a-f]{12}$/);
  });

  it('strips non-ASCII / unsafe chars from the host portion', () => {
    // IDN host gets punycoded by URL parser, but if any unsafe char does
    // sneak in we must scrub it so we never get a backslash on Windows.
    const name = deriveProfileDirName('https://例子.測試/');
    expect(name).not.toMatch(/[^a-z0-9.\-_]/);
    expect(name).toMatch(/-[0-9a-f]{12}$/);
  });

  it('falls back to a deterministic default bucket when URL is malformed', () => {
    expect(deriveProfileDirName('not a url')).toBe('default-00000000');
    expect(deriveProfileDirName('')).toBe('default-00000000');
  });
});

describe('buildChromeArgs', () => {
  it('emits the exact Cloudflare-JA3-stable flag set we ship', () => {
    const args = buildChromeArgs({
      url: 'https://chat.openai.com/',
      userDataDir: '/tmp/giftk/system-chrome-profiles/chat.openai.com-abc',
      port: 54321
    });
    expect(args).toEqual([
      '--remote-debugging-port=54321',
      '--user-data-dir=/tmp/giftk/system-chrome-profiles/chat.openai.com-abc',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--restore-last-session=false',
      // R-58 anti-bot hardening — order matters because Chrome
      // collapses duplicate --disable-features into the LAST flag.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=AutomationControlled,Translate,ChromeWhatsNewUI,WelcomeTour',
      '--password-store=basic',
      '--use-mock-keychain',
      // R-60 — boot into about:blank instead of the target URL so the
      // user's daily-profile "On startup → open specific pages" setting
      // does not produce a second tab.  We Page.navigate(url) over CDP
      // after attach.
      'about:blank'
    ]);
  });

  it('R-60 — boots into about:blank, never the target URL as positional arg', () => {
    const args = buildChromeArgs({ url: 'https://medium.com/x', userDataDir: '/d', port: 9222 });
    expect(args[args.length - 1]).toBe('about:blank');
    expect(args).not.toContain('https://medium.com/x');
  });

  it('R-58 — never passes --enable-automation (CF / DataDome key off it)', () => {
    const args = buildChromeArgs({ url: 'https://x.com/', userDataDir: '/d', port: 0 });
    expect(args).not.toContain('--enable-automation');
  });

  it('R-58 — disables AutomationControlled at the blink-features level', () => {
    const args = buildChromeArgs({ url: 'https://x.com/', userDataDir: '/d', port: 0 });
    expect(args).toContain('--disable-blink-features=AutomationControlled');
  });
});

describe('extractCdpCandidate', () => {
  it('returns null when the response is missing', () => {
    expect(extractCdpCandidate({})).toBeNull();
    expect(extractCdpCandidate({ response: undefined })).toBeNull();
  });

  it('returns null when the URL is missing or non-string', () => {
    expect(extractCdpCandidate({ response: { url: undefined, status: 200, mimeType: 'image/gif' } } as never))
      .toBeNull();
  });

  it('rejects non-http(s) schemes (data:, blob:, chrome-extension://...)', () => {
    expect(extractCdpCandidate({ response: { url: 'data:image/gif;base64,xx', status: 200, mimeType: 'image/gif' } }))
      .toBeNull();
    expect(extractCdpCandidate({ response: { url: 'blob:https://medium.com/123', status: 200, mimeType: 'video/mp4' } }))
      .toBeNull();
    expect(extractCdpCandidate({ response: { url: 'chrome-extension://abc/x.gif', status: 200, mimeType: 'image/gif' } }))
      .toBeNull();
  });

  it('rejects HTTP error responses (>=400)', () => {
    expect(extractCdpCandidate({ response: { url: 'https://x.com/a.gif', status: 404, mimeType: 'image/gif' } }))
      .toBeNull();
    expect(extractCdpCandidate({ response: { url: 'https://x.com/a.gif', status: 503, mimeType: 'image/gif' } }))
      .toBeNull();
  });

  it('passes through a valid http(s) response with status 200 + mime', () => {
    expect(extractCdpCandidate({
      response: { url: 'https://cdn.medium.com/v.mp4', status: 200, mimeType: 'video/mp4' }
    })).toEqual({ url: 'https://cdn.medium.com/v.mp4', mime: 'video/mp4' });
  });

  it('passes through valid responses with empty/missing mime as mime=null', () => {
    expect(extractCdpCandidate({
      response: { url: 'https://cdn.x.com/a.gif', status: 200, mimeType: '' }
    })).toEqual({ url: 'https://cdn.x.com/a.gif', mime: null });
    expect(extractCdpCandidate({
      response: { url: 'https://cdn.x.com/a.gif', status: 200 }
    })).toEqual({ url: 'https://cdn.x.com/a.gif', mime: null });
  });

  it('treats status 0 (CDP placeholder for in-flight) as acceptable', () => {
    expect(extractCdpCandidate({
      response: { url: 'https://cdn.x.com/a.gif', status: 0, mimeType: 'image/gif' }
    })).toEqual({ url: 'https://cdn.x.com/a.gif', mime: 'image/gif' });
  });
});

describe('R-59 — resolveRealChromeProfileDir', () => {
  it('returns null on unknown / non-existent path silently', () => {
    // We can't assert the actual real-Chrome path because that depends
    // on the CI host. We can assert the function never throws and is
    // either a non-empty string OR null — never undefined.
    const out = resolveRealChromeProfileDir('/some/garbage/Chrome.exe');
    expect(out === null || typeof out === 'string').toBe(true);
  });

  it('does not throw when given an empty exePath', () => {
    expect(() => resolveRealChromeProfileDir('')).not.toThrow();
  });
});

describe('R-59 — isChromeProfileLocked', () => {
  it('returns false for an empty path', () => {
    expect(isChromeProfileLocked('')).toBe(false);
  });

  it('returns false for a non-existent dir', () => {
    expect(isChromeProfileLocked('/definitely/not/a/real/profile/dir')).toBe(false);
  });

  it('does not throw on an unreadable / odd path', () => {
    expect(() => isChromeProfileLocked('/dev/null')).not.toThrow();
  });
});
