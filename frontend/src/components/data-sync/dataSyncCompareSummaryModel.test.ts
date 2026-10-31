import { describe, expect, it } from 'vitest';

import {
  buildCompareSummary,
  compareFilterCounts,
  compositionBars,
  filterCompareTables,
  sharePercent,
  tableRiskLevel,
} from './dataSyncCompareSummaryModel';
import type { DataSyncCompareResult, DataSyncTableDiffSummary } from './model';

const diffTable = (overrides: Partial<DataSyncTableDiffSummary> = {}): DataSyncTableDiffSummary => ({
  table: 'orders',
  canSync: true,
  inserts: 3,
  updates: 2,
  deletes: 1,
  same: 100,
  hasSchema: true,
  schemaDiffCount: 2,
  columnDiffs: [
    { column: 'new_column', kind: 'missing_in_target', source: 'varchar(255)' },
    { column: 'amount', kind: 'type', source: 'int', target: 'bigint' },
  ],
  ...overrides,
});

const sameTable = (overrides: Partial<DataSyncTableDiffSummary> = {}): DataSyncTableDiffSummary => ({
  table: 'customers',
  canSync: true,
  inserts: 0,
  updates: 0,
  deletes: 0,
  same: 40,
  hasSchema: true,
  schemaDiffCount: 0,
  columnDiffs: [],
  ...overrides,
});

const blockedTable = (overrides: Partial<DataSyncTableDiffSummary> = {}): DataSyncTableDiffSummary => ({
  table: 'audit_log',
  canSync: false,
  inserts: 0,
  updates: 0,
  deletes: 0,
  same: 0,
  hasSchema: true,
  schemaDiffCount: 0,
  columnDiffs: [],
  message: 'source read failed',
  ...overrides,
});

const result = (
  tables: DataSyncTableDiffSummary[],
  content?: DataSyncCompareResult['content'],
): DataSyncCompareResult => ({ success: true, message: '', content, tables });

