import { describe, expect, it } from 'vitest';

import { buildRegistryPaginatedSelectSQL, resolveRegistryQuoting } from './sqlBehavior';
import { buildPaginatedSelectSQL, quoteIdentPart } from '../sql';
import { isMysqlFamilyDialect, isPgLikeDialect, resolveSqlDialect, resolveTableAliasSyntax } from '../sqlDialectCore';
import { resolveSidebarMetadataDialect } from '../sidebarMetadata';

describe('registry SQL behavior', () => {
  it('quotes identifiers by compatibility family', () => {
    expect(resolveRegistryQuoting('tidb')).toBe('backtick');
    expect(quoteIdentPart('tidb', 'users')).toBe('`users`');
    expect(resolveRegistryQuoting('cockroachdb')).toBe('pg');
    expect(quoteIdentPart('cockroachdb', 'users')).toBe('users');
    expect(quoteIdentPart('crdb', 'Users')).toBe('"Users"');
    expect(resolveRegistryQuoting('mysql')).toBeUndefined();
  });

  it('keeps default LIMIT/OFFSET pagination unless a style is declared', () => {
    expect(buildRegistryPaginatedSelectSQL('tidb', 'SELECT * FROM t', '', 10, 20)).toBeUndefined();
    expect(buildPaginatedSelectSQL('tidb', 'SELECT * FROM t', ' ORDER BY id', 10, 20)).toBe('SELECT * FROM t ORDER BY id LIMIT 10 OFFSET 20');
  });

  it('resolves registry dialects and their families', () => {
    expect(resolveSqlDialect('tidb')).toBe('mysql');
    expect(resolveSqlDialect('crdb')).toBe('postgres');
    expect(resolveSqlDialect('kaiwudb')).toBe('postgres');
    expect(resolveSidebarMetadataDialect('tidb')).toBe('mysql');
    expect(isPgLikeDialect('cockroachdb')).toBe(true);
    expect(isPgLikeDialect('kwdb')).toBe(true);
    expect(isMysqlFamilyDialect('tidb')).toBe(true);
    expect(isMysqlFamilyDialect('cockroachdb')).toBe(false);
    expect(resolveTableAliasSyntax('kwdb')).toBe('as');
  });
});
