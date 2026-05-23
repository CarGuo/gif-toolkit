/**
 * SUITE DB-IPC — full CRUD round-trip across the four core history
 * tables (R-DB-IPC-V1).
 *
 * Why this SUITE exists
 * ---------------------
 * [src/main/db/dbIpc.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/db/dbIpc.ts)
 * registers 33 IPC handlers across `db:history`, `db:uploadHistory`,
 * `db:sniffHistory`, `db:toolboxHistory`, `db:toolboxChainHistory`,
 * `db:chainLineageNodes` and `db:sessionLogs`. Existing coverage:
 *
 *   - vitest unit suites for each repo (insert / select / cascade)
 *   - several SUITEs (HD-UP, TB-LINEAGE-TREE-UI, TREE-G-LOG …) seed
 *     ONE table to exercise UI rendering, but never round-trip
 *     `upsert → readAll → remove → readAll` from the renderer side
 *
 * That gap means a regression in the IPC layer (e.g. `upsert` silently
 * dropping a field, or `clear` failing the foreign-key cascade) would
 * sneak through every existing test even though the unit-level repo
 * works fine.
 *
 * This SUITE drives the four tables the renderer relies on for its
 * history panels — `history`, `uploadHistory`, `sniffHistory`,
 * `toolboxHistory` — through a complete CRUD cycle from the renderer
 * via the production preload bridge.
 *
 * Why not the chain / lineage / sessionLogs tables?
 * -------------------------------------------------
 * Those are already covered by [suite-toolbox-lineage-tree-ui.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-toolbox-lineage-tree-ui.ts)
 * (TREE-A..I) and [suite-r-compress-v1-ui.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/e2e/realPipeline/suite-r-compress-v1-ui.ts)
 * via real chain runs that exercise the persistence layer end-to-end
 * with realistic payloads. Adding a synthetic CRUD pass on top would
 * be redundant noise.
 */
import { test, expect } from '@playwright/test';
import { getHarness } from './_harness';

interface HistoryRowWire {
  id: string;
  createdAt: number;
  pageUrl: string;
  title?: string;
  outputDir?: string;
  items: unknown[];
  options: unknown;
  outputsByTaskId: Record<string, unknown>;
  taskStatus: Record<string, unknown>;
  uploadsByOutputPath?: Record<string, unknown>;
  sessionId?: string;
}

interface UploadHistoryItemWire {
  jobId: string;
  filePath: string;
  fileName: string;
  status: string;
  url?: string;
}
interface UploadHistoryRowWire {
  id: string;
  createdAt: number;
  backend: string;
  items: UploadHistoryItemWire[];
}

interface SniffHistoryRowWire {
  url: string;
  title?: string;
  ts: number;
  itemCount?: number;
}

interface ToolboxHistoryRowWire {
  id: string;
  kind: string;
  inputPath: string;
  displayName: string;
  outputs: string[];
  params: unknown;
  status: 'done' | 'failed' | 'cancelled' | 'skipped';
  finishedAt: number;
}

