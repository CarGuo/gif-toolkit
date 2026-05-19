/**
 * R-79b — Shared schema-versioning + migration helper for the
 * renderer's localStorage-backed history hooks.
 *
 * Background
 * ----------
 * Until R-79b every hook (`useHistory` / `useUploadHistory` /
 * `useSniffHistory` / `useToolbox`) wrote its data as a bare JSON
 * array under a versioned key (`giftk.history.v1`, etc.). The "v1"
 * suffix in the key never had a corresponding `version` field in
 * the *payload* — readers relied entirely on per-field defensive
 * `typeof` checks to absorb shape drift. That worked while every
 * change was *additive* (e.g. R-54 added `uploadsByOutputPath`),
 * but it has no story for breaking changes:
 *
 *   - rename:   `outputDir` → `outputDirs[]`
 *   - widen:    `taskStatus: TaskStatus` → `{status, error}` object
 *   - drop:     remove a deprecated field
 *
 * Today we'd be forced to either bump the *key* (orphaning the
 * user's old data) or sprinkle ad-hoc compatibility branches
 * through every reader.
 *
 * Design
 * ------
 * - We keep the same localStorage keys (no data loss for users who
 *   already have history written to disk).
 * - On read, the helper accepts BOTH legacy "bare array" payloads
 *   AND the new envelope `{ version, payload }`. A bare array is
 *   treated as version === 0 — older shapes that pre-date the
 *   migrator framework.
 * - Callers pass an array of upgrade functions, one per version
 *   step, each `(prev: unknown[]) => unknown[]`. The helper runs
 *   them in order from `parsedVersion + 1` up to `currentVersion`.
 * - On write, the helper always emits the new envelope with the
 *   caller's `currentVersion`, so subsequent reads see the right
 *   number.
 *
 * Why not Zod / runtime schema validators?
 *   - We deliberately keep the payload validation in the caller
 *     (each hook already has its own per-field defensive code
 *     tuned to its shape). The migrator's job is the *version
 *     contract*, not field-level validation.
 *   - Zod would add ~50KB to the renderer bundle for a feature we
 *     only call on app boot.
 *
 * Failure model: readers must NEVER throw. Any parse error / type
 * mismatch / migrator throw is swallowed and the caller gets an
 * empty array — history is a convenience feature, not load-bearing
 * for the rest of the app.
 *
 * R-80 — when we move to SQLite (see R-80-SQLITE-NOTES.md), this
 * helper stays alive on the renderer side as a "first-time import
 * shim": on app boot the SQLite store will check whether the
 * localStorage keys still exist and, if so, fold them into the
 * database via `withSchemaMigrations` then delete the keys.
 */

/**
 * One step of a schema upgrade: take the previous shape's array and
 * return the next shape's array. Implementations MUST be pure and
 * MUST NOT throw — wrap any per-row coercion in try/catch and drop
 * malformed rows.
 */
export type Migrator = (prev: unknown[]) => unknown[];

export interface ReadResult<T> {
  /** Migrated, normalised payload. Always a (possibly empty) array. */
  payload: T[];
  /** True when the on-disk version was older than `currentVersion`,
   *  meaning a migration ran and the caller MAY want to flush the
   *  upgraded shape back to disk on the next write. We don't auto-
   *  write inside the read path so a render that only *displays* the
   *  data doesn't synchronously hit localStorage.setItem. */
  upgraded: boolean;
}

/**
 * Read & migrate a versioned localStorage key. The caller supplies
 * a `currentVersion` and a `migrators` array indexed by *target*
 * version (so `migrators[2]` runs when upgrading from v1 → v2).
 * `migrators[0]` is unused (there is no "upgrade to v0").
 *
 * @example
 *   const result = readVersionedStorage<HistoryRecord>({
 *     key: HISTORY_STORAGE_KEY,
 *     currentVersion: 1,
 *     migrators: []  // no migrations defined yet
 *   });
 *   const records = result.payload;
 */
