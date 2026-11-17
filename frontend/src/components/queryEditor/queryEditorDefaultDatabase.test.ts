import { describe, expect, it } from 'vitest';
import { resolveDefaultQueryEditorDatabase } from './queryEditorDefaultDatabase';

describe('resolveDefaultQueryEditorDatabase', () => {
  it('prefers the configured connection database when the tab has none selected', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql', database: 'main' },
      currentDb: '',
      databaseNames: ['information_schema', 'main'],
    })).toBe('main');
  });

  it('skips system databases when the connection has no configured database', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '',
      databaseNames: ['information_schema', 'mysql', 'performance_schema', 'app'],
    })).toBe('app');
  });

  it('prefers the active sidebar database over the first visible database', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '',
      databaseNames: ['information_schema', 'first_db', 'business_db'],
      preferredDbName: 'business_db',
    })).toBe('business_db');
  });

  it('keeps an iot business database active instead of the first visible database', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '',
      databaseNames: ['information_schema', 'app', 'iot'],
      preferredDbName: 'iot',
    })).toBe('iot');
  });

  it('falls back to the most recent database target when no active database exists', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '',
      databaseNames: ['information_schema', 'first_db', 'recent_db'],
      recentDbNames: ['recent_db', 'older_db'],
    })).toBe('recent_db');
  });

  it('ignores preferred and recent databases that are not visible', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '',
      databaseNames: ['information_schema', 'first_db'],
      preferredDbName: 'hidden_db',
      recentDbNames: ['hidden_db'],
    })).toBe('first_db');
  });

  it('keeps an already selected database', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: 'main',
      databaseNames: ['information_schema', 'main'],
    })).toBe('');
  });

  it('ignores blank and padded database names', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '  ',
      databaseNames: ['', ' main '],
    })).toBe('main');
  });

  it('leaves elasticsearch index selection untouched', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'elasticsearch' },
      currentDb: '',
      databaseNames: ['logs-2024'],
    })).toBe('');
  });

  it('leaves connection scoped sqlite tabs untouched', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'sqlite' },
      currentDb: '',
      databaseNames: ['main'],
    })).toBe('');
  });

  it('returns empty when the connection has no database to select', () => {
    expect(resolveDefaultQueryEditorDatabase({
      config: { type: 'mysql' },
      currentDb: '',
      databaseNames: [],
    })).toBe('');
  });
});
