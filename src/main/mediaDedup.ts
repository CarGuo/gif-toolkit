/**
 * Host-agnostic media URL canonicalisation for sniff result deduping.
 *
 * The same asset often appears multiple times while a page loads: one URL
 * for a small preview, one for a larger lazy-load candidate, one with a
 * preferred output format, and sometimes one direct original. These are
 * usually expressed as structural URL transforms, not as site-specific
 * product semantics. Keep this module free of Electron imports so static
 * sniff, embedded webview, and real-Chrome sniff can all share it.
 */

// Whole-segment path transforms.
const SEG_BLOGGER_RX = /^(?:s\d{2,5}|w\d{2,5}(?:-h\d{2,5})?|h\d{2,5}(?:-w\d{2,5})?)$/i;
const SEG_CLOUDINARY_RX = /^(?:[a-z]_[\w.-]+(?:,[a-z]_[\w.-]+)*)$/i;
const CLOUDINARY_KEYS = /(?:^|,)(?:w|h|c|q|f|x|y|r|e|g|dpr|ar|fl|so|du|eo|l|t|b|co|bo|o|a|z|pg)_/i;
const SEG_SEMANTIC_RX = /^(?:thumb|thumbs|thumbnail|thumbnails|max|resize|fit|fit-in|crop|scale|small|medium|large|original|orig)$/i;
const SEG_NUMERIC_RX = /^\d{2,5}$/;

// Colon-style transform segments used by many image/CDN pipelines:
// `resize:fit:1400`, `format:webp`, `quality:80`, etc. Detection is
// intentionally value-constrained, not host based (R-02), so business
// segments like `/videos/output:teaser/foo.mp4` are not stripped.
const COLON_IMAGE_FORMAT_RX = /^(?:avif|gif|jpg|jpeg|png|webp|mp4|webm|mov|m4v)$/i;
const COLON_GEOMETRY_VALUE_RX = /(?:^|[:,-])\d{2,5}(?:x\d{0,5})?(?:$|[:,-])/i;
const COLON_QUALITY_VALUE_RX = /^(?:auto|best|good|eco|low|lossless|\d{1,3})$/i;
const COLON_FIT_VALUE_RX = /^(?:clip|crop|fill|fit|inside|outside|scale|cover|contain|pad|thumb|thumbnail)$/i;
const COLON_AUTO_VALUE_RX = /^(?:compress|enhance|format|quality|webp|avif)$/i;

// Segment-tail transform suffixes.
const TAIL_GOOG_RX = /=(?:s\d{2,5}|w\d{2,5}(?:-h\d{2,5})?|h\d{2,5})(?:-[a-z0-9]+)?$/i;
const TAIL_COLON_RX = /:(?:large|orig|original|small|medium|thumb|thumbnail)$/i;

// Filename transforms.
const FN_WIKI_PX_RX = /^\d{2,5}px-/i;
const FN_NXN_RX = /[-_]\d{2,5}x\d{0,5}(?=\.[a-z0-9]+$)/i;
const FN_AT_X_RX = /@\d(?:\.\d)?x(?=\.[a-z0-9]+$)/i;
const FN_SEMANTIC_RX = /[-_](?:thumb|thumbnail|small|medium|large|orig|original)(?=\.[a-z0-9]+$)/i;

const EXT_FAMILY: Record<string, string> = { '.jpeg': '.jpg' };

// Display/cache/signature query params. Unknown keys are preserved so real
// business identifiers like `?id=a` and `?id=b` do not collapse together.
const PRESENTATION_QUERY_KEYS = new Set([
  'w', 'width', 'h', 'height', 'q', 'quality', 'format', 'fm', 'name', 'fit',
  'crop', 'auto', 'dpr', 'ixlib', 's', 'size', 'resize', 'scale', 'v',
  'ver', 'version', 't', 'ts', 'timestamp', 'cache', 'cachebust', 'cb'
]);

const SIGNATURE_QUERY_KEYS = new Set([
  'token', 'signature', 'sig', 'expires', 'expire', 'x-amz-signature',
  'x-amz-expires', 'x-amz-credential', 'x-amz-date', 'x-amz-algorithm'
]);

function normaliseFilename(name: string): string {
  let n = name;
  n = n.replace(FN_WIKI_PX_RX, '');
  n = n.replace(FN_NXN_RX, '');
  n = n.replace(FN_AT_X_RX, '');
  n = n.replace(FN_SEMANTIC_RX, '');
  const dot = n.lastIndexOf('.');
  if (dot >= 0) {
    const ext = n.slice(dot).toLowerCase();
    if (EXT_FAMILY[ext]) n = n.slice(0, dot) + EXT_FAMILY[ext];
  }
  return n;
}

function stripSegmentTail(seg: string): string {
  let s = seg;
  s = s.replace(TAIL_GOOG_RX, '');
  s = s.replace(TAIL_COLON_RX, '');
  return s;
}

function isTransformSegment(seg: string): boolean {
  if (!seg) return false;
  if (SEG_BLOGGER_RX.test(seg)) return true;
  if (SEG_CLOUDINARY_RX.test(seg) && CLOUDINARY_KEYS.test(',' + seg)) return true;
  if (SEG_SEMANTIC_RX.test(seg)) return true;
  if (isColonTransformSegment(seg)) return true;
  return false;
}

