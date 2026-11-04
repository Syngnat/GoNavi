import { describe, expect, it } from 'vitest';
import { applyGonaviGridEdit, gonaviRowKey } from './editableGrid';

type Row = Record<string, unknown>;

describe('editable grid helpers', () => {
  it('resolves row keys from a field or a function', () => {
    expect(gonaviRowKey({ id: 7 }, 'id')).toBe('7');
    expect(gonaviRowKey({ id: 7 }, (row) => `row-${row.id}`)).toBe('row-7');
    expect(gonaviRowKey({}, 'id')).toBe('');
  });

  it('updates only the matching row without mutating the input', () => {
    const rows: Row[] = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
    const next = applyGonaviGridEdit(rows, 'id', '2', 'name', 'B');
    expect(next[1].name).toBe('B');
    expect(next[0]).toBe(rows[0]);
    expect(rows[1].name).toBe('b');
  });
});
