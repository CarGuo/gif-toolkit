/**
 * Static-shape regression test for the GIF compressLoop fan-out paths in
 * src/main/processor.ts.
 *
 * Why static, not behavioural?
 *   processor.ts is the main-process entry point — it imports Electron
 *   (`./binaries` → app.getPath), better-sqlite3 (transitively via
 *   `./logger`), the ffmpeg/gifsicle wrappers, and the downloader. Spinning
 *   up that tree in vitest would require mocking >10 modules just to drive
 *   the three GIF branches we care about, with brittle test setup.
 *
 *   Instead we anchor a simple lexical invariant that captures the bug:
 *   for every `await compressLoop(...)` call site, the subsequent
 *   `await fsp.copyFile(result.finalPath, finalOut)` MUST be preceded by
 *   an `if (result.allPhasesFailed)` guard that returns early. That guard
 *   is exactly what was missing from the manual re-optimize path
 *   (#L1133-L1135 before fix), the toolbox budget path (#L2222-L2243
 *   before fix), and was emitted AFTER the copy on the regular GIF path
 *   (#L1356-L1382 before fix) — so the file leaked to the output dir even
 *   on full-failure runs.
 *
 *   This test fails loudly the moment a future contributor adds a 4th
 *   compressLoop call site (or removes the guard) — the regression that
 *   would silently re-introduce P1#6.
 *
 * If processor.ts is later refactored into smaller pure modules, replace
 * this file with proper behavioural tests against those modules.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROCESSOR_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'main',
  'processor.ts'
);

interface CallSite {
  /** Line number (1-based) where `await compressLoop(` starts. */
  compressLine: number;
  /** The variable name the call result is bound to (`result`, `compressed`, …). */
  resultVar: string;
  /** Line number (1-based) where the subsequent copyFile of the compressed result starts. */
  copyLine: number;
  /** Line number (1-based) where the matching `if (<resultVar>.allPhasesFailed)` appears. */
  guardLine: number;
}

