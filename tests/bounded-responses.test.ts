import { describe, expect, it } from 'vitest';
import { projectPage, ProjectionTooLargeError } from '../src/projections.js';

describe('bounded MCP projections', () => {
  it('returns deterministic sorted pages and an empty page after the end', () => {
    const rows = [{ id: 'c3', label: 'C' }, { id: 'c1', label: 'A' }, { id: 'c2', label: 'B' }];
    const first = projectPage(rows, { page: 1, limit: 2, evaluatedAt: '2026-09-06T00:00:00Z', dataVersion: 'v1', sortKey: (row) => row.id });
    const afterEnd = projectPage(rows, { page: 3, limit: 2, evaluatedAt: '2026-09-06T00:00:00Z', dataVersion: 'v1', sortKey: (row) => row.id });
    expect(first.items.map((row) => row.id)).toEqual(['c1', 'c2']);
    expect(first.pageInfo).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2, hasMore: true, evaluatedAt: '2026-09-06T00:00:00Z', dataVersion: 'v1' });
    expect(afterEnd.items).toEqual([]);
    expect(afterEnd.pageInfo.hasMore).toBe(false);
  });

  it('rejects invalid bounds and does not silently truncate oversized projections', () => {
    expect(() => projectPage([{ id: 'x' }], { page: 0, limit: 1, evaluatedAt: 'now', dataVersion: 'v1', sortKey: (row) => row.id })).toThrow(/page/);
    expect(() => projectPage([{ id: 'x', detail: 'large' }], { page: 1, limit: 1, maxBytes: 10, evaluatedAt: 'now', dataVersion: 'v1', sortKey: (row) => row.id })).toThrow(ProjectionTooLargeError);
  });
});
