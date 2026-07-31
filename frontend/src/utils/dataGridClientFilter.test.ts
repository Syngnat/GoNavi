import { describe, expect, it } from 'vitest';
import { countGridColumnValues, filterRowsByGridConditions } from './dataGridClientFilter';

describe('countGridColumnValues', () => {
  it('counts nullish, empty, scalar, and stable complex values separately', () => {
    const rows = [
      { value: null },
      { value: undefined },
      { value: '' },
      { value: 1 },
      { value: '1' },
      { value: true },
      { value: { b: 2, a: 1 } },
      { value: { a: 1, b: 2 } },
      { value: ['x', 1] },
    ];

    expect(countGridColumnValues(rows, 'value')).toEqual([
      { key: 'nullish', display: '', kind: 'nullish', count: 2 },
      { key: 'object:{"a":1,"b":2}', display: '{"a":1,"b":2}', kind: 'value', count: 2 },
      { key: 'empty', display: '', kind: 'empty', count: 1 },
      { key: 'object:["x",1]', display: '["x",1]', kind: 'value', count: 1 },
      { key: 'number:1', display: '1', kind: 'value', count: 1 },
      { key: 'string:1', display: '1', kind: 'value', count: 1 },
      { key: 'boolean:true', display: 'true', kind: 'value', count: 1 },
    ]);
  });

  it('sorts by count, display text, and stable key', () => {
    expect(countGridColumnValues([
      { value: '10' },
      { value: '2' },
      { value: 2 },
      { value: '10' },
    ], 'value').map(({ key, count }) => ({ key, count }))).toEqual([
      { key: 'string:10', count: 2 },
      { key: 'number:2', count: 1 },
      { key: 'string:2', count: 1 },
    ]);
  });
});

describe('filterRowsByGridConditions', () => {
  const rows = [
    { id: 1, name: 'Alice', status: 'active' },
    { id: 2, name: 'Bob', status: 'disabled' },
    { id: 3, name: 'Carol', status: null },
  ];

  it('returns original rows when no active conditions', () => {
    expect(filterRowsByGridConditions(rows, [])).toEqual(rows);
    expect(filterRowsByGridConditions(rows, [{ column: 'name', op: 'CONTAINS', value: 'x', enabled: false }])).toEqual(rows);
  });

  it('filters by contains and equality', () => {
    expect(filterRowsByGridConditions(rows, [
      { column: 'name', op: 'CONTAINS', value: 'a', enabled: true },
    ]).map((row) => row.id)).toEqual([1, 3]);

    expect(filterRowsByGridConditions(rows, [
      { column: 'id', op: '=', value: '2', enabled: true },
    ]).map((row) => row.id)).toEqual([2]);
  });

  it('uses the stable complex display text for equality filtering', () => {
    const rows = [
      { id: 1, value: { b: 2, a: 1 } },
      { id: 2, value: { a: 1, b: 3 } },
    ];

    expect(filterRowsByGridConditions(rows, [
      { column: 'value', op: '=', value: '{"a":1,"b":2}', enabled: true },
    ]).map((row) => row.id)).toEqual([1]);
  });

  it('supports null checks and OR logic', () => {
    expect(filterRowsByGridConditions(rows, [
      { column: 'status', op: 'IS_NULL', enabled: true },
    ]).map((row) => row.id)).toEqual([3]);

    expect(filterRowsByGridConditions(rows, [
      { column: 'status', op: '=', value: 'active', enabled: true },
      { column: 'status', op: 'IS_NULL', logic: 'OR', enabled: true },
    ]).map((row) => row.id)).toEqual([1, 3]);
  });
});