const findCallSites = (src: string): CallSite[] => {
  const lines = src.split('\n');
  const sites: CallSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Two binding forms are accepted:
    //   1. `const|let X = await (compressLoop|toolboxBudgetCompress)(`
    //   2. `? await (compressLoop|toolboxBudgetCompress)(`  — ternary arm;
    //      walk back up to 5 lines to find the enclosing `const|let X =`.
    const direct = lines[i].match(
      /^\s*(?:const|let)\s+(\w+)\s*=\s*await\s+(?:compressLoop|toolboxBudgetCompress)\s*\(/
    );
    const ternary = !direct && lines[i].match(
      /^\s*[?:]\s*await\s+(?:compressLoop|toolboxBudgetCompress)\s*\(/
    );
    if (!direct && !ternary) continue;
    let resultVar: string | null = null;
    if (direct) {
      resultVar = direct[1];
    } else {
      // Ternary arm — walk back up to 30 lines to find the enclosing
      // `const|let X = <something>` that owns this expression.
      for (let k = i - 1; k >= Math.max(0, i - 30); k--) {
        const up = lines[k].match(/^\s*(?:const|let)\s+(\w+)\s*=/);
        if (up) { resultVar = up[1]; break; }
      }
      if (!resultVar) continue;
    }
    const compressLine = i + 1;
    // Search forward (within 200 lines) for the first copyFile of
    // <resultVar>.finalPath OR the matching allPhasesFailed guard.
    // Whichever comes first determines correctness; we keep both
    // for the precedence assertion below.
    let copyLine = -1;
    let guardLine = -1;
    const copyRe = new RegExp(
      String.raw`await\s+fsp\.copyFile\(\s*${resultVar}\.finalPath`
    );
    const guardRe = new RegExp(
      String.raw`if\s*\(\s*${resultVar}\.allPhasesFailed\s*\)`
    );
    for (let j = i + 1; j < Math.min(i + 200, lines.length); j++) {
      if (copyLine === -1 && copyRe.test(lines[j])) copyLine = j + 1;
      if (guardLine === -1 && guardRe.test(lines[j])) guardLine = j + 1;
      if (copyLine > 0 && guardLine > 0) break;
    }
    sites.push({ compressLine, resultVar, copyLine, guardLine });
  }
  return sites;
};

describe('processor.ts — compressLoop fan-out invariants (P1 #6)', () => {
  it('every compressLoop result is gated by an allPhasesFailed guard BEFORE the copyFile', async () => {
    const src = await fsp.readFile(PROCESSOR_PATH, 'utf8');
    const sites = findCallSites(src);

    // Sanity: 4 compressLoop sites (regular GIF, manual reopt, video→gif
    // segments, toolbox video→gif fallback) + 2 toolboxBudgetCompress
    // sites (video→gif budget, gif-optimize budget) = 6 total. The audit
    // hardened toolboxBudgetCompress to share the same allPhasesFailed
    // invariant, so both call shapes are policed by this regression.
    // If a future refactor adds another we want this list to grow
    // consciously, not silently.
    expect(sites.length).toBeGreaterThanOrEqual(6);

    for (const s of sites) {
      // Each site must have BOTH a copy and a guard.
      expect(s.copyLine, `compressLoop@L${s.compressLine} has no fsp.copyFile`).toBeGreaterThan(0);
      expect(s.guardLine, `compressLoop@L${s.compressLine} has no allPhasesFailed guard`).toBeGreaterThan(0);
      // Guard MUST appear strictly before the copy. This is the
      // precise invariant violated by the regular-GIF path before
      // the P1 #6 fix (it copied first, checked later).
      expect(
        s.guardLine,
        `compressLoop@L${s.compressLine}: allPhasesFailed guard at L${s.guardLine} must precede copyFile at L${s.copyLine}`
      ).toBeLessThan(s.copyLine);
    }
  });

  it('every allPhasesFailed branch returns early WITHOUT copying the failed result to the output dir', async () => {
    const src = await fsp.readFile(PROCESSOR_PATH, 'utf8');
    const lines = src.split('\n');
    // Find every `if (<var>.allPhasesFailed)` and walk forward until we
    // hit a top-level `return;` at the matching brace depth. Inside that
    // window:
    //  • there must be NO `fsp.copyFile(<var>.finalPath` (the bug)
    //  • there must be NO `status: 'done'` emit (manual-reopt /
    //    toolbox bug)
    //  • the block MUST end with an early `return;`
    //
    // Three of the four branches go further and emit
    // `status: 'failed'`; the fourth (segment loop inside video→gif)
    // intentionally only pushes a warning and returns from the inner
    // segment processor, letting the post-loop `outputs.length === 0`
    // guard turn the whole task into `failed` — so `status: 'failed'`
    // is NOT a universal requirement here, but `not status:'done'`
    // and `no copyFile of the failed finalPath` are.
    interface Guard { line: number; resultVar: string }
    const guards: Guard[] = [];
    lines.forEach((line, idx) => {
      const m = line.match(/if\s*\(\s*(\w+)\.allPhasesFailed\s*\)/);
      if (m) guards.push({ line: idx + 1, resultVar: m[1] });
    });
    // NOTE on counting: there are 6 await sites (see first `it`) but only
    // 5 distinct `if (X.allPhasesFailed)` lines — the video→gif ternary at
    // L2477 binds both arms (toolboxBudgetCompress + compressLoop fallback)
    // to the same `result`, so a single guard at L2522 services both arms.
    // We therefore assert ≥5 here while sites.length asserts ≥6.
    expect(guards.length).toBeGreaterThanOrEqual(5);

    for (const g of guards) {
      const copyRe = new RegExp(
        String.raw`fsp\.copyFile\(\s*${g.resultVar}\.finalPath`
      );
      let sawCopy = false;
      let sawDone = false;
      let sawReturn = false;
      for (let j = g.line; j < Math.min(g.line + 30, lines.length); j++) {
        if (copyRe.test(lines[j])) sawCopy = true;
        if (/status:\s*'done'/.test(lines[j])) sawDone = true;
        if (/^\s*return\s*;?\s*$/.test(lines[j])) {
          sawReturn = true;
          break;
        }
      }
      expect(
        sawCopy,
        `guard@L${g.line} (${g.resultVar}): must NOT copy failed finalPath`
      ).toBe(false);
      expect(
        sawDone,
        `guard@L${g.line} (${g.resultVar}): must NOT emit status: 'done'`
      ).toBe(false);
      expect(
        sawReturn,
        `guard@L${g.line} (${g.resultVar}): must early-return after handling`
      ).toBe(true);
    }
  });
});
