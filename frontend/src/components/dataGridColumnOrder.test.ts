import { describe, expect, it } from 'vitest';

import {
  DATA_GRID_COLUMN_ORDER_DRAG_MIME,
  decodeDataGridColumnOrderDragPayload,
  encodeDataGridColumnOrderDragPayload,
  hasDataGridColumnOrderDragPayload,
  moveDataGridColumnInVisibleOrder,
  shouldBypassDndKitForNativeColumnHeaderDrag,
} from './dataGridColumnOrder';

describe('dataGridColumnOrder helpers', () => {
  it('reorders a dragged visible column at the header drop target while hidden columns keep their slot', () => {
    expect(moveDataGridColumnInVisibleOrder(
      ['id', 'hidden_note', 'name', 'code'],
      new Set(['hidden_note']),
      'code',
      'id',
    )).toEqual(['code', 'hidden_note', 'id', 'name']);
  });

  it('keeps the column reorder payload scoped to its source result set', () => {
    const payload = encodeDataGridColumnOrderDragPayload({
      scope: 'result-set-1',
      columnName: 'title',
    });

    expect(decodeDataGridColumnOrderDragPayload(payload)).toEqual({
      scope: 'result-set-1',
      columnName: 'title',
    });
    expect(hasDataGridColumnOrderDragPayload({
      types: [DATA_GRID_COLUMN_ORDER_DRAG_MIME],
    })).toBe(true);
    expect(decodeDataGridColumnOrderDragPayload('{')).toBeNull();
  });

  it('keeps touch and pen pointer input on dnd-kit instead of native HTML drag', () => {
    expect(shouldBypassDndKitForNativeColumnHeaderDrag('mouse')).toBe(true);
    expect(shouldBypassDndKitForNativeColumnHeaderDrag('touch')).toBe(false);
    expect(shouldBypassDndKitForNativeColumnHeaderDrag('pen')).toBe(false);
  });
});
