import { describe, expect, it } from 'vitest';
import { isQueryResultBareValueKeyword } from './queryResultValueKeywords';

describe('SQL bare value keyword semantics', () => {
  it.each([
    ['mysql', 'NULL'], ['kingbase', 'TRUE'], ['postgres', 'FALSE'], ['sqlite', 'CURRENT_DATE'],
    ['duckdb', 'CURRENT_TIME'], ['mysql', 'CURRENT_USER'], ['postgres', 'SESSION_USER'],
    ['oracle', 'SYSDATE'], ['sqlserver', 'CURRENT_TIMESTAMP'],
  ])('recognizes %s value %s', (dialect, value) => {
    expect(isQueryResultBareValueKeyword(value, dialect)).toBe(true);
  });

  it.each([
    ['mysql', 'user'], ['sqlserver', 'TRUE'], ['oracle', 'FALSE'],
    ['mysql', '`NULL`'], ['postgres', '"TRUE"'], ['postgres', 'c.NULL'],
  ])('preserves %s column expression %s', (dialect, value) => {
    expect(isQueryResultBareValueKeyword(value, dialect)).toBe(false);
  });
});
