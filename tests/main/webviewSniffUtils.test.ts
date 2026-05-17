/**
 * R-44 — Tests for the webview-sniff pure helpers.
 *
 * These cover the non-Electron pieces of `webviewSniffUtils.ts`:
 *  - Content-Type → MediaKind classification (video/gif/animated webp).
 *  - Lightweight dedup key (host + pathname, query stripped).
 *  - Merge function: dedup, hard cap, source stamping.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyByContentType,
  mediaId,
  mergeWebviewMedia,
  webviewDedupKey,
  WEBVIEW_MAX_ITEMS,
  WEBVIEW_TOOLBAR_HEIGHT,
  innerViewBounds
} from '../../src/main/webviewSniffUtils';
import type { SniffedMedia } from '../../src/shared/types';

describe('classifyByContentType', () => {
  it('returns null for empty / nullish / non-media types', () => {
    expect(classifyByContentType(null)).toBeNull();
    expect(classifyByContentType(undefined)).toBeNull();
    expect(classifyByContentType('')).toBeNull();
    expect(classifyByContentType('text/html; charset=utf-8')).toBeNull();
    expect(classifyByContentType('application/json')).toBeNull();
  });

  it('classifies video/* as video regardless of subtype', () => {
    expect(classifyByContentType('video/mp4')).toBe('video');
    expect(classifyByContentType('video/webm')).toBe('video');
    expect(classifyByContentType('VIDEO/QUICKTIME')).toBe('video');
  });

  it('classifies image/gif as gif (split out from generic image)', () => {
    expect(classifyByContentType('image/gif')).toBe('gif');
    // Confirm casing + parameter trailing does not regress the split:
    expect(classifyByContentType('Image/Gif; foo=bar')).toBe('gif');
  });

  it('reports image/webp + image/apng as gif (animated branch)', () => {
    expect(classifyByContentType('image/webp')).toBe('gif');
    expect(classifyByContentType('image/apng')).toBe('gif');
  });

  it('classifies remaining image/* as plain image', () => {
    expect(classifyByContentType('image/png')).toBe('image');
    expect(classifyByContentType('image/jpeg')).toBe('image');
    expect(classifyByContentType('image/avif')).toBe('image');
  });

  it('strips parameters before matching', () => {
    expect(classifyByContentType('video/mp4; codecs="avc1.42E01E"')).toBe('video');
  });
});

describe('webviewDedupKey', () => {
  it('combines host + pathname, lower-cased', () => {
    expect(webviewDedupKey('https://CDN.Example.com/Path/Foo.MP4')).toBe('cdn.example.com/path/foo.mp4');
  });

  it('strips query string and hash so cache-busters do not produce ghost duplicates', () => {
    const a = webviewDedupKey('https://x.com/a/b.gif?v=1');
    const b = webviewDedupKey('https://x.com/a/b.gif?v=2&token=abc#frag');
    expect(a).toBe(b);
  });

  it('falls back to raw url when not a valid URL', () => {
    expect(webviewDedupKey('not a url')).toBe('not a url');
  });
});

describe('mediaId', () => {
  it('produces a 16-char lowercase hex digest', () => {
    const id = mediaId('https://example.com/foo.gif');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(mediaId('a')).toBe(mediaId('a'));
    expect(mediaId('a')).not.toBe(mediaId('b'));
  });
});

describe('mergeWebviewMedia', () => {
  const PAGE = 'https://example.com/post/1';

  it('stamps every produced media with source="webview"', () => {
    const map = new Map<string, SniffedMedia>();
    mergeWebviewMedia(map, [
      { url: 'https://x.com/a.gif', kind: 'gif', pageUrl: PAGE }
    ]);
    expect(map.size).toBe(1);
    const m = Array.from(map.values())[0];
    expect(m.source).toBe('webview');
    expect(m.kind).toBe('gif');
    expect(m.pageUrl).toBe(PAGE);
    expect(m.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('first-write-wins: a later DOM-scan duplicate does not overwrite an earlier network capture', () => {
    const map = new Map<string, SniffedMedia>();
    mergeWebviewMedia(map, [
      { url: 'https://x.com/a.gif?v=net', kind: 'gif', mime: 'image/gif', pageUrl: PAGE }
    ]);
    mergeWebviewMedia(map, [
      // Same dedup key (query stripped); should be ignored.
      { url: 'https://x.com/a.gif?v=dom', kind: 'gif', pageUrl: PAGE }
    ]);
    expect(map.size).toBe(1);
    const m = Array.from(map.values())[0];
    expect(m.url).toBe('https://x.com/a.gif?v=net');
    expect(m.mime).toBe('image/gif');
  });

  it('respects the WEBVIEW_MAX_ITEMS cap', () => {
    const map = new Map<string, SniffedMedia>();
    const candidates = Array.from({ length: WEBVIEW_MAX_ITEMS + 5 }, (_, i) => ({
      url: `https://x.com/m${i}.mp4`,
      kind: 'video' as const,
      pageUrl: PAGE
    }));
    mergeWebviewMedia(map, candidates);
    expect(map.size).toBe(WEBVIEW_MAX_ITEMS);
  });

  it('preserves mime when provided', () => {
    const map = new Map<string, SniffedMedia>();
    mergeWebviewMedia(map, [
      { url: 'https://x.com/a.mp4', kind: 'video', mime: 'video/mp4', pageUrl: PAGE }
    ]);
    expect(Array.from(map.values())[0].mime).toBe('video/mp4');
  });
});

describe('innerViewBounds (R-47 chrome-shell layout)', () => {
  it('places the inner view directly below the toolbar', () => {
    const r = innerViewBounds(1100, 800);
    expect(r.x).toBe(0);
    expect(r.y).toBe(WEBVIEW_TOOLBAR_HEIGHT);
    expect(r.width).toBe(1100);
    expect(r.height).toBe(800 - WEBVIEW_TOOLBAR_HEIGHT);
  });

  it('floors fractional sizes (Electron content-bounds occasionally yields .5px)', () => {
    const r = innerViewBounds(1100.7, 800.9);
    expect(r.width).toBe(1100);
    expect(r.height).toBe(Math.floor(800.9 - WEBVIEW_TOOLBAR_HEIGHT));
  });

  it('clamps to zero rather than producing negative dimensions', () => {
    const r = innerViewBounds(0, 0);
    expect(r.width).toBe(0);
    expect(r.height).toBe(0);
    expect(r.y).toBe(WEBVIEW_TOOLBAR_HEIGHT);
  });

  it('clamps when content height is smaller than the toolbar', () => {
    const r = innerViewBounds(400, 20);
    expect(r.height).toBe(0);
  });
});
