import { describe, expect, it } from 'vitest';
import { UI_LIMITS, validateUINode } from './uiValidation';
describe('panel text bounds', () => {
  it('allows host-sized text and rejects one byte over the text or title limit', () => {
    expect(validateUINode({ type: 'text', text: 'a'.repeat(8193) }, new Set())).toMatchObject({ text: 'a'.repeat(8193) });
    expect(() => validateUINode({ type: 'text', text: 'a'.repeat(16385) }, new Set())).toThrow();
    expect(() => validateUINode({ type: 'text', title: 'a'.repeat(1025) }, new Set())).toThrow(/invalid_schema/);
    const commands = new Set(['run']);
    expect(validateUINode({ type: 'table', columns: [{ key: '中'.repeat(42), title: '中'.repeat(85) }], rows: [] }, commands).type).toBe('table');
    expect(() => validateUINode({ type: 'table', columns: [{ key: '中'.repeat(43), title: 'C' }], rows: [] }, commands)).toThrow();
    expect(() => validateUINode({ type: 'table', columns: [{ key: 'c', title: '中'.repeat(86) }], rows: [] }, commands)).toThrow();
    expect(validateUINode({ type: 'button', command: 'run', arguments: { k: 'a'.repeat(64 * 1024 - 8) } }, commands).type).toBe('button');
    expect(() => validateUINode({ type: 'button', command: 'run', arguments: { k: 'a'.repeat(64 * 1024 - 7) } }, commands)).toThrow();
  });
});
describe('panel node depth bounds', () => {
  it('accepts a body that nests to the host node limit', () => {
    let body: Record<string, unknown> = { type: 'text', text: 'leaf' };
    for (let level = 0; level < UI_LIMITS.depth; level += 1) body = { type: 'column', children: [body] };
    expect(validateUINode(body, new Set())).toBe(body);
  });
  it('rejects a body one node past the host limit', () => {
    let body: Record<string, unknown> = { type: 'text', text: 'leaf' };
    for (let level = 0; level <= UI_LIMITS.depth; level += 1) body = { type: 'column', children: [body] };
    expect(() => validateUINode(body, new Set())).toThrow(/invalid_schema/);
  });
});
describe('panel value budget', () => {
  it('accepts a table at the host row and column limits', () => {
    const keys = Array.from({ length: UI_LIMITS.columns }, (_, index) => `c${index}`);
    const table = {
      type: 'table',
      columns: keys.map((key) => ({ key, title: key })),
      rows: Array.from({ length: UI_LIMITS.rows }, () => Object.fromEntries(keys.map((key) => [key, 'v']))),
    };
    expect(validateUINode(table, new Set())).toBe(table);
  });
  it('still rejects a table past the value budget', () => {
    const columns = [{ key: 'c', title: 'C' }];
    expect(() => validateUINode({ type: 'table', columns, rows: Array.from({ length: UI_LIMITS.rows + 1 }, () => ({ c: 'v' })) }, new Set())).toThrow(/invalid_schema/);
  });
});
