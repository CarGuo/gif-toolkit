/**
 * R-COVERAGE-REAL-SCENARIO — Mock OSS upload backend (test-only).
 *
 * Why this file exists
 * --------------------
 * The realPipeline e2e suite needs to drive a full
 *   offline-import → process → upload → history-url
 * chain end-to-end. Hitting any production backend (七牛 / OSS / GitHub)
 * from CI is impossible (no creds, no network policy clearance) and
 * pointing at a localhost http server is also blocked because the
 * uploader's `customWeb` branch only allows http:// for localhost AND
 * the sniff path is gated by `assertHttpUrl + isPrivateHost` on the
 * way in. So the e2e suite needs a backend that:
 *   - Performs zero network I/O (deterministic, no flakes).
 *   - Returns a stable, parseable URL the renderer can persist into
 *     the upload-history panel and click on.
 *   - Cannot be enabled by an end user (must not pollute production
 *     code paths even if the bundle is shipped).
 *
 * Contract — same shape as backends.ts:
 *   uploadMockOss(args): Promise<{ url: string }>
 *
 * URL shape: `mock-oss://<sha8>.<ext>` where:
 *   - `sha8`  = first 8 hex chars of sha256(fileBytes), to make
 *               same-bytes uploads deterministic and dedupable.
 *   - `ext`   = file extension preserved verbatim from `fileName`.
 *
 * Activation guard — see {@link isMockUploadEnabled}. The backend is
 * ONLY routed in `dispatchUpload` when:
 *   - `process.env.GIFTK_E2E_MOCK_UPLOAD === '1'`, AND
 *   - the Electron app is NOT packaged (i.e. running from
 *     `dist/main/index.js` under playwright, never inside a built
 *     `.app` / `.exe` / `.AppImage`).
 *
 * Why both guards? Either alone is insufficient:
 *   - NODE_ENV alone (`!== 'production'`) is too permissive: the e2e
 *     suite intentionally launches Electron with `NODE_ENV=production`
 *     to exercise the real preload bridge, which would disable mock-
 *     mode just when we need it.
 *   - `app.isPackaged` alone could in theory be tripped from a dev
 *     build the user runs from `npm run dev`, polluting their real
 *     upload-history.
 *
 * The combination — explicit env opt-in + un-packaged shell — is what
 * keeps mock-mode strictly inside our test harness.
 */
import { createHash } from 'crypto';
import path from 'path';
import { app } from 'electron';

export interface MockOssArgs {
  fileBytes: Buffer;
  fileName: string;
}

export interface MockOssResult {
  url: string;
}

const ENV_FLAG = 'GIFTK_E2E_MOCK_UPLOAD';
const ENV_ON = '1';

/**
 * Returns true iff the mock upload backend is allowed to run in this
 * process. See file header for guard rationale. Exposed for unit tests
 * and `dispatchUpload`'s short-circuit.
 */
export function isMockUploadEnabled(): boolean {
  if (process.env[ENV_FLAG] !== ENV_ON) return false;
  try {
    if (app && app.isPackaged) return false;
  } catch {
    return false;
  }
  return true;
}

export async function uploadMockOss(args: MockOssArgs): Promise<MockOssResult> {
  const { fileBytes, fileName } = args;
  if (!Buffer.isBuffer(fileBytes) || fileBytes.length === 0) {
    throw new Error('mockOss: fileBytes required');
  }
  const safeName = typeof fileName === 'string' && fileName.length > 0 ? fileName : 'upload.bin';
  const sha = createHash('sha256').update(fileBytes).digest('hex').slice(0, 8);
  const ext = path.extname(safeName).replace(/^\./, '') || 'bin';
  return { url: `mock-oss://${sha}.${ext}` };
}
