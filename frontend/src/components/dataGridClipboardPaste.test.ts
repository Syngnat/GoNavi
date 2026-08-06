import { describe, expect, it } from 'vitest';

import {
  buildDataGridClipboardPasteRows,
  parseDataGridClipboardData,
  parseDataGridClipboardText,
} from './dataGridClipboardPaste';
import { buildSelectedCellClipboardPayload } from './dataGridSelectionCopy';

const isValueEqual = (left: unknown, right: unknown) => {
  if (left === right) return true;
  const leftNullish = left === null || left === undefined;
  const rightNullish = right === null || right === undefined;
  return leftNullish && rightNullish;
};

const clipboardData = (values: Record<string, string>) => ({
  types: Object.keys(values),
  getData: (type: string) => values[type] || '',
});

describe('dataGridClipboardPaste helpers', () => {
  it('parses rows, columns, empty values, CRLF and database NULL values', () => {
    expect(parseDataGridClipboardText('alpha\tNULL\r\n\tbeta\r\n')).toEqual([
      ['alpha', null],
      ['', 'beta'],
    ]);
    expect(parseDataGridClipboardText('alpha\n\n')).toEqual([
      ['alpha'],
      [''],
    ]);
    expect(parseDataGridClipboardText('')).toEqual([['']]);
  });

  it('prefers HTML table data over plain TSV so tabs inside cells are preserved', () => {
    const matrix = parseDataGridClipboardData(clipboardData({
      'text/plain': 'alpha\tbeta\t<ok>',
      'text/html': '<meta charset="utf-8"><table><tbody><tr><td>alpha\tbeta</td><td>&lt;ok&gt;</td></tr></tbody></table>',
    }));

    expect(matrix).toEqual([
      ['alpha\tbeta', '<ok>'],
    ]);
  });

  it('preserves literal tab characters from text/html cells', () => {
    const matrix = parseDataGridClipboardData(clipboardData({
      'text/html': '<table><tbody><tr><td>left\tright</td><td>next</td></tr></tbody></table>',
    }));

    expect(matrix).toEqual([
      ['left\tright', 'next'],
    ]);
  });

  it('parses CSV cells with embedded tabs, quotes and newlines', () => {
    const matrix = parseDataGridClipboardData(clipboardData({
      'text/plain': 'alpha\tbeta\tline1\nline2',
      'text/csv': '"alpha\tbeta","say ""hi""","line1\nline2"\n"NULL","",tail',
    }));

    expect(matrix).toEqual([
      ['alpha\tbeta', 'say "hi"', 'line1\nline2'],
      [null, '', 'tail'],
    ]);
  });

  it('falls back to plain TSV when no richer table format is present', () => {
    expect(parseDataGridClipboardData(clipboardData({
      'text/plain': 'alpha\tNULL\r\n\tbeta\r\n',
    }))).toEqual([
      ['alpha', null],
      ['', 'beta'],
    ]);
  });

  it('round-trips a multi-row multi-column selection into a coordinate paste matrix', () => {
    const payload = buildSelectedCellClipboardPayload({
      selectedCells: [
        { rowKey: 'source-2', colName: 'colC' },
        { rowKey: 'source-1', colName: 'colA' },
        { rowKey: 'source-1', colName: 'colB' },
        { rowKey: 'source-2', colName: 'colB' },
        { rowKey: 'source-1', colName: 'colC' },
        { rowKey: 'source-2', colName: 'colA' },
      ],
      rows: [
        { __rowKey: 'source-1', colA: 'A1', colB: 'B\t1', colC: 'C1' },
        { __rowKey: 'source-2', colA: 'A2', colB: 'B2', colC: 'C\n2' },
      ],
      columnOrder: ['colA', 'colB', 'colC'],
      rowKeyField: '__rowKey',
    });

    expect(payload.plainText).toBe('A1\tB 1\tC1\nA2\tB2\tC 2');

    const matrix = parseDataGridClipboardData(clipboardData({
      'text/plain': payload.plainText,
      'text/html': payload.html || '',
      'text/csv': payload.csv || '',
    }));
    expect(matrix).toEqual([
      ['A1', 'B\t1', 'C1'],
      ['A2', 'B2', 'C\n2'],
    ]);

    const result = buildDataGridClipboardPasteRows({
      matrix,
      rows: [
        { rowKey: 'target-1', colA: 'old-a1', colB: 'old-b1', colC: 'old-c1' },
        { rowKey: 'target-2', colA: 'old-a2', colB: 'old-b2', colC: 'old-c2' },
      ],
      columnNames: ['colA', 'colB', 'colC'],
      startRowIndex: 0,
      startColumnIndex: 0,
      rowKeyField: 'rowKey',
      addedRowKeys: new Set(),
      modifiedRows: {},
      deletedRowKeys: new Set(),
      isWritableColumn: () => true,
      isValueEqual,
    });

    expect(result).toEqual({
      rows: [
        {
          rowKey: 'target-1',
          values: { colA: 'A1', colB: 'B\t1', colC: 'C1' },
          modifiedValues: { colA: 'A1', colB: 'B\t1', colC: 'C1' },
          modifiedColumnNames: ['colA', 'colB', 'colC'],
          isAdded: false,
        },
        {
          rowKey: 'target-2',
          values: { colA: 'A2', colB: 'B2', colC: 'C\n2' },
          modifiedValues: { colA: 'A2', colB: 'B2', colC: 'C\n2' },
          modifiedColumnNames: ['colA', 'colB', 'colC'],
          isAdded: false,
        },
      ],
      updatedCellCount: 6,
    });
  });

  it('maps a clipboard matrix by coordinates without shifting past read-only columns', () => {
    const result = buildDataGridClipboardPasteRows({
      matrix: [
        ['11', 'ignored', 'Ada'],
        ['12', 'ignored', null],
        ['outside', 'outside', 'outside'],
      ],
      rows: [
        { rowKey: 'row-1', id: '1', generated: 'A', name: 'old' },
        { rowKey: 'row-2', id: '2', generated: 'B', name: 'value' },
      ],
      columnNames: ['id', 'generated', 'name'],
      startRowIndex: 0,
      startColumnIndex: 0,
      rowKeyField: 'rowKey',
      addedRowKeys: new Set(),
      modifiedRows: {},
      deletedRowKeys: new Set(),
      isWritableColumn: (columnName) => columnName !== 'generated',
      isValueEqual,
    });

    expect(result).toEqual({
      rows: [
        {
          rowKey: 'row-1',
          values: { id: '11', name: 'Ada' },
          modifiedValues: { id: '11', name: 'Ada' },
          modifiedColumnNames: ['id', 'name'],
          isAdded: false,
        },
        {
          rowKey: 'row-2',
          values: { id: '12', name: null },
          modifiedValues: { id: '12', name: null },
          modifiedColumnNames: ['id', 'name'],
          isAdded: false,
        },
      ],
      updatedCellCount: 4,
    });
  });

  it('preserves other drafts and removes values pasted back to their originals', () => {
    const result = buildDataGridClipboardPasteRows({
      matrix: [['original']],
      rows: [{ rowKey: 'row-1', name: 'original', note: 'base' }],
      columnNames: ['name', 'note'],
      startRowIndex: 0,
      startColumnIndex: 0,
      rowKeyField: 'rowKey',
      addedRowKeys: new Set(),
      modifiedRows: { 'row-1': { name: 'draft', note: 'kept' } },
      deletedRowKeys: new Set(),
      isWritableColumn: () => true,
      isValueEqual,
    });

    expect(result).toEqual({
      rows: [{
        rowKey: 'row-1',
        values: { name: 'original' },
        modifiedValues: { note: 'kept' },
        modifiedColumnNames: ['note'],
        isAdded: false,
      }],
      updatedCellCount: 1,
    });
  });

  it('preserves a previous draft after its column becomes read-only', () => {
    const result = buildDataGridClipboardPasteRows({
      matrix: [['updated']],
      rows: [{ rowKey: 'row-1', name: 'base', payload: 'original' }],
      columnNames: ['name', 'payload'],
      startRowIndex: 0,
      startColumnIndex: 0,
      rowKeyField: 'rowKey',
      addedRowKeys: new Set(),
      modifiedRows: { 'row-1': { payload: 'draft' } },
      deletedRowKeys: new Set(),
      isWritableColumn: (columnName) => columnName === 'name',
      isValueEqual,
    });

    expect(result.rows[0]).toEqual({
      rowKey: 'row-1',
      values: { name: 'updated' },
      modifiedValues: { payload: 'draft', name: 'updated' },
      modifiedColumnNames: ['payload', 'name'],
      isAdded: false,
    });
  });

  it('updates added rows and skips deleted rows', () => {
    const result = buildDataGridClipboardPasteRows({
      matrix: [['new'], ['deleted']],
      rows: [
        { rowKey: 'new-1', name: '' },
        { rowKey: 'row-2', name: 'old' },
      ],
      columnNames: ['name'],
      startRowIndex: 0,
      startColumnIndex: 0,
      rowKeyField: 'rowKey',
      addedRowKeys: new Set(['new-1']),
      modifiedRows: {},
      deletedRowKeys: new Set(['row-2']),
      isWritableColumn: () => true,
      isValueEqual,
    });

    expect(result).toEqual({
      rows: [{
        rowKey: 'new-1',
        values: { name: 'new' },
        modifiedValues: {},
        modifiedColumnNames: [],
        isAdded: true,
      }],
      updatedCellCount: 1,
    });
  });
});