describe('compare summary aggregation', () => {
  it('counts row-level metrics and table statuses in data mode', () => {
    // 仅数据对比时后端不会置 hasSchema，结构区块整体不出现。
    const summary = buildCompareSummary(
      result([diffTable({ hasSchema: false }), sameTable({ hasSchema: false })], 'data'),
      'data',
    );

    expect(summary.total).toBe(2);
    expect(summary.diff).toBe(1);
    expect(summary.same).toBe(1);
    expect(summary.unknown).toBe(0);
    expect(summary.inserts).toBe(3);
    expect(summary.updates).toBe(2);
    expect(summary.deletes).toBe(1);
    expect(summary.showData).toBe(true);
    expect(summary.showSchema).toBe(false);
    expect(summary.kpis.map((kpi) => kpi.key)).toEqual([
      'diff',
      'same',
      'unknown',
      'inserts',
      'updates',
      'deletes',
    ]);
    expect(summary.diffKindBars).toEqual([]);
    expect(summary.risk).toEqual({ blocking: 0, attention: 0, compatible: 0 });
  });

  it('drops row metrics and keeps schema metrics in schema mode', () => {
    const summary = buildCompareSummary(result([diffTable(), sameTable()], 'schema'), 'schema');

    expect(summary.showData).toBe(false);
    expect(summary.showSchema).toBe(true);
    expect(summary.inserts).toBe(0);
    expect(summary.updates).toBe(0);
    expect(summary.deletes).toBe(0);
    expect(summary.kpis.map((kpi) => kpi.key)).toEqual([
      'diff',
      'same',
      'unknown',
      'schema',
      'high_risk',
    ]);
    expect(summary.schemaDiffs).toBe(2);
    expect(summary.risk).toEqual({ blocking: 2, attention: 0, compatible: 0 });
  });

  it('reports both data and schema metrics in both mode', () => {
    const nullable = diffTable({
      table: 'shipments',
      inserts: 0,
      updates: 0,
      deletes: 0,
      schemaDiffCount: 2,
      columnDiffs: [
        { column: 'note', kind: 'nullable', source: 'NOT NULL', target: 'NULL' },
        { column: 'legacy_id', kind: 'extra_in_target', target: 'int' },
      ],
    });
    const summary = buildCompareSummary(result([diffTable(), nullable], 'both'), 'both');

    expect(summary.showData).toBe(true);
    expect(summary.showSchema).toBe(true);
    expect(summary.inserts).toBe(3);
    expect(summary.kpis.map((kpi) => kpi.key)).toEqual([
      'diff',
      'same',
      'unknown',
      'inserts',
      'updates',
      'deletes',
      'schema',
      'high_risk',
    ]);
    expect(summary.diffKindBars.map((bar) => [bar.key, bar.value])).toEqual([
      ['missing_in_target', 1],
      ['extra_in_target', 1],
      ['type', 1],
      ['nullable', 1],
      ['renamed', 0],
      ['capacity_degraded', 0],
    ]);
    expect(summary.risk).toEqual({ blocking: 2, attention: 1, compatible: 1 });
  });

  it('keeps an all-identical result at zero diffs with a full hero total', () => {
    const summary = buildCompareSummary(result([sameTable(), sameTable({ table: 'carts' })], 'both'), 'both');

    expect(summary.total).toBe(2);
    expect(summary.diff).toBe(0);
    expect(summary.same).toBe(2);
    expect(summary.unknown).toBe(0);
    expect(summary.inserts).toBe(0);
    expect(summary.schemaDiffs).toBe(0);
    expect(summary.statusBars.map((bar) => bar.value)).toEqual([0, 2, 0]);
    expect(summary.risk).toEqual({ blocking: 0, attention: 0, compatible: 0 });
  });

  it('buckets tables that were never compared as unknown', () => {
    const summary = buildCompareSummary(
      result([diffTable(), sameTable(), blockedTable()], 'both'),
      'both',
    );

    expect(summary.unknown).toBe(1);
    expect(summary.diff).toBe(1);
    expect(summary.same).toBe(1);
    expect(summary.statusBars.map((bar) => [bar.key, bar.value])).toEqual([
      ['diff', 1],
      ['same', 1],
      ['unknown', 1],
    ]);
    expect(compareFilterCounts(summary)).toEqual({ all: 3, diff: 1, same: 1, unknown: 1 });
  });

  it('falls back to missing columns when column diffs are absent', () => {
    const summary = buildCompareSummary(
      result([
        diffTable({
          schemaDiffCount: 2,
          columnDiffs: undefined,
          missingColumns: ['alpha', 'beta'],
        }),
      ], 'schema'),
      'schema',
    );

    expect(summary.schemaDiffs).toBe(2);
    expect(summary.risk.blocking).toBe(2);
    expect(summary.diffKindBars[0]).toMatchObject({ key: 'missing_in_target', value: 2 });
  });

  it('returns zeroed metrics for an empty or missing result', () => {
    const summary = buildCompareSummary(null, 'data');
    expect(summary.total).toBe(0);
    expect(summary.statusBars.every((bar) => bar.value === 0)).toBe(true);
    expect(sharePercent(0, 0)).toBe(0);
  });
});

describe('compare summary KPI hints', () => {
  it('counts the tables each row metric touches', () => {
    const summary = buildCompareSummary(
      result([diffTable(), diffTable({ table: 'invoices', inserts: 0, updates: 0, deletes: 0 })], 'data'),
      'data',
    );

    expect(summary.affectedRows).toEqual({ inserts: 1, updates: 1, deletes: 1, schema: 2 });
    expect(summary.kpis.find((kpi) => kpi.key === 'inserts')?.hint).toEqual({
      kind: 'tables',
      count: 1,
    });
    expect(summary.kpis.find((kpi) => kpi.key === 'diff')?.hint).toEqual({
      kind: 'share',
      percent: 100,
    });
  });
});

