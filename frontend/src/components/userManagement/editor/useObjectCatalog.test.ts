import { describe, expect, it } from 'vitest';
import { extractDatabaseNames } from './useObjectCatalog';

describe('extractDatabaseNames', () => {
  it('reads names from {Database} rows returned by DBGetDatabases', () => {
    expect(extractDatabaseNames([{ Database: 'sales' }, { database: 'hr' }, { name: 'ops' }])).toEqual(['sales', 'hr', 'ops']);
  });

  it('accepts plain strings, drops blanks and duplicates, never yields [object Object]', () => {
    expect(extractDatabaseNames(['a', ' a ', '', null, { other: 1 }, 'b'])).toEqual(['a', 'b']);
  });

  it('returns an empty list for non-array payloads', () => {
    expect(extractDatabaseNames(undefined)).toEqual([]);
    expect(extractDatabaseNames({ Database: 'x' })).toEqual([]);
  });
});
