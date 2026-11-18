import { describe, expect, it } from 'vitest';

import {
  applyQueryEditorResultHistoryBudget,
  canPinQueryEditorResult,
  estimateQueryEditorResultSetBytes,
  QUERY_EDITOR_PINNED_RESULT_MAX_RESULTS,
  QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES,
  QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS,
  QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS,
  type QueryEditorResultHistoryEntry,
} from './queryEditorResultHistory';

const buildResult = (
  key: string,
  rowCount: number,
  overrides: Partial<QueryEditorResultHistoryEntry> = {},
): QueryEditorResultHistoryEntry => ({
  key,
  sql: `select '${key}'`,
  columns: ['id', 'payload'],
  rows: Array.from({ length: rowCount }, (_, index) => ({ id: index, payload: key })),
  ...overrides,
});

describe('query editor result history budget', () => {
  it('keeps every result when the totals stay under the memory ceiling', () => {
    const results = Array.from({ length: 25 }, (_, index) => buildResult(`result-${index + 1}`, 1));

    const budgeted = applyQueryEditorResultHistoryBudget(results, ['result-1']);

    // 25 个结果远低于兜底阈值：一个都不该被释放。
    expect(budgeted.resultSets).toHaveLength(25);
    expect(budgeted.evictedKeys).toHaveLength(0);
  });

  it('evicts the oldest unpinned results only past the memory ceiling', () => {
    const results = Array.from(
      { length: QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS + 5 },
      (_, index) => buildResult(`result-${index + 1}`, 1),
    );

    const budgeted = applyQueryEditorResultHistoryBudget(results, ['result-1']);

    expect(budgeted.resultSets).toHaveLength(QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS);
    expect(budgeted.resultSets.map((result) => result.key)).toContain('result-1');
    expect(budgeted.evictedKeys).toHaveLength(5);
  });

  // 回归：查询编辑器已不再注入 LIMIT，`SELECT *` 拿到几十万行是正常结果。
  // 用户切到「日志」页签时结果会失去活跃态保护，不能因此把它释放掉。
  it('keeps a large latest result after the active tab switches to the log', () => {
    const results = [
      buildResult('result-1', 1_000),
      buildResult('result-2', 300_000),
    ];

    // 活跃页签是「日志」，因此没有任何结果被 protectedKeys 保护。
    const budgeted = applyQueryEditorResultHistoryBudget(results, []);

    expect(budgeted.resultSets.map((result) => result.key)).toEqual(['result-1', 'result-2']);
    expect(budgeted.evictedKeys).toEqual([]);
  });

  it('bounds retained rows while keeping pinned results', () => {
    const results = Array.from({ length: 12 }, (_, index) => buildResult(
      `result-${index + 1}`,
      5_000,
      index < 2 ? { pinned: true } : {},
    ));

    const budgeted = applyQueryEditorResultHistoryBudget(results, ['result-12']);
    const retainedRows = budgeted.resultSets.reduce((sum, result) => sum + (result.rows?.length || 0), 0);

    expect(retainedRows).toBeLessThanOrEqual(QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS);
    expect(budgeted.resultSets.slice(0, 2).every((result) => result.pinned)).toBe(true);
    expect(budgeted.resultSets.map((result) => result.key)).toContain('result-12');
  });

  it('rejects pinning beyond the explicit pinned-result budget', () => {
    const results = Array.from({ length: QUERY_EDITOR_PINNED_RESULT_MAX_RESULTS + 1 }, (_, index) => buildResult(
      `result-${index + 1}`,
      1,
      index < QUERY_EDITOR_PINNED_RESULT_MAX_RESULTS ? { pinned: true } : {},
    ));

    expect(canPinQueryEditorResult(results, results[results.length - 1].key)).toBe(false);
  });

  it('accounts for wide payloads in the estimated byte budget', () => {
    // 每份 2 MiB，凑够超过兜底字节上限的数据量。
    const sharedWidePayload = 'x'.repeat(2 * 1024 * 1024);
    const count = Math.ceil(QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES / (2 * 1024 * 1024)) + 4;
    const results = Array.from({ length: count }, (_, index) => buildResult(
      `wide-${index + 1}`,
      1,
      { rawResponse: sharedWidePayload },
    ));

    const budgeted = applyQueryEditorResultHistoryBudget(results, [`wide-${count}`]);
    const retainedBytes = budgeted.resultSets.reduce(
      (sum, result) => sum + estimateQueryEditorResultSetBytes(result),
      0,
    );

    expect(retainedBytes).toBeLessThanOrEqual(QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES);
    expect(budgeted.evictedKeys.length).toBeGreaterThan(0);
  });

  it('keeps results with pending edits while evicting older clean history', () => {
    const results = Array.from(
      { length: QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS + 2 },
      (_, index) => buildResult(
        `result-${index + 1}`,
        1,
        index === 0 ? { hasPendingChanges: true } : {},
      ),
    );
    const latestKey = results[results.length - 1].key;

    const budgeted = applyQueryEditorResultHistoryBudget(results, [latestKey]);

    expect(budgeted.resultSets).toHaveLength(QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS);
    expect(budgeted.resultSets.map((result) => result.key)).toContain('result-1');
    expect(budgeted.resultSets.map((result) => result.key)).toContain(latestKey);
  });

  it('scales object estimates for rows with many fields', () => {
    const narrow = buildResult('narrow', 0, {
      rows: [{ field: 'x'.repeat(1024) }],
    });
    const wide = buildResult('wide', 0, {
      rows: [{
        ...Object.fromEntries(Array.from({ length: 96 }, (_, index) => [
          `field_${index + 1}`,
          'x'.repeat(1024),
        ])),
      }],
    });

    expect(estimateQueryEditorResultSetBytes(wide)).toBeGreaterThan(
      estimateQueryEditorResultSetBytes(narrow) * 50,
    );
  });

  it('accounts for large restored selection state', () => {
    const result = buildResult('selected', 1, {
      selectedCellKeys: Array.from({ length: 50_000 }, (_, index) => `${index}\u0000payload`),
    });

    expect(estimateQueryEditorResultSetBytes(result)).toBeGreaterThan(1_000_000);
  });
});
