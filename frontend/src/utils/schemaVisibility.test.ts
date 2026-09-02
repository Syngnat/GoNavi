import { describe, expect, it } from 'vitest';

import type { SavedConnection } from '../types';
import {
  getSchemaVisibilityRule,
  isSchemaVisible,
  moveSchemaVisibilityEntry,
  moveSchemaVisibilityRule,
  removeSchemaVisibilityEntry,
  updateSchemaVisibilityRule,
} from './schemaVisibility';

const connection = (rules?: SavedConnection['schemaVisibilityByDatabase']): SavedConnection => ({
  id: 'conn-1',
  name: 'Primary',
  config: {
    id: 'conn-1',
    type: 'sqlserver',
    host: 'localhost',
    port: 1433,
    user: 'sa',
  },
  schemaVisibilityByDatabase: rules,
});

describe('schema visibility', () => {
  it('looks up per-database rules without changing identifier case semantics', () => {
    const rule = getSchemaVisibilityRule(connection({
      ecology: { mode: 'include', schemas: ['dbo'] },
    }), 'ECOLOGY');

    expect(rule).toEqual({ mode: 'include', schemas: ['dbo'] });
    expect(isSchemaVisible(rule, 'dbo')).toBe(true);
    expect(isSchemaVisible(rule, 'DBO')).toBe(true);
    expect(isSchemaVisible(rule, 'guest')).toBe(false);
  });

  it('hides only configured schemas in exclude mode', () => {
    const rule = getSchemaVisibilityRule(connection({
      ecology: { mode: 'exclude', schemas: ['db_accessadmin', 'guest'] },
    }), 'ecology');

    expect(isSchemaVisible(rule, 'dbo')).toBe(true);
    expect(isSchemaVisible(rule, 'GUEST')).toBe(false);
    expect(isSchemaVisible(undefined, 'dbo')).toBe(true);
  });

  it('writes one database rule and removes it when reset to show all', () => {
    const initial = connection({
      master: { mode: 'exclude', schemas: ['sys'] },
    });
    const updated = updateSchemaVisibilityRule(initial, 'ecology', {
      mode: 'include',
      schemas: ['dbo'],
    });

    expect(updated.schemaVisibilityByDatabase).toEqual({
      master: { mode: 'exclude', schemas: ['sys'] },
      ecology: { mode: 'include', schemas: ['dbo'] },
    });
    expect(updateSchemaVisibilityRule(updated, 'ECOLOGY', undefined).schemaVisibilityByDatabase).toEqual({
      master: { mode: 'exclude', schemas: ['sys'] },
    });
  });

  it('moves an existing rule when its database is renamed', () => {
    const moved = moveSchemaVisibilityRule(connection({
      ecology: { mode: 'exclude', schemas: ['db_accessadmin'] },
    }), 'ECOLOGY', 'ecology_prod');

    expect(moved.schemaVisibilityByDatabase).toEqual({
      ecology_prod: { mode: 'exclude', schemas: ['db_accessadmin'] },
    });
  });

  it('keeps case-distinct schemas independent for case-sensitive dialects', () => {
    const rule = getSchemaVisibilityRule(connection({
      analytics: { mode: 'include', schemas: ['foo', 'Foo'] },
    }), 'analytics', { caseSensitive: true });

    expect(rule).toEqual({ mode: 'include', schemas: ['foo', 'Foo'] });
    expect(isSchemaVisible(rule, 'foo', { caseSensitive: true })).toBe(true);
    expect(isSchemaVisible(rule, 'FOO', { caseSensitive: true })).toBe(false);
  });

  it('moves and removes schema names without changing the rest of the rule', () => {
    const initial = connection({
      analytics: { mode: 'include', schemas: ['public', 'reporting'] },
    });
    const moved = moveSchemaVisibilityEntry(
      initial,
      'analytics',
      'reporting',
      'Reporting',
      { caseSensitive: true },
    );

    expect(moved.schemaVisibilityByDatabase?.analytics.schemas).toEqual(['public', 'Reporting']);
    expect(removeSchemaVisibilityEntry(
      moved,
      'analytics',
      'Reporting',
      { caseSensitive: true },
    ).schemaVisibilityByDatabase?.analytics.schemas).toEqual(['public']);
    expect(removeSchemaVisibilityEntry(
      connection({ analytics: { mode: 'include', schemas: ['reporting'] } }),
      'analytics',
      'reporting',
      {},
      ['public', 'audit'],
    ).schemaVisibilityByDatabase?.analytics).toEqual({
      mode: 'include',
      schemas: ['public', 'audit'],
    });
    expect(removeSchemaVisibilityEntry(
      connection({ analytics: { mode: 'include', schemas: ['reporting'] } }),
      'analytics',
      'reporting',
    ).schemaVisibilityByDatabase?.analytics).toEqual({
      mode: 'include',
      schemas: ['reporting'],
    });
    expect(removeSchemaVisibilityEntry(
      connection({ analytics: { mode: 'exclude', schemas: ['reporting'] } }),
      'analytics',
      'reporting',
    ).schemaVisibilityByDatabase).toBeUndefined();
  });
});