describe('compare table filtering', () => {
  const tables = [
    diffTable(),
    sameTable(),
    blockedTable(),
    diffTable({ table: 'Order_Lines', sourceObject: 'public.order_lines' }),
  ];

  it('filters by status', () => {
    expect(filterCompareTables(tables, 'both', 'diff', '')).toHaveLength(2);
    expect(filterCompareTables(tables, 'both', 'same', '')).toHaveLength(1);
    expect(filterCompareTables(tables, 'both', 'unknown', '')).toHaveLength(1);
    expect(filterCompareTables(tables, 'both', 'all', '')).toHaveLength(4);
  });

  it('matches the search term against table and endpoint names, case-insensitively', () => {
    expect(filterCompareTables(tables, 'both', 'all', 'order')).toHaveLength(2);
    expect(filterCompareTables(tables, 'both', 'all', '  AUDIT ')).toHaveLength(1);
    expect(filterCompareTables(tables, 'both', 'all', 'public.')).toHaveLength(1);
    expect(filterCompareTables(tables, 'both', 'all', 'missing')).toHaveLength(0);
  });

  it('combines the status filter with the search term', () => {
    expect(filterCompareTables(tables, 'both', 'diff', 'order')).toHaveLength(2);
    expect(filterCompareTables(tables, 'both', 'same', 'order')).toHaveLength(0);
  });

  it('filters by risk level and accepts several levels at once', () => {
    const mixed = [
      // 阻断级：目标缺字段。
      diffTable({ table: 'blocked_col' }),
      // 关注级：仅可空性不同。
      diffTable({
        table: 'nullable_col',
        inserts: 0,
        updates: 0,
        deletes: 0,
        schemaDiffCount: 1,
        columnDiffs: [{ column: 'note', kind: 'nullable', source: 'NOT NULL', target: 'NULL' }],
      }),
      // 兼容级：只有目标多出的字段。
      diffTable({
        table: 'extra_col',
        inserts: 0,
        updates: 0,
        deletes: 0,
        schemaDiffCount: 1,
        columnDiffs: [{ column: 'legacy', kind: 'extra_in_target', target: 'int' }],
      }),
      sameTable(),
    ];

    expect(filterCompareTables(mixed, 'both', 'all', '', ['blocking'])).toHaveLength(1);
    expect(filterCompareTables(mixed, 'both', 'all', '', ['attention'])).toHaveLength(1);
    expect(filterCompareTables(mixed, 'both', 'all', '', ['compatible'])).toHaveLength(1);
    expect(
      filterCompareTables(mixed, 'both', 'all', '', ['blocking', 'attention']),
    ).toHaveLength(2);
    // 空集合表示不筛。
    expect(filterCompareTables(mixed, 'both', 'all', '', [])).toHaveLength(4);
  });
});

describe('compare diff composition', () => {
  const column = (kind: 'missing_in_target' | 'extra_in_target' | 'type' | 'nullable') =>
    ({ column: kind, kind });

  it('buckets column and index diffs by dimension and direction', () => {
    const summary = buildCompareSummary(result([{
      ...diffTable(),
      inserts: 0, updates: 0, deletes: 0,
      schemaDiffCount: 3,
      columnDiffs: [column('missing_in_target'), column('extra_in_target'), column('type')],
      indexDiffs: [
        { name: 'idx_a', kind: 'missing_in_target' },
        { name: 'idx_b', kind: 'changed', source: 'BTREE(a)', target: 'UNIQUE (a)' },
      ],
    }], 'schema'), 'schema');

    expect(summary.composition.column).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(summary.composition.index).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(summary.hasIndexDiffs).toBe(true);
  });

  // 整表缺失只记一条「整表删除」，不再把它展开的 N 条列差异算成 N 条字段差异，
  // 否则一张缺表就会把构成图拉满。
  it('collapses a missing target table into one table-level entry', () => {
    const summary = buildCompareSummary(result([{
      ...diffTable({ table: 'gone' }),
      targetTableExists: false,
      diffStats: undefined,
    }], 'schema'), 'schema');

    expect(summary.composition.table.removed).toBe(1);
    expect(summary.composition.column).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(summary.highRiskTables).toBe(1);
  });

  it('hides the index dimension when the backend sent no index diffs', () => {
    const summary = buildCompareSummary(result([diffTable()], 'schema'), 'schema');
    expect(summary.hasIndexDiffs).toBe(false);
    expect(compositionBars(summary.composition, summary.hasIndexDiffs).map((bar) => bar.key))
      .toEqual(['table', 'column']);
    expect(compositionBars(summary.composition, true).map((bar) => bar.key))
      .toEqual(['table', 'column', 'index']);
  });

  it('counts high-risk tables from either column or index blocking diffs', () => {
    const summary = buildCompareSummary(result([
      diffTable(),
      { ...diffTable({ table: 'idx_only' }), schemaDiffCount: 1, columnDiffs: [], indexDiffs: [{ name: 'idx', kind: 'missing_in_target' }] },
      sameTable(),
    ], 'schema'), 'schema');

    expect(summary.highRiskTables).toBe(2);
  });

  it('derives per-table risk levels for the row tag', () => {
    expect(tableRiskLevel(diffTable())).toBe('blocking');
    expect(tableRiskLevel({
      ...diffTable(),
      columnDiffs: [{ column: 'c', kind: 'nullable' }],
    })).toBe('attention');
    expect(tableRiskLevel({
      ...diffTable(),
      columnDiffs: [{ column: 'c', kind: 'extra_in_target' }],
    })).toBe('compatible');
    expect(tableRiskLevel(sameTable())).toBeNull();
  });
});
