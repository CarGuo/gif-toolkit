/**
 * R-45 — Pure-function tests for the uploader signing + helpers.
 *
 * These deliberately exercise byte-level outputs so a refactor that
 * silently breaks signature compatibility (qiniu UpToken / OSS v1 /
 * COS v5) trips a red test instead of a 403 from a third-party host.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  TINY_PNG_BYTES,
  backoffDelayMs,
  buildAliyunPutSignature,
  buildCosPutSignature,
  buildMarkdown,
  buildRemoteKey,
  formatMediaLink,
  guessMimeFromName,
  inferQiniuRegionFromUploadHost,
  isRetriableUploadError,
  mintQiniuUploadToken,
  qiniuRegionQueryUrl,
  qiniuUploadHost,
  resolveJsonPath,
  sanitizeCustomWebHeaders,
  sanitizeRemoteName,
  shortRandomSuffix,
  urlSafeBase64
} from '../../src/main/uploader/uploaderUtils';

describe('buildMarkdown', () => {
  it('uses filename without extension as default alt', () => {
    expect(buildMarkdown('foo.gif', 'https://cdn/x')).toBe('![foo](https://cdn/x)');
  });
  it('strips dangerous markdown chars from alt', () => {
    expect(buildMarkdown('a]b[c|d`e.gif', 'https://cdn/x')).toBe('![abcde](https://cdn/x)');
  });
  it('honours {name} / {ext} template tokens', () => {
    expect(buildMarkdown('foo.gif', 'https://cdn/x', '{name}.{ext}')).toBe('![foo.gif](https://cdn/x)');
  });
});

describe('resolveJsonPath', () => {
  it('extracts $.data.url', () => {
    expect(resolveJsonPath({ data: { url: 'https://x' } }, '$.data.url')).toBe('https://x');
  });
  it('extracts data.list[0].url without leading $', () => {
    expect(resolveJsonPath({ data: { list: [{ url: 'a' }, { url: 'b' }] } }, 'data.list[0].url')).toBe('a');
  });
  it('handles bracket-quoted weird keys', () => {
    expect(resolveJsonPath({ data: { 'weird-key': 'v' } }, "$.data['weird-key']")).toBe('v');
  });
  it('returns undefined for missing path', () => {
    expect(resolveJsonPath({}, '$.missing.path')).toBeUndefined();
  });
});

describe('buildRemoteKey + sanitizeRemoteName', () => {
  it('sanitises unsafe characters', () => {
    expect(sanitizeRemoteName('hello world!.gif')).toBe('hello_world_.gif');
  });
  it('combines prefix + yyyymmdd + safe name', () => {
    const fixed = new Date('2024-03-15T10:00:00Z');
    const key = buildRemoteKey('a b.gif', 'blog', fixed);
    expect(key).toBe('blog/20240315/a_b.gif');
  });
  it('omits prefix when empty', () => {
    const fixed = new Date('2024-03-15T10:00:00Z');
    expect(buildRemoteKey('a.gif', '', fixed)).toBe('20240315/a.gif');
  });
});

describe('shortRandomSuffix', () => {
  it('returns 6-hex suffix', () => {
    const s = shortRandomSuffix();
    expect(s).toMatch(/^[0-9a-f]{6}$/);
  });
  it('produces different values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(shortRandomSuffix());
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('mintQiniuUploadToken', () => {
  it('produces ak:sign:policy structure with valid HMAC-SHA1 over policy', () => {
    const fixed = new Date('2024-01-01T00:00:00Z');
    const token = mintQiniuUploadToken('AK1', 'SK1', 'mybucket', 3600, fixed);
    const parts = token.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('AK1');
    // Reconstruct expected sign:
    const policy = Buffer.from(parts[2], 'base64').toString('utf8');
    const json = JSON.parse(policy.replace(/-/g, '+').replace(/_/g, '/'));
    expect(json.scope).toBe('mybucket');
    expect(json.deadline).toBe(Math.floor(fixed.getTime() / 1000) + 3600);
    const expectedSign = urlSafeBase64(crypto.createHmac('sha1', 'SK1').update(parts[2]).digest());
    expect(parts[1]).toBe(expectedSign);
  });
});

describe('qiniuUploadHost', () => {
  it.each([
    ['z0', 'https://upload.qiniup.com'],
    ['z1', 'https://upload-z1.qiniup.com'],
    ['z2', 'https://upload-z2.qiniup.com'],
    ['na0', 'https://upload-na0.qiniup.com'],
    ['as0', 'https://upload-as0.qiniup.com'],
    ['cn-east-2', 'https://upload-cn-east-2.qiniup.com']
  ] as const)('region %s → %s', (region, host) => {
    expect(qiniuUploadHost(region)).toBe(host);
  });
});

describe('buildAliyunPutSignature', () => {
  it('signs StringToSign per OSS v1 spec', () => {
    const args = {
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      bucket: 'mybucket',
      key: 'images/foo.gif',
      contentType: 'image/gif',
      contentMd5: 'abcd==',
      date: 'Mon, 01 Jan 2024 00:00:00 GMT'
    };
    const r = buildAliyunPutSignature(args);
    const expectedStringToSign = `PUT\nabcd==\nimage/gif\nMon, 01 Jan 2024 00:00:00 GMT\n/mybucket/images/foo.gif`;
    expect(r.stringToSign).toBe(expectedStringToSign);
    const expectedSig = crypto.createHmac('sha1', 'sk').update(expectedStringToSign).digest('base64');
    expect(r.authorization).toBe(`OSS ak:${expectedSig}`);
  });
});

describe('buildCosPutSignature', () => {
  it('produces q-sign-algorithm=sha1 v5 authorization', () => {
    const fixed = new Date('2024-01-01T00:00:00Z');
    const r = buildCosPutSignature({
      secretId: 'SID',
      secretKey: 'SKE',
      host: 'b-1.cos.ap-shanghai.myqcloud.com',
      key: 'images/foo.gif',
      expiresInSec: 3600,
      now: fixed
    });
    expect(r.authorization).toContain('q-sign-algorithm=sha1');
    expect(r.authorization).toContain('q-ak=SID');
    expect(r.authorization).toContain(`q-sign-time=${r.signTime}`);
    expect(r.authorization).toContain('q-key-time=' + r.signTime);
    // Re-derive signature from documented procedure to detect drift.
    const signKey = crypto.createHmac('sha1', 'SKE').update(r.signTime).digest('hex');
    const formatString = `put\n/images/foo.gif\n\nhost=b-1.cos.ap-shanghai.myqcloud.com\n`;
    const httpString = `sha1\n${r.signTime}\n${crypto.createHash('sha1').update(formatString).digest('hex')}\n`;
    const expectedSig = crypto.createHmac('sha1', signKey).update(httpString).digest('hex');
    expect(r.authorization).toContain(`q-signature=${expectedSig}`);
  });
});

describe('sanitizeCustomWebHeaders', () => {
  it('keeps allowlisted headers', () => {
    const r = sanitizeCustomWebHeaders({ Authorization: 'Bearer x', Accept: 'application/json' });
    expect(r.Authorization).toBe('Bearer x');
    expect(r.Accept).toBe('application/json');
  });
  it('keeps x-* custom headers', () => {
    const r = sanitizeCustomWebHeaders({ 'X-Token': 'abc' });
    expect(r['X-Token']).toBe('abc');
  });
  it('drops disallowed headers', () => {
    const r = sanitizeCustomWebHeaders({ Cookie: 'a=b', Host: 'evil' });
    expect(r.Cookie).toBeUndefined();
    expect(r.Host).toBeUndefined();
  });
  it('drops headers with CRLF or NUL', () => {
    const r = sanitizeCustomWebHeaders({ Authorization: 'a\r\nb', 'X-Bad': 'x\u0000y' });
    expect(r.Authorization).toBeUndefined();
    expect(r['X-Bad']).toBeUndefined();
  });
  it('drops oversize values', () => {
    const r = sanitizeCustomWebHeaders({ Authorization: 'a'.repeat(3000) });
    expect(r.Authorization).toBeUndefined();
  });
});

describe('guessMimeFromName', () => {
  it.each([
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.png', 'image/png'],
    ['a.apng', 'image/apng'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.mp4', 'video/mp4'],
    ['a.webm', 'video/webm']
  ])('%s → %s', (name, mime) => {
    expect(guessMimeFromName(name)).toBe(mime);
  });
  it('falls back to octet-stream for unknown ext', () => {
    expect(guessMimeFromName('a.bin')).toBe('application/octet-stream');
  });
});

describe('R-46 backoffDelayMs', () => {
  it('returns 0 when rand=0 (full-jitter floor)', () => {
    expect(backoffDelayMs(0, 500, 8000, () => 0)).toBe(0);
    expect(backoffDelayMs(3, 500, 8000, () => 0)).toBe(0);
  });
  it('caps at maxMs even for high attempts', () => {
    // 500 * 2^20 would otherwise overflow
    expect(backoffDelayMs(20, 500, 8000, () => 0.999999)).toBeLessThanOrEqual(8000);
  });
  it('grows roughly exponentially before cap', () => {
    const a0 = backoffDelayMs(0, 500, 8000, () => 0.999);
    const a1 = backoffDelayMs(1, 500, 8000, () => 0.999);
    const a2 = backoffDelayMs(2, 500, 8000, () => 0.999);
    expect(a0).toBeLessThan(500);
    expect(a1).toBeLessThan(1000);
    expect(a2).toBeLessThan(2000);
    expect(a1).toBeGreaterThanOrEqual(a0);
    expect(a2).toBeGreaterThanOrEqual(a1);
  });
  it('treats negative attempt as 0', () => {
    expect(backoffDelayMs(-5, 500, 8000, () => 0.5)).toBe(250);
  });
});

describe('R-46 isRetriableUploadError', () => {
  it.each([
    ['network error: ECONNRESET', true],
    ['github HTTP 500: foo', true],
    ['aliyunOss HTTP 502: bar', true],
    ['tencentCos HTTP 503: baz', true],
    ['customWeb HTTP 504: gateway', true],
    ['HTTP 408: timeout', true],
    ['HTTP 425: too early', true],
    ['qiniu HTTP 429: rate limit', true]
  ])('retriable: %s', (msg, want) => {
    expect(isRetriableUploadError(new Error(msg))).toBe(want);
  });
  it.each([
    ['github HTTP 401: bad token', false],
    ['aliyunOss HTTP 403: forbidden', false],
    ['HTTP 404: not found', false],
    ['HTTP 422: unprocessable', false],
    ['cancelled by user', false],
    ['upload cancelled', false],
    ['customWeb: url required', false]
  ])('not retriable: %s', (msg, want) => {
    expect(isRetriableUploadError(new Error(msg))).toBe(want);
  });
  it('handles non-Error values gracefully', () => {
    expect(isRetriableUploadError(undefined)).toBe(false);
    expect(isRetriableUploadError(null)).toBe(false);
    expect(isRetriableUploadError('')).toBe(false);
  });
});

describe('R-46 formatMediaLink', () => {
  it('markdown delegates to buildMarkdown', () => {
    expect(formatMediaLink('foo.gif', 'https://x', 'markdown')).toBe('![foo](https://x)');
  });
  it('html escapes alt and url quotes', () => {
    expect(formatMediaLink('a"b<c.gif', 'https://x?q="1"', 'html')).toBe(
      '<img src="https://x?q=&quot;1&quot;" alt="a&quot;b&lt;c" />'
    );
  });
  it('bbcode emits [img]url[/img]', () => {
    expect(formatMediaLink('a.gif', 'https://x', 'bbcode')).toBe('[img]https://x[/img]');
  });
  it('url returns the plain URL', () => {
    expect(formatMediaLink('a.gif', 'https://x', 'url')).toBe('https://x');
  });
  it('honours {name}/{ext} in html alt', () => {
    expect(formatMediaLink('foo.gif', 'https://x', 'html', '{name}.{ext}')).toBe('<img src="https://x" alt="foo.gif" />');
  });
});

describe('R-46 qiniuRegionQueryUrl', () => {
  it('builds the public UC v3 query URL', () => {
    expect(qiniuRegionQueryUrl('AK', 'my-bucket')).toBe(
      'https://uc.qbox.me/v3/query?ak=AK&bucket=my-bucket'
    );
  });
  it('URL-encodes special chars', () => {
    expect(qiniuRegionQueryUrl('AK with space', 'a/b')).toBe(
      'https://uc.qbox.me/v3/query?ak=AK%20with%20space&bucket=a%2Fb'
    );
  });
  it('throws on missing inputs', () => {
    expect(() => qiniuRegionQueryUrl('', 'b')).toThrow();
    expect(() => qiniuRegionQueryUrl('AK', '')).toThrow();
  });
});

describe('R-46 inferQiniuRegionFromUploadHost', () => {
  it.each([
    ['upload.qiniup.com', 'z0'],
    ['upload-z1.qiniup.com', 'z1'],
    ['upload-z2.qiniup.com', 'z2'],
    ['upload-na0.qiniup.com', 'na0'],
    ['upload-as0.qiniup.com', 'as0'],
    ['upload-cn-east-2.qiniup.com', 'cn-east-2'],
    ['https://upload-z1.qiniup.com', 'z1']
  ])('host %s → region %s', (host, region) => {
    expect(inferQiniuRegionFromUploadHost(host)).toBe(region);
  });
  it('returns undefined on unrecognised host', () => {
    expect(inferQiniuRegionFromUploadHost('upload-z9.qiniup.com')).toBeUndefined();
    expect(inferQiniuRegionFromUploadHost('')).toBeUndefined();
  });
});

describe('R-46 TINY_PNG_BYTES', () => {
  it('starts with the PNG magic header', () => {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(TINY_PNG_BYTES.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
  it('ends with IEND chunk', () => {
    // Last 8 bytes: IEND chunk type + crc — the literal "IEND" is at offset -8..-4.
    expect(TINY_PNG_BYTES.subarray(-8, -4).toString('ascii')).toBe('IEND');
  });
  it('is small (< 100 bytes)', () => {
    expect(TINY_PNG_BYTES.length).toBeLessThan(100);
  });
});
