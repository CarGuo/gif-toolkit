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
