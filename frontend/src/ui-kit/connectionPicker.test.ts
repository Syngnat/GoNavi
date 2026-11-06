import { describe, expect, it } from 'vitest';
import { decodeGonaviConnections } from './connectionPicker';

describe('connection picker helpers', () => {
  it('keeps sanitised summaries and drops malformed rows', () => {
    const connections = decodeGonaviConnections([
      { id: 'a', name: 'A', type: 'mysql', host: 'db', port: 3306, readOnly: true },
      { id: '', name: 'bad' },
      null,
      'text',
    ]);
    expect(connections).toEqual([{ id: 'a', name: 'A', type: 'mysql', host: 'db', port: 3306, readOnly: true }]);
  });

  it('rejects non-arrays', () => {
    expect(decodeGonaviConnections({ items: [] })).toEqual([]);
    expect(decodeGonaviConnections(undefined)).toEqual([]);
  });
});