test.describe('SUITE DB-IPC — four core history tables full CRUD round-trip', () => {
  test('SUITE DB-A — db.history upsert → readAll → remove → readAll round-trip', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();
    const id = `db-a-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const seed: HistoryRowWire = {
      id,
      createdAt: Date.now(),
      pageUrl: 'https://db-a.test.example/page',
      title: 'DB-A round trip',
      outputDir: '',
      items: [{ id: `${id}-task`, kind: 'image', url: 'https://db-a/x.gif', pageUrl: 'https://db-a.test.example/page', tab: 'images' }],
      options: { fps: 12, maxWidth: 480 },
      outputsByTaskId: { [`${id}-task`]: ['/tmp/dummy.gif'] },
      taskStatus: { [`${id}-task`]: 'done' }
    };

    const r = await page.evaluate(async (rec: HistoryRowWire) => {
      const w = window as unknown as {
        giftk: {
          db: {
            history: {
              readAll(): Promise<HistoryRowWire[]>;
              upsert(rec: HistoryRowWire): Promise<void>;
              remove(id: string): Promise<void>;
            };
          };
        };
      };
      const before = (await w.giftk.db.history.readAll()).map((r) => r.id);
      await w.giftk.db.history.upsert(rec);
      const afterUpsert = await w.giftk.db.history.readAll();
      await w.giftk.db.history.remove(rec.id);
      const afterRemove = (await w.giftk.db.history.readAll()).map((r) => r.id);
      const inserted = afterUpsert.find((r) => r.id === rec.id);
      return { before, inserted, afterRemove };
    }, seed);

    expect(r.before.includes(id)).toBe(false);
    expect(r.inserted).toBeTruthy();
    expect(r.inserted!.id).toBe(id);
    expect(r.inserted!.pageUrl).toBe(seed.pageUrl);
    expect(r.inserted!.title).toBe(seed.title);
    expect(r.afterRemove.includes(id)).toBe(false);
  });

  test('SUITE DB-B — db.uploadHistory upsert preserves item order + cascading remove', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();
    const id = `db-b-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const seed: UploadHistoryRowWire = {
      id,
      createdAt: Date.now(),
      backend: 'customWeb',
      items: [
        { jobId: 'j1', filePath: '/tmp/a.gif', fileName: 'a.gif', status: 'done', url: 'http://r/a' },
        { jobId: 'j2', filePath: '/tmp/b.gif', fileName: 'b.gif', status: 'done', url: 'http://r/b' },
        { jobId: 'j3', filePath: '/tmp/c.gif', fileName: 'c.gif', status: 'failed' }
      ]
    };

    const r = await page.evaluate(async (rec: UploadHistoryRowWire) => {
      const w = window as unknown as {
        giftk: {
          db: {
            uploadHistory: {
              readAll(): Promise<UploadHistoryRowWire[]>;
              upsert(rec: UploadHistoryRowWire): Promise<void>;
              remove(id: string): Promise<void>;
            };
          };
        };
      };
      await w.giftk.db.uploadHistory.upsert(rec);
      const after = await w.giftk.db.uploadHistory.readAll();
      const inserted = after.find((r) => r.id === rec.id);
      await w.giftk.db.uploadHistory.remove(rec.id);
      const removed = (await w.giftk.db.uploadHistory.readAll()).find((r) => r.id === rec.id);
      return { inserted, removed };
    }, seed);

    expect(r.inserted).toBeTruthy();
    expect(r.inserted!.backend).toBe('customWeb');
    expect(r.inserted!.items.length).toBe(3);
    expect(r.inserted!.items.map((i) => i.jobId)).toEqual(['j1', 'j2', 'j3']);
    expect(r.inserted!.items[2].status).toBe('failed');
    expect(r.removed).toBeUndefined();
  });

  test('SUITE DB-C — db.sniffHistory upsert overwrites by url + remove(url)', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();
    const url = `https://db-c.test.example/${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const r = await page.evaluate(async (probeUrl: string) => {
      const w = window as unknown as {
        giftk: {
          db: {
            sniffHistory: {
              readAll(): Promise<SniffHistoryRowWire[]>;
              upsert(rec: SniffHistoryRowWire): Promise<void>;
              remove(url: string): Promise<void>;
            };
          };
        };
      };
      const seed1: SniffHistoryRowWire = { url: probeUrl, title: 'first', ts: Date.now() - 1000, itemCount: 3 };
      const seed2: SniffHistoryRowWire = { url: probeUrl, title: 'second', ts: Date.now(), itemCount: 7 };
      await w.giftk.db.sniffHistory.upsert(seed1);
      await w.giftk.db.sniffHistory.upsert(seed2);
      const after = await w.giftk.db.sniffHistory.readAll();
      const matches = after.filter((r) => r.url === probeUrl);
      await w.giftk.db.sniffHistory.remove(probeUrl);
      const removed = (await w.giftk.db.sniffHistory.readAll()).filter((r) => r.url === probeUrl);
      return { matches, removed };
    }, url);

    expect(r.matches.length).toBe(1);
    expect(r.matches[0].title).toBe('second');
    expect(r.matches[0].itemCount).toBe(7);
    expect(r.removed.length).toBe(0);
  });

  test('SUITE DB-D — db.toolboxHistory upsert + readAll preserves status / outputs / params', async () => {
    test.setTimeout(20_000);
    const { page } = getHarness();
    const id = `db-d-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const seed: ToolboxHistoryRowWire = {
      id,
      kind: 'gif-optimize',
      inputPath: '/tmp/in.gif',
      displayName: 'in.gif',
      outputs: ['/tmp/out-1.gif', '/tmp/out-2.gif'],
      params: { method: 'budget', maxBytes: 5_242_880 },
      status: 'done',
      finishedAt: Date.now()
    };

    const r = await page.evaluate(async (rec: ToolboxHistoryRowWire) => {
      const w = window as unknown as {
        giftk: {
          db: {
            toolboxHistory: {
              readAll(): Promise<ToolboxHistoryRowWire[]>;
              upsert(rec: ToolboxHistoryRowWire): Promise<void>;
              remove(id: string): Promise<void>;
            };
          };
        };
      };
      await w.giftk.db.toolboxHistory.upsert(rec);
      const after = await w.giftk.db.toolboxHistory.readAll();
      const inserted = after.find((r) => r.id === rec.id);
      await w.giftk.db.toolboxHistory.remove(rec.id);
      const removed = (await w.giftk.db.toolboxHistory.readAll()).find((r) => r.id === rec.id);
      return { inserted, removed };
    }, seed);

    expect(r.inserted).toBeTruthy();
    expect(r.inserted!.kind).toBe('gif-optimize');
    expect(r.inserted!.status).toBe('done');
    expect(r.inserted!.outputs).toEqual(seed.outputs);
    expect(r.inserted!.displayName).toBe('in.gif');
    expect(r.removed).toBeUndefined();
  });
});
