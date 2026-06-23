/**
 * R-77 — Barrel re-export for the shared domain types. The previous
 * `src/shared/types.ts` (~770 lines) was a single dumping ground for
 * five unrelated subdomains:
 *
 *   - media   : sniff result, resolved variant, sniff progress
 *   - process : ProcessOptions / TaskProgress / Preview*
 *   - toolbox : ToolboxKind / ToolboxParams / ToolboxJob
 *   - upload  : UploadBackend / UploadConfigs / UploadProgress / history items
 *   - system  : CapabilityReport / CapabilityIssue
 *
 * Each subdomain is now its own file under `src/shared/types/`. This
 * barrel re-exports everything so existing `import { ... } from
 * '../shared/types'` call sites continue to compile *unchanged* — the
 * 50 importing files in `src/`, `tests/`, and `preload/` were not
 * touched as part of this split. New code is encouraged to import the
 * narrow file directly (`from '../shared/types/process'`) so that
 * "where do these types live" stays obvious, but the barrel is the
 * canonical entry point and will be kept stable.
 *
 * Public surface invariant: the union of exports here MUST equal the
 * union exported by the legacy `types.ts`. The audit in R-76 confirmed
 * the split is mechanically pure — no cross-domain type references —
 * so this re-export carries zero runtime cost and zero behavioural
 * change.
 */
export * from './media';
export * from './process';
export * from './toolbox';
export * from './upload';
export * from './system';
export * from './log';
export * from './update';
export * from './chainLineage';
export * from './recorder';
export * from './dock';
