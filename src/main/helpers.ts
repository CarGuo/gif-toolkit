import path from 'path';
import crypto from 'crypto';
import type { SniffedMedia } from '../shared/types';

/* ----------------------- URL / host helpers ----------------------- */

function isPrivateIPv4(host: string): boolean {
  if (host === '0.0.0.0' || host === '255.255.255.255') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n < 0 || n > 255 || !Number.isFinite(n))) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIPv6(rawHost: string): boolean {
  let h = rawHost;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const z = h.indexOf('%');
  if (z >= 0) h = h.slice(0, z);
  h = h.toLowerCase();
  if (!h.includes(':')) return false;
  if (h === '::1') return true;
  if (h === '::' || h === '0:0:0:0:0:0:0:0') return true;
  if (/^fc[0-9a-f]{2}:/.test(h) || /^fd[0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

export function isPrivateHost(rawHost: string): boolean {
  if (!rawHost) return true;
  let host = rawHost.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.toLowerCase();
  if (!host) return true;
  if (host === 'localhost') return true;
  if (isPrivateIPv4(host)) return true;
  if (isPrivateIPv6(host)) return true;
  return false;
}

/* ----------------------- File-name helpers ----------------------- */

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

export function safeName(input: string, batchTaken?: Set<string>): string {
  let s = (input || '').normalize('NFKC');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g, '');
  s = s.replace(/[\\/:*?"<>|]+/g, '_');
  s = s.replace(/\s+/g, '_');
  s = s.replace(/[^a-zA-Z0-9._-]+/g, '_');
  s = s.replace(/^[._\s-]+|[._\s-]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120);
  const stem = s.replace(/\.[^.]+$/, '');
  if (WIN_RESERVED.test(stem)) {
    s = `_${s}`;
  }
  if (!s) s = '_';
  if (batchTaken) {
    if (batchTaken.has(s)) {
      const hash = crypto.createHash('sha1').update(`${s}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 6);
      const dotIdx = s.lastIndexOf('.');
      s = dotIdx > 0 ? `${s.slice(0, dotIdx)}-${hash}${s.slice(dotIdx)}` : `${s}-${hash}`;
    }
    batchTaken.add(s);
  }
  return s;
}

/** Best-effort extension for cache files when the URL pathname has none.
 *  ffprobe / ffmpeg / sharp are far more tolerant when the input filename
 *  hints at the container (e.g. SABR-throttled googlevideo streams whose
 *  header bytes are dirty still get correctly demuxed when the file ends
 *  in `.mp4`). Without this hint, ffprobe often errors with
 *  "Invalid data found when processing input". */
function defaultExtFor(media: SniffedMedia): string {
  const mime = (media.resolved?.mime || media.mime || '').toLowerCase();
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime') || mime.includes('mov')) return '.mov';
  if (mime.includes('matroska') || mime.includes('mkv')) return '.mkv';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (media.kind === 'video') return '.mp4';
  if (media.kind === 'gif') return '.gif';
  if (media.kind === 'image') return '.bin';
  return '';
}

export function fileNameFor(media: SniffedMedia, suffix = '', batchTaken?: Set<string>): string {
  let base: string;
  try {
    base = path.basename(new URL(media.url).pathname) || media.id;
  } catch {
    base = media.id;
  }
  const cleaned = safeName(base);
  const hadExt = /\.[^.]+$/.test(cleaned);
  const stem = cleaned.replace(/\.[^.]+$/, '') || safeName(media.id);
  // When suffix already carries an extension (e.g. ".gif" / ".part1.gif" or
  // ".s0.f12.w800.diff"), leave the basename untouched. Otherwise, when the
  // source URL had no extension AND no suffix override, infer one from the
  // resolved mime / media.kind so ffprobe gets a usable container hint.
  const suffixHasExt = /\.[a-zA-Z0-9]{1,6}$/.test(suffix);
  const inferredExt = !hadExt && !suffixHasExt ? defaultExtFor(media) : '';
  const final = `${stem}${suffix}${inferredExt}`;
  if (batchTaken) {
    if (batchTaken.has(final)) {
      const hash = crypto.createHash('sha1').update(`${final}-${media.id}`).digest('hex').slice(0, 6);
      const dotIdx = final.lastIndexOf('.');
      const renamed = dotIdx > 0 ? `${final.slice(0, dotIdx)}-${hash}${final.slice(dotIdx)}` : `${final}-${hash}`;
      batchTaken.add(renamed);
      return renamed;
    }
    batchTaken.add(final);
  }
  return final;
}
