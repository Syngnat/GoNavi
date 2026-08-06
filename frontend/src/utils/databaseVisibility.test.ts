import { describe, expect, it } from 'vitest';

import {
  filterVisibleDatabaseNames,
  hasDatabaseVisibilityRules,
  isDatabaseVisible,
  matchesDatabasePattern,
} from './databaseVisibility';

describe('database visibility patterns', () => {
  it('matches the complete database name and remains case-sensitive', () => {
    expect(matchesDatabasePattern('billing', 'billing')).toBe(true);
    expect(matchesDatabasePattern('billing_archive', 'billing')).toBe(false);
    expect(matchesDatabasePattern('Billing', 'billing')).toBe(false);
  });

  it('supports star and percent as equivalent zero-or-more wildcards', () => {
    expect(matchesDatabasePattern('team', 'team*')).toBe(true);
    expect(matchesDatabasePattern('team_prod', 'team*')).toBe(true);
    expect(matchesDatabasePattern('team_prod', 'team%')).toBe(true);
    expect(matchesDatabasePattern('preprod_archive', '*prod*')).toBe(true);
    expect(matchesDatabasePattern('team', 'team%prod')).toBe(false);
  });

  it('matches exactly one Unicode code point for underscore', () => {
    expect(matchesDatabasePattern('tenantA', 'tenant_')).toBe(true);
    expect(matchesDatabasePattern('tenant\ud83d\ude00', 'tenant_')).toBe(true);
    expect(matchesDatabasePattern('tenant', 'tenant_')).toBe(false);
    expect(matchesDatabasePattern('tenantAB', 'tenant_')).toBe(false);
  });

  it('supports literal wildcard and backslash characters through escaping', () => {
    expect(matchesDatabasePattern('sales_prod', 'sales\\_prod')).toBe(true);
    expect(matchesDatabasePattern('salesXprod', 'sales\\_prod')).toBe(false);
    expect(matchesDatabasePattern('star*db', 'star\\*db')).toBe(true);
    expect(matchesDatabasePattern('percent%db', 'percent\\%db')).toBe(true);
    expect(matchesDatabasePattern('path\\db', 'path\\\\db')).toBe(true);
  });

  it('treats a trailing or non-special backslash as a literal backslash', () => {
    expect(matchesDatabasePattern('archive\\', 'archive\\')).toBe(true);
    expect(matchesDatabasePattern('db\\q', 'db\\q')).toBe(true);
    expect(matchesDatabasePattern('dbq', 'db\\q')).toBe(false);
  });

  it('treats regular-expression syntax as literal database-name text', () => {
    const name = 'db.prod+(1)[x]{2}^$|?';
    expect(matchesDatabasePattern(name, name)).toBe(true);
    expect(matchesDatabasePattern('dbXprod+(1)[x]{2}^$|?', name)).toBe(false);
  });

  it('allows wildcards to span line characters without changing one-code-point semantics', () => {
    expect(matchesDatabasePattern('a\nb', 'a*b')).toBe(true);
    expect(matchesDatabasePattern('a\nb', 'a_b')).toBe(true);
    expect(matchesDatabasePattern('a\r\nb', 'a_b')).toBe(false);
  });
});

describe('database visibility rules', () => {
  it('shows every database when no include or exclude rule exists', () => {
    expect(isDatabaseVisible(undefined, 'app')).toBe(true);
    expect(filterVisibleDatabaseNames({}, ['app', 'audit'])).toEqual(['app', 'audit']);
    expect(hasDatabaseVisibilityRules({ includeDatabasePatterns: ['', ''] })).toBe(false);
    expect(hasDatabaseVisibilityRules({ excludeDatabasePatterns: ['sys%'] })).toBe(true);
  });

  it('preserves legacy includeDatabases as case-sensitive exact names', () => {
    const connection = { includeDatabases: ['user_prod'] };

    expect(isDatabaseVisible(connection, 'user_prod')).toBe(true);
    expect(isDatabaseVisible(connection, 'userXprod')).toBe(false);
    expect(isDatabaseVisible(connection, 'USER_PROD')).toBe(false);
  });

  it('uses exact includes and pattern includes as one inclusive OR set', () => {
    const connection = {
      includeDatabases: ['legacy_db'],
      includeDatabasePatterns: ['team%'],
    };

    expect(isDatabaseVisible(connection, 'legacy_db')).toBe(true);
    expect(isDatabaseVisible(connection, 'team_prod')).toBe(true);
    expect(isDatabaseVisible(connection, 'other')).toBe(false);
  });

  it('lets excludes win over both exact and pattern includes', () => {
    const connection = {
      includeDatabases: ['team_secret'],
      includeDatabasePatterns: ['team%'],
      excludeDatabasePatterns: ['team_secret', 'team_tmp%'],
    };

    expect(isDatabaseVisible(connection, 'team_prod')).toBe(true);
    expect(isDatabaseVisible(connection, 'team_secret')).toBe(false);
    expect(isDatabaseVisible(connection, 'team_tmp_2026')).toBe(false);
  });

  it('applies exclude-only rules to an otherwise visible complete list', () => {
    const connection = { excludeDatabasePatterns: ['sys%', '*_archive'] };

    expect(filterVisibleDatabaseNames(connection, [
      'app',
      'sys',
      'system',
      'app_archive',
    ])).toEqual(['app']);
  });

  it('ignores empty pattern entries instead of turning them into an include-all blocker', () => {
    expect(isDatabaseVisible({ includeDatabasePatterns: ['', ''] }, 'app')).toBe(true);
    expect(isDatabaseVisible({ excludeDatabasePatterns: ['', ''] }, 'app')).toBe(true);
    expect(isDatabaseVisible({ includeDatabasePatterns: ['   '] }, 'app')).toBe(true);
    expect(isDatabaseVisible({ excludeDatabasePatterns: ['\t'] }, 'app')).toBe(true);
    expect(hasDatabaseVisibilityRules({ includeDatabasePatterns: ['   '] })).toBe(false);
  });

  it('preserves source order and duplicate names without mutating the input', () => {
    const names = ['team_b', 'other', 'team_a', 'team_b'];
    const snapshot = [...names];

    expect(filterVisibleDatabaseNames({ includeDatabasePatterns: ['team%'] }, names)).toEqual([
      'team_b',
      'team_a',
      'team_b',
    ]);
    expect(names).toEqual(snapshot);
  });
});
