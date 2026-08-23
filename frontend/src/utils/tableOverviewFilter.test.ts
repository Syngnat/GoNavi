import { describe, expect, it } from 'vitest';

import {
  TABLE_OVERVIEW_RENDER_BATCH_SIZE,
  buildTableOverviewSearchIndex,
  filterAndSortTableOverviewRows,
  prioritizePinnedTableOverviewRows,
  resolveTableOverviewVisibleRows,
} from './tableOverviewFilter';

const buildRows = (count: number) => Array.from({ length: count }, (_, index) => ({
  name: `table_${String(index).padStart(4, '0')}`,
  comment: index === count - 1 ? 'target table comment' : 'normal table',
  rows: index,
  dataSize: count - index,
  indexSize: 0,
}));

describe('tableOverviewFilter', () => {
  it('filters against the full table set before applying the render limit', () => {
    const rows = buildRows(1200);
    const indexed = buildTableOverviewSearchIndex(rows);
    const filtered = filterAndSortTableOverviewRows(indexed, 'target', 'name', 'asc');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('table_1199');
  });

  it('filters schema-scoped rows by their displayed table names', () => {
    const indexed = buildTableOverviewSearchIndex([
      { name: 'reporting.reporting_summary', comment: '', rows: 1, dataSize: 1, indexSize: 0 },
      { name: 'reporting.orders', comment: '', rows: 2, dataSize: 2, indexSize: 0 },
    ], (row) => row.name.split('.').pop() || row.name);

    expect(filterAndSortTableOverviewRows(indexed, 'reporting', 'name', 'asc').map((item) => item.name)).toEqual([
      'reporting.reporting_summary',
    ]);
  });

  it('caps initially rendered rows for large overview result sets', () => {
    const rows = buildRows(1200);
    const visible = resolveTableOverviewVisibleRows(rows, TABLE_OVERVIEW_RENDER_BATCH_SIZE);

    expect(visible.visibleRows).toHaveLength(TABLE_OVERVIEW_RENDER_BATCH_SIZE);
    expect(visible.hiddenCount).toBe(1200 - TABLE_OVERVIEW_RENDER_BATCH_SIZE);
    expect(visible.totalCount).toBe(1200);
  });

  it('sorts with precomputed normalized table names', () => {
    const indexed = buildTableOverviewSearchIndex([
      { name: 'z_table', comment: '', rows: 1, dataSize: 10, indexSize: 0 },
      { name: 'A_table', comment: '', rows: 2, dataSize: 5, indexSize: 0 },
    ]);

    expect(filterAndSortTableOverviewRows(indexed, '', 'name', 'asc').map((item) => item.name)).toEqual([
      'A_table',
      'z_table',
    ]);
  });

  it('sorts table names in natural numeric order', () => {
    const indexed = buildTableOverviewSearchIndex([
      { name: 'table_11', comment: '', rows: 0, dataSize: 0, indexSize: 0 },
      { name: 'table_2', comment: '', rows: 0, dataSize: 0, indexSize: 0 },
      { name: 'table_10', comment: '', rows: 0, dataSize: 0, indexSize: 0 },
      { name: 'table_1', comment: '', rows: 0, dataSize: 0, indexSize: 0 },
    ]);

    expect(filterAndSortTableOverviewRows(indexed, '', 'name', 'asc').map((item) => item.name)).toEqual([
      'table_1',
      'table_2',
      'table_10',
      'table_11',
    ]);
    expect(filterAndSortTableOverviewRows(indexed, '', 'name', 'desc').map((item) => item.name)).toEqual([
      'table_11',
      'table_10',
      'table_2',
      'table_1',
    ]);
  });

  it('uses natural table name order when other sort values match', () => {
    const indexed = buildTableOverviewSearchIndex([
      { name: 'table_10', comment: 'same', rows: 1, dataSize: 0, indexSize: 0 },
      { name: 'table_2', comment: 'same', rows: 1, dataSize: 0, indexSize: 0 },
    ]);

    expect(filterAndSortTableOverviewRows(indexed, '', 'rows', 'desc').map((item) => item.name)).toEqual([
      'table_2',
      'table_10',
    ]);
    expect(filterAndSortTableOverviewRows(indexed, '', 'comment', 'desc').map((item) => item.name)).toEqual([
      'table_2',
      'table_10',
    ]);
  });

  it('sorts compact table numeric columns while keeping unknown values last', () => {
    const indexed = buildTableOverviewSearchIndex([
      { name: 'unknown', comment: '', rows: -1, dataSize: -1, indexSize: -1 },
      { name: 'large', comment: '', rows: 50, dataSize: 500, indexSize: 20 },
      { name: 'small', comment: '', rows: 5, dataSize: 50, indexSize: 2 },
    ]);

    expect(filterAndSortTableOverviewRows(indexed, '', 'rows', 'desc').map((item) => item.name)).toEqual([
      'large',
      'small',
      'unknown',
    ]);
    expect(filterAndSortTableOverviewRows(indexed, '', 'dataSize', 'asc').map((item) => item.name)).toEqual([
      'small',
      'large',
      'unknown',
    ]);
    expect(filterAndSortTableOverviewRows(indexed, '', 'indexSize', 'desc').map((item) => item.name)).toEqual([
      'large',
      'small',
      'unknown',
    ]);
  });

  it('sorts compact table text columns and leaves missing metadata last', () => {
    const indexed = buildTableOverviewSearchIndex([
      { name: 'missing', comment: '', rows: 0, dataSize: 0, indexSize: 0, engine: '' },
      { name: 'zeta', comment: 'Zulu', rows: 0, dataSize: 0, indexSize: 0, engine: 'MyISAM' },
      { name: 'alpha', comment: 'Alpha', rows: 0, dataSize: 0, indexSize: 0, engine: 'InnoDB' },
    ]);

    expect(filterAndSortTableOverviewRows(indexed, '', 'comment', 'asc').map((item) => item.name)).toEqual([
      'alpha',
      'zeta',
      'missing',
    ]);
    expect(filterAndSortTableOverviewRows(indexed, '', 'engine', 'desc').map((item) => item.name)).toEqual([
      'zeta',
      'alpha',
      'missing',
    ]);
  });

  it('keeps pinned overview rows in a dedicated leading group without changing inner sort order', () => {
    const rows = [
      { name: 'audit_log', comment: '', rows: 1, dataSize: 1, indexSize: 0 },
      { name: 'users', comment: '', rows: 2, dataSize: 2, indexSize: 0 },
      { name: 'orders', comment: '', rows: 3, dataSize: 3, indexSize: 0 },
    ];

    const grouped = prioritizePinnedTableOverviewRows(rows, (row) => row.name === 'orders');

    expect(grouped.pinnedRows.map((item) => item.name)).toEqual(['orders']);
    expect(grouped.regularRows.map((item) => item.name)).toEqual(['audit_log', 'users']);
    expect(grouped.orderedRows.map((item) => item.name)).toEqual(['orders', 'audit_log', 'users']);
  });

  it('keeps the overview order unchanged when no table is pinned', () => {
    const rows = [
      { name: 'audit_log', comment: '', rows: 1, dataSize: 1, indexSize: 0 },
      { name: 'users', comment: '', rows: 2, dataSize: 2, indexSize: 0 },
    ];

    const grouped = prioritizePinnedTableOverviewRows(rows, () => false);

    expect(grouped.pinnedRows).toEqual([]);
    expect(grouped.regularRows.map((item) => item.name)).toEqual(['audit_log', 'users']);
    expect(grouped.orderedRows.map((item) => item.name)).toEqual(['audit_log', 'users']);
  });
});
