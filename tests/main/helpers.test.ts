/**
 * Tests for src/main/helpers.ts — URL/host filtering and filename safety.
 *
 * Why these tests matter:
 *  - isPrivateHost is a SECURITY filter (SSRF prevention in sniff). Wrong
 *    answers here = arbitrary local-network access from a malicious page.
 *  - safeName is the LAST line of defence against path traversal and OS
 *    reserved names (CON, PRN…) when writing user-supplied filenames.
 *  - fileNameFor decides the on-disk filename of every output gif and the
 *    extension hint the rest of the pipeline relies on.
 */
import { describe, expect, it } from 'vitest';
import { fileNameFor, isPrivateHost, safeName } from '../../src/main/helpers';
import type { SniffedMedia } from '../../src/shared/types';

const mkMedia = (over: Partial<SniffedMedia> = {}): SniffedMedia => ({
  id: 'm-1',
  url: 'https://example.com/cat.gif',
  kind: 'gif',
  ...over
});

describe('isPrivateHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.5.5.5', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.0.1', true],
    ['169.254.0.1', true],
    ['0.0.0.0', true],
    ['255.255.255.255', true],
    ['::1', true],
    ['fc00::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['[::1]', true],
    ['172.32.0.1', false],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['example.com', false],
    ['google.com', false],
    ['2606:4700::1111', false]
  ])('isPrivateHost(%s) → %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it('treats empty / whitespace as private (deny by default)', () => {
    expect(isPrivateHost('')).toBe(true);
    expect(isPrivateHost('   ')).toBe(true);
  });
});

describe('safeName', () => {
  it('replaces shell/path metacharacters with underscores', () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j.gif')).toBe('a_b_c_d_e_f_g_h_i_j.gif');
  });

  it('strips control characters and zero-width unicode', () => {
    expect(safeName('foo\u0000\u200Bbar.gif')).toBe('foobar.gif');
  });

  it('collapses whitespace runs', () => {
    expect(safeName('hello   world.gif')).toBe('hello_world.gif');
  });

  it('rejects empty after sanitisation by returning a placeholder', () => {
    expect(safeName('')).toBe('_');
    expect(safeName('///')).toBe('_');
  });

  it('caps total length at 120 chars', () => {
    const long = 'a'.repeat(500) + '.gif';
    const out = safeName(long);
    expect(out.length).toBe(120);
  });

  it('prefixes Windows reserved device names', () => {
    expect(safeName('CON.gif')).toBe('_CON.gif');
    expect(safeName('aux.txt')).toBe('_aux.txt');
    expect(safeName('LPT9.png')).toBe('_LPT9.png');
    // Not reserved: regular names
    expect(safeName('console.gif')).toBe('console.gif');
  });

  it('deduplicates against batchTaken with a deterministic short hash', () => {
    const taken = new Set<string>();
    const a = safeName('cat.gif', taken);
    const b = safeName('cat.gif', taken);
    expect(a).toBe('cat.gif');
    expect(b).not.toBe('cat.gif');
    expect(b).toMatch(/^cat-[a-f0-9]{6}\.gif$/);
    expect(taken.has(a)).toBe(true);
    expect(taken.has(b)).toBe(true);
  });

  // R-FN-1 — Regression for the "E7_8C_B4_E5_93_A5..." disk filename
  // bug. Percent-encoded inputs were being routed through the sanitiser
  // unchanged, so the `%` was rewritten to `_` and the filename became
  // a long underscore-separated UTF-8 byte string. The fix decodes the
  // percent-escaping FIRST and widens the allowed-char set to Unicode
  // letters/numbers so the decoded CJK survives the sanitiser.
  it('decodes percent-encoded bytes before sanitising', () => {
    // %E7%8C%B4%E5%93%A5 = "猴哥"
    expect(safeName('%E7%8C%B4%E5%93%A5.mp4')).toBe('猴哥.mp4');
  });

  it('preserves CJK characters in already-decoded inputs', () => {
    expect(safeName('猴哥_解析_81式自动步枪.mp4')).toBe('猴哥_解析_81式自动步枪.mp4');
  });

  it('preserves accented latin characters', () => {
    expect(safeName('café-déjà-vu.gif')).toBe('café-déjà-vu.gif');
  });

  it('preserves hiragana / katakana / hangul', () => {
    expect(safeName('こんにちは.gif')).toBe('こんにちは.gif');
    expect(safeName('カタカナ.gif')).toBe('カタカナ.gif');
    expect(safeName('한글.gif')).toBe('한글.gif');
  });

  it('still scrubs path separators inside CJK names', () => {
    // Defence-in-depth: unicode letters allowed, but `/` and `\` still
    // collapse to `_` so a malicious "猴/../etc/passwd" can't escape.
    // `/` collapses to `_`; `..` survives because `.` is in the allow-list,
    // but the leading directory escape is now harmless once flattened.
    expect(safeName('猴哥/../恶意.gif')).toBe('猴哥_.._恶意.gif');
  });

  it('treats malformed percent-escapes as literal (no throw)', () => {
    // Lone `%` with non-hex follow-up — decodeURIComponent throws,
    // tryDecodePercent should fall through to keep the literal which
    // then gets sanitised normally.
    expect(safeName('foo%ZZbar.gif')).toBe('foo_ZZbar.gif');
  });

  it('flattens emoji / pictographs to `_` (not allowed in disk names)', () => {
    // Emoji are technically `\p{So}` (Other Symbol), not `\p{L}`, so
    // they're sanitised. We accept this — emoji-named files are an
    // edge case not worth the cross-platform rendering risk.
    expect(safeName('hello🎉world.gif')).toBe('hello_world.gif');
  });
});