export function readVersionedStorage<T>(args: {
  key: string;
  currentVersion: number;
  migrators: ReadonlyArray<Migrator>;
}): ReadResult<T> {
  const empty: ReadResult<T> = { payload: [], upgraded: false };
  if (typeof window === 'undefined' || !window.localStorage) return empty;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(args.key);
  } catch {
    return empty;
  }
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }

  // Detect envelope vs legacy bare-array.
  let version = 0;
  let payload: unknown[];
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'version' in parsed &&
    'payload' in parsed
  ) {
    const env = parsed as { version: unknown; payload: unknown };
    version = typeof env.version === 'number' ? env.version : 0;
    payload = Array.isArray(env.payload) ? env.payload : [];
  } else if (Array.isArray(parsed)) {
    // Legacy "bare array" — treat as v0. The first migrator (if any)
    // will lift it to v1 or higher; if none exists the caller's
    // defensive parser still needs to handle the legacy shape.
    payload = parsed;
  } else {
    return empty;
  }

  // Run migrators in order. Each migrator MUST NOT throw — the
  // outer try/catch is defence-in-depth for buggy implementations.
  try {
    for (let v = version + 1; v <= args.currentVersion; v += 1) {
      const m = args.migrators[v];
      if (typeof m === 'function') {
        payload = m(payload);
        if (!Array.isArray(payload)) payload = [];
      }
    }
  } catch {
    // A migrator blew up — log nothing (renderer should not crash on
    // a corrupted blob) and return what we had pre-migration so the
    // caller's defensive parser can salvage individual rows.
  }

  return {
    payload: payload as T[],
    upgraded: version < args.currentVersion
  };
}

/**
 * Write a payload under the new envelope shape. ALL writes after
 * R-79b adopt the envelope; readers continue to accept legacy
 * bare-array blobs forever (one-way migration is fine because old
 * builds never see new keys, and new builds upgrade on read).
 */