function isColonTransformSegment(seg: string): boolean {
  const colon = seg.indexOf(':');
  if (colon <= 0) return false;
  const key = seg.slice(0, colon).toLowerCase();
  const value = seg.slice(colon + 1);
  if (!value) return false;
  if (key === 'resize' || key === 'scale') return COLON_GEOMETRY_VALUE_RX.test(value);
  if (key === 'format' || key === 'fm' || key === 'output') return COLON_IMAGE_FORMAT_RX.test(value);
  if (key === 'quality' || key === 'q') return COLON_QUALITY_VALUE_RX.test(value);
  if (key === 'width' || key === 'height' || key === 'w' || key === 'h') return /^\d{2,5}$/.test(value);
  if (key === 'fit' || key === 'crop') return COLON_FIT_VALUE_RX.test(value);
  if (key === 'dpr') return /^\d(?:\.\d)?$/.test(value);
  if (key === 'auto') return value.split(',').every((part) => COLON_AUTO_VALUE_RX.test(part));
  return false;
}

function pathLooksLikeStableAsset(pathname: string): boolean {
  return /(?:^|\/)[^/?#]+\.(?:avif|gif|jpe?g|m4v|mov|mp4|png|webm|webp)(?:$|[/?#])/i.test(pathname);
}

function canonicalQuery(searchParams: URLSearchParams, stripSignatures: boolean): string {
  const kept: Array<[string, string]> = [];
  searchParams.forEach((value, key) => {
    const normalKey = key.toLowerCase();
    if (PRESENTATION_QUERY_KEYS.has(normalKey)) return;
    if (stripSignatures && SIGNATURE_QUERY_KEYS.has(normalKey)) return;
    kept.push([normalKey, value]);
  });
  kept.sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv));
  return kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export interface MediaVariantScoreInput {
  url: string;
  mime?: string;
  poster?: string;
  sizeBytes?: number;
}

export function mediaVariantScore(x: MediaVariantScoreInput): number {
  let s = 0;
  if (x.sizeBytes && x.sizeBytes > 0) s += 4;
  if (x.mime) s += 1;
  if (x.poster) s += 1;
  try {
    const u = new URL(x.url);
    let maxDim = 0;
    let demote = 0;
    for (const seg of u.pathname.split('/')) {
      if (!seg) continue;
      const m1 = /^(?:s|w|h)(\d{2,5})(?:-(?:w|h)(\d{2,5}))?$/i.exec(seg);
      if (m1) {
        const a = Number(m1[1]) || 0;
        const b = Number(m1[2]) || 0;
        maxDim = Math.max(maxDim, a, b);
      }
      const m2 = /(?:^|,)(?:w|h)_(\d{2,5})/i.exec(seg);
      if (m2) maxDim = Math.max(maxDim, Number(m2[1]) || 0);
      const m3 = /=(?:s|w|h)(\d{2,5})/i.exec(seg);
      if (m3) maxDim = Math.max(maxDim, Number(m3[1]) || 0);
      const mColon = /^(?:resize|width|height|w|h|scale):(.+)$/i.exec(seg);
      if (mColon && isColonTransformSegment(seg)) {
        for (const n of mColon[1].match(/\d{2,5}/g) || []) {
          maxDim = Math.max(maxDim, Number(n) || 0);
        }
      }
      if (/^(?:format|fm|output):/i.test(seg) && isColonTransformSegment(seg)) demote += 1;
      if (/:(?:large|orig|original)$/i.test(seg)) maxDim = Math.max(maxDim, 1600);
      if (/:(?:small|thumb|thumbnail)$/i.test(seg)) demote += 2;
      if (/^(?:thumb|thumbs|thumbnail|thumbnails|small)$/i.test(seg)) demote += 2;
      if (/^(?:large|original|orig)$/i.test(seg)) maxDim = Math.max(maxDim, 1600);
      const m4 = /[-_](\d{2,5})x(\d{0,5})(?=\.[a-z0-9]+$)/i.exec(seg);
      if (m4) maxDim = Math.max(maxDim, Number(m4[1]) || 0, Number(m4[2]) || 0);
      const m5 = /^(\d{2,5})px-/i.exec(seg);
      if (m5) maxDim = Math.max(maxDim, Number(m5[1]) || 0);
    }
    if (maxDim > 0) s += Math.min(5, Math.floor(maxDim / 400));
    s -= Math.min(4, demote);
  } catch {
    // ignore malformed URLs
  }
  return s;
}

export function canonicalMediaDedupKey(url: string): string {
  try {
    const u = new URL(url);
    const rawSegs = u.pathname.split('/');
    const segs: string[] = [];
    let prevWasSizingKeyword = false;
    for (let i = 0; i < rawSegs.length; i += 1) {
      let seg = rawSegs[i];
      if (i === rawSegs.length - 1 && seg) {
        seg = stripSegmentTail(seg);
        seg = normaliseFilename(seg);
      } else {
        seg = stripSegmentTail(seg);
      }
      if (!seg) {
        prevWasSizingKeyword = false;
        continue;
      }
      if (prevWasSizingKeyword && SEG_NUMERIC_RX.test(seg)) {
        prevWasSizingKeyword = false;
        continue;
      }
      if (isTransformSegment(seg)) {
        prevWasSizingKeyword = SEG_SEMANTIC_RX.test(seg);
        continue;
      }
      prevWasSizingKeyword = false;
      segs.push(seg);
    }
    if (segs.length >= 2 && segs[segs.length - 1] === segs[segs.length - 2]) {
      segs.pop();
    }
    const q = canonicalQuery(u.searchParams, pathLooksLikeStableAsset(u.pathname));
    return `${u.host.toLowerCase()}/${segs.join('/')}${q ? `?${q}` : ''}`;
  } catch {
    return url;
  }
}
