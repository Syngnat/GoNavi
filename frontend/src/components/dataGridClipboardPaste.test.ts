import { describe, expect, it } from 'vitest';

import { buildDataGridClipboardPasteRows, parseDataGridClipboardText } from './dataGridClipboardPaste';

const isValueEqual = (left: unknown, right: unknown) => {
  if (left === right) return true;
  const leftNullish = left === null || left === undefined;
  const rightNullish = right === null || right === undefined;
  return leftNullish && rightNullish;
};

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