export function writeVersionedStorage<T>(args: {
  key: string;
  currentVersion: number;
  payload: ReadonlyArray<T>;
}): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  const envelope = { version: args.currentVersion, payload: args.payload };
  try {
    window.localStorage.setItem(args.key, JSON.stringify(envelope));
    return true;
  } catch {
    // Quota / privacy mode / TypeError on circular refs. Try a one-
    // shot recovery: nuke the key and write again with the same
    // payload (caller already trimmed it to a sensible size).
    try {
      window.localStorage.removeItem(args.key);
      window.localStorage.setItem(args.key, JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * R-80 — Bootstrap import marker. Stored in localStorage once the
 * one-time SQLite import has completed successfully so subsequent
 * boots short-circuit out of the import code path entirely (the
 * four legacy keys may already be deleted, but a paranoid user who
 * manually re-pasted an old key shouldn't trigger a re-import that
 * conflicts with rows the user has since edited in the DB).
 */
export const DB_BOOTSTRAP_DONE_KEY = 'giftk.db.bootstrap.v1';

/**
 * R-80 — All four legacy localStorage history keys. Centralised here
 * so the bootstrap importer + future cleanup tools agree on the
 * canonical list without each module re-declaring its own constant.
 */
export const LEGACY_HISTORY_KEYS = {
  history: 'giftk.history.v1',
  uploadHistory: 'giftk.uploadHistory.v1',
  sniffHistory: 'giftk.sniffHistory.v1',
  toolboxHistory: 'giftk.toolbox.history.v1'
} as const;

/**
 * R-80 — Run the one-time bootstrap import from the four legacy
 * localStorage keys into the main-process SQLite store.
 *
 * Contract:
 *  - Idempotent across crashes: we set the marker AFTER a successful
 *    import; a crash before that point re-runs INSERT OR IGNORE on
 *    next boot.
 *  - Lossless on read failure: if the legacy key is malformed we
 *    pass the raw string verbatim and let main's defensive parser
 *    drop bad rows. We never JSON.parse on the renderer side.
 *  - Non-blocking on missing bridge: if `window.giftk?.db` is
 *    unavailable (preload regression, dev-server hot reload mid-
 *    refresh, …) the function resolves to `null` so callers can
 *    proceed to read straight from the DB and the import retries
 *    on the next boot.
 *  - Cleanup: on a successful resolve we remove the four legacy
 *    keys so a subsequent boot's read-back from the DB is the only
 *    source of truth.
 */
export async function bootstrapImportFromLocalStorage(): Promise<{
  history: number;
  uploadHistory: number;
  sniffHistory: number;
  toolboxHistory: number;
} | null> {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  if (!window.giftk?.db?.bootstrapImport) return null;
  let alreadyDone = false;
  try {
    alreadyDone = window.localStorage.getItem(DB_BOOTSTRAP_DONE_KEY) === '1';
  } catch {
    /* private mode etc. — proceed and let main de-dup via INSERT OR IGNORE. */
  }
  if (alreadyDone) return { history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0 };

  const read = (k: string): string | null => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const payload = {
    history: read(LEGACY_HISTORY_KEYS.history),
    uploadHistory: read(LEGACY_HISTORY_KEYS.uploadHistory),
    sniffHistory: read(LEGACY_HISTORY_KEYS.sniffHistory),
    toolboxHistory: read(LEGACY_HISTORY_KEYS.toolboxHistory)
  };
  // If every slot is empty there's nothing to do — still mark done
  // so we don't repeat the (cheap but pointless) round-trip on every
  // boot. Returning zero-counts lets callers distinguish "imported
  // 0 rows" from "import was skipped because it ran previously".
  const allEmpty = !payload.history && !payload.uploadHistory && !payload.sniffHistory && !payload.toolboxHistory;
  if (allEmpty) {
    try {
      window.localStorage.setItem(DB_BOOTSTRAP_DONE_KEY, '1');
    } catch {
      /* best-effort */
    }
    return { history: 0, uploadHistory: 0, sniffHistory: 0, toolboxHistory: 0 };
  }

  // R-80 hardening — main now reports per-family success/failure.
  // Result shape: { history, uploadHistory, sniffHistory, toolboxHistory,
  //                 succeededFamilies, failedFamilies }
  // We selectively delete only the legacy keys whose family
  // succeeded; failures keep their key so the next boot retries.
  let result: {
    history: number;
    uploadHistory: number;
    sniffHistory: number;
    toolboxHistory: number;
    succeededFamilies?: Array<'history' | 'uploadHistory' | 'sniffHistory' | 'toolboxHistory'>;
    failedFamilies?: Array<{ family: string; error: string }>;
  };
  try {
    result = (await window.giftk.db.bootstrapImport(payload)) as typeof result;
  } catch (err) {
    // Main rejected entirely — leave every legacy key in place so a
    // future boot can retry the whole import. Surface the failure as
    // a one-shot toast via the dbErrorBus so the user knows the
    // legacy data hasn't moved into the DB this boot.
    try {
      const { reportDbError } = await import('./dbErrorBus');
      reportDbError('bootstrap', 'import', err);
    } catch {
      /* dbErrorBus import itself failed — give up silently. */
    }
    return null;
  }

  // Selectively delete only the succeeded families' legacy keys.
  // Default to "delete all four" for older-main-process compatibility
  // (a build that doesn't yet report `succeededFamilies` is treated
  // as success across the board because the IPC resolved without
  // throwing).
  const succeeded = result.succeededFamilies ?? [
    'history',
    'uploadHistory',
    'sniffHistory',
    'toolboxHistory'
  ];
  const failed = result.failedFamilies ?? [];
  try {
    for (const family of succeeded) {
      const key = LEGACY_HISTORY_KEYS[family as keyof typeof LEGACY_HISTORY_KEYS];
      if (key) window.localStorage.removeItem(key);
    }
    // Only flip the bootstrap-done marker once *every* family has
    // landed. A partial failure leaves the marker unset so the next
    // boot reattempts only the failed legacy keys.
    if (failed.length === 0) {
      window.localStorage.setItem(DB_BOOTSTRAP_DONE_KEY, '1');
    }
  } catch {
    /* best-effort; the next boot will re-run INSERT OR IGNORE. */
  }
  return {
    history: result.history,
    uploadHistory: result.uploadHistory,
    sniffHistory: result.sniffHistory,
    toolboxHistory: result.toolboxHistory
  };
}
