/**
 * R-45 — Tests for the renderer-side upload-history pure helper.
 *
 * Focuses on the folding logic (applyProgressToRecord). Hook
 * lifecycle (localStorage persistence) is exercised indirectly via
 * useHistory.test which already has the same shape.
 */
import { describe, it, expect } from 'vitest';
import { applyProgressToRecord } from '../../src/renderer/components/useUploadHistory';
import type { UploadHistoryRecord } from '../../src/shared/types';

function makeRecord(): UploadHistoryRecord {
  return {
    id: 'rec-1',
    createdAt: 1700000000000,
    backend: 'customWeb',
    items: [
      { jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'pending' }
    ]
  };
}

describe('applyProgressToRecord', () => {
  it('updates status / url / markdown on a matching jobId', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'done', percent: 100, url: 'https://x', markdown: '![a](https://x)'
    });
    expect(after).not.toBe(before);
    expect(after.items[0].status).toBe('done');
    expect(after.items[0].url).toBe('https://x');
    expect(after.items[0].markdown).toBe('![a](https://x)');
  });

  it('returns the same object when no item matches', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'nope', status: 'done', percent: 100
    });
    expect(after).toBe(before);
  });

  it('preserves terminal status against later non-terminal emits', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://x' }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'uploading', percent: 50
    });
    // Terminal already; should stay done.
    expect(after.items[0].status).toBe('done');
  });

  it('returns the same object when nothing meaningful changed', () => {
    const before: UploadHistoryRecord = {
      ...makeRecord(),
      items: [{ jobId: 'j1', fileName: 'a.gif', filePath: '/o/a.gif', status: 'done', url: 'https://x', markdown: '![a](https://x)' }]
    };
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'done', percent: 100, url: 'https://x', markdown: '![a](https://x)'
    });
    expect(after).toBe(before);
  });

  it('captures error on failure', () => {
    const before = makeRecord();
    const after = applyProgressToRecord(before, {
      jobId: 'j1', status: 'failed', percent: 0, error: 'boom'
    });
    expect(after.items[0].status).toBe('failed');
    expect(after.items[0].error).toBe('boom');
  });
});
