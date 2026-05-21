import { describe, expect, it } from 'vitest';
import { canonicalMediaDedupKey, mediaVariantScore } from '../../src/main/mediaDedup';

describe('canonicalMediaDedupKey', () => {
  it('collapses generic path transform segments without host-specific branches', () => {
    const a = canonicalMediaDedupKey(
      'https://cdn.example.com/v2/resize:fit:1400/format:webp/1*asset.gif'
    );
    const b = canonicalMediaDedupKey(
      'https://cdn.example.com/v2/resize:fit:1440/1*asset.gif'
    );
    expect(a).toBe(b);
    expect(a).toBe('cdn.example.com/v2/1*asset.gif');
  });

  it('collapses the real Chrome history item variants from the Flutter article', () => {
    const urls = [
      'https://miro.medium.com/v2/resize:fit:2000/format:webp/1*jmKuW7ItWRJAHNABfTEhHA.gif',
      'https://miro.medium.com/v2/resize:fit:1400/format:webp/1*FyWSKI69_GcAv7MoAbPbww.gif',
      'https://miro.medium.com/v2/resize:fit:1400/1*FyWSKI69_GcAv7MoAbPbww.gif',
      'https://miro.medium.com/v2/resize:fit:1100/format:webp/1*BU1kKyxkWidSLXOA37nPLg.gif',
      'https://miro.medium.com/v2/resize:fit:1440/1*BU1kKyxkWidSLXOA37nPLg.gif',
      'https://miro.medium.com/v2/resize:fit:1100/format:webp/1*46fO6mit5AFOq9ZY7YtRmA.gif',
      'https://miro.medium.com/v2/resize:fit:1440/1*46fO6mit5AFOq9ZY7YtRmA.gif',
      'https://miro.medium.com/v2/resize:fit:1076/1*klfeLTPZihrgBRUmUzWaIA.gif'
    ];
    const keys = new Set(urls.map(canonicalMediaDedupKey));
    expect(keys.size).toBe(5);
  });

  it('keeps unknown business query params so distinct media do not collapse', () => {
    const a = canonicalMediaDedupKey('https://cdn.example.com/video.gif?id=a&w=400&q=70');
    const b = canonicalMediaDedupKey('https://cdn.example.com/video.gif?id=b&w=800&q=50');
    expect(a).not.toBe(b);
    expect(a).toContain('?id=a');
    expect(b).toContain('?id=b');
  });

  it('strips known presentation/cache/signature query params', () => {
    const a = canonicalMediaDedupKey('https://cdn.example.com/video.gif?w=400&q=70&token=abc&v=1');
    const b = canonicalMediaDedupKey('https://cdn.example.com/video.gif?w=800&q=20&token=def&v=2');
    expect(a).toBe(b);
    expect(a).toBe('cdn.example.com/video.gif');
  });

  it('keeps signature-like query params on opaque endpoints without a stable asset filename', () => {
    const a = canonicalMediaDedupKey('https://api.example.com/media?token=a');
    const b = canonicalMediaDedupKey('https://api.example.com/media?token=b');
    expect(a).not.toBe(b);
  });

  it('does not strip colon path segments whose values look like business labels', () => {
    const teaser = canonicalMediaDedupKey('https://cdn.example.com/videos/output:teaser/foo.mp4');
    const full = canonicalMediaDedupKey('https://cdn.example.com/videos/output:full/foo.mp4');
    expect(teaser).not.toBe(full);
  });

  it('scores larger and direct colon-style variants above smaller formatted variants', () => {
    const smallWebp = mediaVariantScore({
      url: 'https://cdn.example.com/v2/resize:fit:200/format:webp/foo.gif'
    });
    const largeDirect = mediaVariantScore({
      url: 'https://cdn.example.com/v2/resize:fit:1440/foo.gif'
    });
    expect(largeDirect).toBeGreaterThan(smallWebp);
  });
});
