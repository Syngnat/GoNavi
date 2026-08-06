import { describe, expect, it } from 'vitest';

import {
  buildSelectedCellClipboardPayload,
  buildSelectedCellClipboardText,
  canSelectGridCellForClipboard,
} from './dataGridSelectionCopy';

describe('dataGridSelectionCopy helpers', () => {
  it('allows displayed read-only cells while keeping editable expressions out of batch selection', () => {
    expect(canSelectGridCellForClipboard({
      canModifyData: false,
      isDisplayedColumn: true,
      isWritableColumn: false,
    })).toBe(true);
    expect(canSelectGridCellForClipboard({
      canModifyData: true,
      isDisplayedColumn: true,
      isWritableColumn: false,
    })).toBe(false);
    expect(canSelectGridCellForClipboard({
      canModifyData: false,
      isDisplayedColumn: false,
      isWritableColumn: false,
    })).toBe(false);
  });

  it('builds clipboard text in visible row and column order', () => {
    const text = buildSelectedCellClipboardText({
      selectedCells: [
        { rowKey: 'row-2', colName: 'name' },
        { rowKey: 'row-1', colName: 'id' },
        { rowKey: 'row-1', colName: 'name' },
        { rowKey: 'row-2', colName: 'id' },
      ],
      rows: [
        { __rowKey: 'row-1', id: 1, name: 'Alice' },
        { __rowKey: 'row-2', id: 2, name: 'Bob' },
      ],
      columnOrder: ['id', 'name', 'email'],
      rowKeyField: '__rowKey',
    });

    expect(text).toBe('1\tAlice\n2\tBob');
  });

  it('normalizes null, objects and multiline text for clipboard safety', () => {
    const text = buildSelectedCellClipboardText({
      selectedCells: [
        { rowKey: 'row-1', colName: 'notes' },
        { rowKey: 'row-1', colName: 'meta' },
        { rowKey: 'row-2', colName: 'notes' },
        { rowKey: 'row-2', colName: 'meta' },
      ],
      rows: [
        { __rowKey: 'row-1', notes: null, meta: { a: 1 } },
        { __rowKey: 'row-2', notes: 'line1\nline2\tvalue', meta: [1, 2] },
      ],
      columnOrder: ['notes', 'meta'],
      rowKeyField: '__rowKey',
    });

    expect(text).toBe('NULL\t{"a":1}\nline1 line2 value\t[1,2]');
  });

  it('builds a multi-format payload for selected cells', () => {
    const payload = buildSelectedCellClipboardPayload({
      selectedCells: [
        { rowKey: 'row-1', colName: 'name' },
        { rowKey: 'row-1', colName: 'note' },
      ],
      rows: [
        { __rowKey: 'row-1', name: 'A&B', note: '<owner>' },
      ],
      columnOrder: ['name', 'note'],
      rowKeyField: '__rowKey',
    });

    expect(payload.plainText).toBe('A&B\t<owner>');
    expect(payload.csv).toBe('"A&B","<owner>"');
    expect(payload.html).toContain('<td>A&amp;B</td>');
    expect(payload.html).toContain('<td>&lt;owner&gt;</td>');
  });

  it('preserves tabs and newlines in rich selected-cell formats', () => {
    const payload = buildSelectedCellClipboardPayload({
      selectedCells: [
        { rowKey: 'row-1', colName: 'note' },
      ],
      rows: [
        { __rowKey: 'row-1', note: 'left\tright\nnext' },
      ],
      columnOrder: ['note'],
      rowKeyField: '__rowKey',
    });

    expect(payload.plainText).toBe('left right next');
    expect(payload.csv).toBe('"left\tright\nnext"');
    expect(payload.html).toContain('<td>left\tright\nnext</td>');
  });
});
