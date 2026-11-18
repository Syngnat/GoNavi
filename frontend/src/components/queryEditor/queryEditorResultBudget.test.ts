import { describe, expect, it } from 'vitest';

import {
  buildQueryEditorPagedResultBudgetOptions,
  buildQueryEditorResultBudgetOptions,
  QUERY_EDITOR_BUDGET_UNLIMITED,
  QUERY_EDITOR_DEFAULT_PAGE_SIZE,
  QUERY_EDITOR_SAFE_MAX_FIELD_BYTES,
} from './queryEditorResultBudget';

describe('query editor result budget', () => {
  // 「最大返回行数」选项已移除：行数不再由应用截断，用户跑 SELECT * 就该拿到全量。
  it('leaves row and byte dimensions unlimited', () => {
    const budget = buildQueryEditorResultBudgetOptions();
    expect(budget.maxRowsPerResult).toBe(QUERY_EDITOR_BUDGET_UNLIMITED);
    expect(budget.maxTotalRows).toBe(QUERY_EDITOR_BUDGET_UNLIMITED);
    expect(budget.maxTotalBytes).toBe(QUERY_EDITOR_BUDGET_UNLIMITED);
    expect(QUERY_EDITOR_BUDGET_UNLIMITED).toBeLessThan(0);
  });

  // 单字段上限是行数放开后唯一的内存护栏：一格超大 CLOB 直接穿过 IPC 会卡死界面。
  // 同时 0 会让扫描预算整体变成 nil，Oracle 文本预览退化成 4KiB 兜底。
  it('keeps the per-field preview cap', () => {
    expect(buildQueryEditorResultBudgetOptions().maxFieldBytes)
      .toBe(QUERY_EDITOR_SAFE_MAX_FIELD_BYTES);
    expect(QUERY_EDITOR_SAFE_MAX_FIELD_BYTES).toBeGreaterThan(0);
  });

  // 回归：翻页 SQL 自带 LIMIT pageSize+1。若扫描预算比它更窄，第 pageSize+1 行
  // 取不到，每页都被判成最后一页，几千条数据只能翻两页。
  it('does not narrow the budget below the pagination lookahead', () => {
    const paged = buildQueryEditorPagedResultBudgetOptions();
    expect(paged.maxRowsPerResult).toBe(QUERY_EDITOR_BUDGET_UNLIMITED);
    expect(paged.maxTotalRows).toBe(QUERY_EDITOR_BUDGET_UNLIMITED);
    expect(paged.maxFieldBytes).toBe(QUERY_EDITOR_SAFE_MAX_FIELD_BYTES);
  });

  it('starts every result at the default page size', () => {
    expect(QUERY_EDITOR_DEFAULT_PAGE_SIZE).toBe(100);
  });
});
