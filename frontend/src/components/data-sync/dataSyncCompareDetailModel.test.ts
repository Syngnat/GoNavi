import { describe, expect, it } from 'vitest';

import {
  DETAIL_GROUP_ORDER,
  filterDetailRows,
  filterDetailRowsByRisk,
  groupByKind,
  groupByTable,
  projectCompareDetailRows,
  splitByDetailGroup,
} from './dataSyncCompareDetailModel';
import type { DataSyncCompareResult, DataSyncTableDiffSummary } from './model';
import { createDataSyncWorkbenchTranslate } from './text';

const t = createDataSyncWorkbenchTranslate('zh-CN');

const table = (overrides: Partial<DataSyncTableDiffSummary>): DataSyncTableDiffSummary => ({
  table: 'orders',
  canSync: true,
  inserts: 0,
  updates: 0,
  deletes: 0,
  same: 0,
  hasSchema: true,
  schemaDiffCount: 0,
  targetTableExists: true,
  columnDiffs: [],
  ...overrides,
});

const result = (tables: DataSyncTableDiffSummary[]): DataSyncCompareResult => ({
  success: true,
  message: '',
  content: 'both',
  tables,
});

describe('compare detail projection', () => {
  it('flattens column and index diffs into one row each', () => {
    const rows = projectCompareDetailRows(result([table({
      columnDiffs: [
        { column: 'coupon_code', kind: 'missing_in_target', source: 'varchar(32)' },
        { column: 'legacy', kind: 'extra_in_target', target: 'int' },
      ],
      indexDiffs: [
        { name: 'idx_code', kind: 'missing_in_target', source: 'BTREE (code)' },
        { name: 'idx_old', kind: 'renamed', source: 'idx_old', target: 'idx_new' },
      ],
    })]), 'both');

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.dimension)).toEqual(['column', 'column', 'index', 'index']);
    // 目标缺失 = 新增：目标侧为空、源端侧给定义。
    expect(rows[0]).toMatchObject({ subject: 'coupon_code', targetSide: '—', sourceSide: 'varchar(32)' });
    // 目标多出 = 删除：目标侧给定义、源端侧为空。
    expect(rows[1]).toMatchObject({ subject: 'legacy', targetSide: 'int', sourceSide: '—' });
    // 重命名两侧都给名字。
    expect(rows[3]).toMatchObject({ targetSide: 'idx_old', sourceSide: 'idx_new', groupKey: 'index_renamed' });
  });

  it('collapses a missing target table into one table-level row', () => {
    const rows = projectCompareDetailRows(result([table({
      targetTableExists: false,
      columnDiffs: [
        { column: 'a', kind: 'missing_in_target' },
        { column: 'b', kind: 'missing_in_target' },
      ],
    })]), 'both');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dimension: 'table', groupKey: 'table_removed', risk: 'blocking' });
  });

  it('skips tables that were never compared', () => {
    const rows = projectCompareDetailRows(result([
      table({ canSync: false, columnDiffs: [{ column: 'x', kind: 'type' }] }),
    ]), 'both');

    expect(rows).toEqual([]);
  });

  it('assigns a risk level per change group', () => {
    const rows = projectCompareDetailRows(result([table({
      columnDiffs: [
        { column: 'a', kind: 'missing_in_target' },
        { column: 'b', kind: 'nullable' },
        { column: 'c', kind: 'extra_in_target' },
      ],
    })]), 'both');

    expect(rows.map((row) => row.risk)).toEqual(['blocking', 'attention', 'compatible']);
  });
});

describe('compare detail grouping', () => {
  const rows = projectCompareDetailRows(result([
    table({
      table: 'orders',
      targetTableExists: false,
    }),
    table({
      table: 'customers',
      columnDiffs: [
        { column: 'zzz', kind: 'extra_in_target', target: 'int' },
        { column: 'aaa', kind: 'missing_in_target', source: 'text' },
      ],
      indexDiffs: [{ name: 'idx_a', kind: 'changed', source: 'BTREE (a)', target: 'UNIQUE (a)' }],
    }),
  ]), 'both');

  it('sorts by table name with the whole-table row first', () => {
    const grouped = groupByTable(rows);
    const tables = grouped.map((row) => row.table);

    expect(tables[0]).toBe('customers');
    expect(tables[tables.length - 1]).toBe('orders');
    // 同表内整表行排最前。
    expect(grouped[grouped.length - 1]!.dimension).toBe('table');
  });

  it('sorts by the fixed group order', () => {
    const grouped = groupByKind(rows);
    const order = grouped.map((row) => row.groupKey);
    const positions = order.map((key) => DETAIL_GROUP_ORDER.indexOf(key));

    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(order[order.length - 1]).toBe('index_changed');
  });

  it('splits into headed groups in the documented order', () => {
    const groups = splitByDetailGroup(groupByKind(rows));

    expect(groups.map((group) => group.key)).toEqual([
      'table_removed',
      'column_added',
      'column_removed',
      'index_changed',
    ]);
    expect(groups.every((group) => group.rows.length > 0)).toBe(true);
  });
});

describe('compare detail filtering', () => {
  const rows = projectCompareDetailRows(result([table({
    columnDiffs: [
      { column: 'coupon_code', kind: 'missing_in_target', source: 'varchar(32)' },
      { column: 'amount', kind: 'type', source: 'int', target: 'bigint' },
    ],
  })]), 'both');

  it('searches subject, sides and the translated change type', () => {
    expect(filterDetailRows(rows, 'coupon', t)).toHaveLength(1);
    expect(filterDetailRows(rows, 'bigint', t)).toHaveLength(1);
    expect(filterDetailRows(rows, '目标缺失', t)).toHaveLength(1);
    expect(filterDetailRows(rows, 'nope', t)).toHaveLength(0);
    expect(filterDetailRows(rows, '  ', t)).toHaveLength(2);
  });

  it('filters by risk and treats an empty selection as no filter', () => {
    expect(filterDetailRowsByRisk(rows, ['blocking'])).toHaveLength(2);
    expect(filterDetailRowsByRisk(rows, ['attention'])).toHaveLength(0);
    expect(filterDetailRowsByRisk(rows, [])).toHaveLength(2);
  });
});
