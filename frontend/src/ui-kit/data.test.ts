import { describe, expect, it } from 'vitest';
import { formatCapabilityCell, formatJson, inferResultColumns } from './data';
import { readGonaviPageLaunch } from './hooks';

describe('plugin UI data helpers', () => {
  it('formats JSON and non-JSON capability cells without HTML', () => {
    expect(formatJson({ a: 1 })).toContain('"a": 1');
    expect(formatJson(undefined)).toBe('undefined');
    expect(formatCapabilityCell(null)).toBe('null');
    expect(formatCapabilityCell({ name: '<b>x</b>' })).toContain('<b>x</b>');
    expect(formatCapabilityCell(true)).toBe('true');
  });

  it('infers stable columns from the union of row keys', () => {
    const columns = inferResultColumns([
      { id: 1, name: 'a' },
      { id: 2, extra: { nested: true } },
    ]);
    expect(columns.map((column) => column.key)).toEqual(['id', 'name', 'extra']);
    expect(columns).toHaveLength(3);
  });

  it('validates page launch context without requiring credentials', () => {
    expect(readGonaviPageLaunch({ kind: 'connectionAction', connectionId: 'c1', database: 'app', readOnly: true }))
      .toMatchObject({ connectionId: 'c1', database: 'app', readOnly: true });
    expect(readGonaviPageLaunch({ kind: 'other', connectionId: 'c1' })).toBeNull();
    expect(readGonaviPageLaunch({ kind: 'connectionAction' })).toBeNull();
  });

  it('caps inferred columns', () => {
    const row = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
    expect(inferResultColumns([row], 8)).toHaveLength(8);
  });
});
