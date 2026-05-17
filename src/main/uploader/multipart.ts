/**
 * R-45 — Multipart/form-data builder used by customWeb + 七牛 uploaders.
 *
 * Why hand-rolled rather than `form-data`:
 *  - The renderer's package.json already pulls axios; adding form-data
 *    is one more node-module-resolution edge case in our asar bundle.
 *  - Our payload shape is dead simple: a fixed set of plain-text fields
 *    plus exactly one binary file field. A 50-line hand-built builder
 *    is auditable and avoids a transitive dep.
 *
 * Output is a pre-assembled Buffer (we have the file bytes in memory
 * already — these are GIFs/MP4s in the single-megabyte range, well
 * inside Electron's heap budget).
 */
import crypto from 'crypto';

export interface MultipartPart {
  name: string;
  value: string | Buffer;
  filename?: string;
  contentType?: string;
}

export interface MultipartResult {
  body: Buffer;
  contentType: string; // includes boundary= directive
  boundary: string;
}

export function buildMultipart(parts: MultipartPart[]): MultipartResult {
  const boundary = '----giftk' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`, 'utf8'));
    if (p.filename) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}`,
          'utf8'
        )
      );
      chunks.push(
        Buffer.from(
          `Content-Type: ${p.contentType || 'application/octet-stream'}${CRLF}${CRLF}`,
          'utf8'
        )
      );
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"${CRLF}${CRLF}`,
          'utf8'
        )
      );
    }
    chunks.push(typeof p.value === 'string' ? Buffer.from(p.value, 'utf8') : p.value);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  const body = Buffer.concat(chunks);
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
    boundary
  };
}