describe('fileNameFor', () => {
  it('strips the URL extension and uses the bare stem when no suffix is supplied', () => {
    // fileNameFor splits off the URL extension; callers (processor.ts) are
    // expected to pass a suffix like ".gif" / ".part1.gif" themselves.
    expect(fileNameFor(mkMedia({ url: 'https://x.com/a/b/c.gif' }))).toBe('c');
  });

  it('appends caller-provided extension via suffix', () => {
    expect(fileNameFor(mkMedia({ url: 'https://x.com/a/b/c.gif' }), '.gif')).toBe('c.gif');
  });

  it('falls back to media.id when URL parsing fails', () => {
    expect(fileNameFor(mkMedia({ url: 'not a url', id: 'fallback' }))).toBe('fallback.gif');
  });

  it('appends a suffix that already carries an extension verbatim', () => {
    expect(fileNameFor(mkMedia({ url: 'https://x.com/cat.gif' }), '.part1.gif')).toBe('cat.part1.gif');
  });

  it('infers extension from media.kind when URL is extensionless and no suffix is given', () => {
    expect(fileNameFor(mkMedia({ url: 'https://x.com/raw', kind: 'video' })))
      .toBe('raw.mp4');
  });

  it('does NOT re-infer when suffix already encodes an extension', () => {
    // suffix ".part1.gif" looks like an extension at the tail → not inferred.
    expect(
      fileNameFor(mkMedia({ url: 'https://x.com/raw', kind: 'video' }), '.part1.gif')
    ).toBe('raw.part1.gif');
  });

  it('prefers resolved.mime over media.kind for extension inference', () => {
    expect(
      fileNameFor(
        mkMedia({
          url: 'https://x.com/raw',
          kind: 'video',
          resolved: { url: 'https://r/url', mime: 'video/webm' } as SniffedMedia['resolved']
        })
      )
    ).toBe('raw.webm');
  });

  it('produces unique names within a batch via short hash', () => {
    const batch = new Set<string>();
    const a = fileNameFor(mkMedia({ url: 'https://x.com/dup.gif', id: 'a' }), '.gif', batch);
    const b = fileNameFor(mkMedia({ url: 'https://x.com/dup.gif', id: 'b' }), '.gif', batch);
    expect(a).toBe('dup.gif');
    expect(b).toMatch(/^dup-[a-f0-9]{6}\.gif$/);
  });
});
