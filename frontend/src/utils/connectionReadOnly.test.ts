import { describe, expect, it } from 'vitest';

import {
  findConnectionMutatingStatements,
  findPotentiallyMutatingConnectionStatements,
  isConnectionDataEditRestricted,
  isConnectionDataImportRestricted,
  isConnectionScriptExecutionRestricted,
  isConnectionStructureEditRestricted,
  isSingleReadOnlyConnectionQuery,
  resolveConnectionProtectionConfig,
  supportsConnectionKeepAliveSQL,
  supportsConnectionReadOnlyMode,
} from './connectionReadOnly';

describe('connectionReadOnly', () => {
  it('accepts only one read-only SQL query for custom keepalive', () => {
    const config = { type: 'mysql' } as any;

    expect(supportsConnectionKeepAliveSQL(config)).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1')).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'WITH probe AS (SELECT 1) SELECT * FROM probe')).toBe(true);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1; SELECT 2')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'DELETE FROM accounts')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, '/*!50000 DELETE FROM accounts */ SELECT 1')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT /*!50000 SQL_NO_CACHE */ 1')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, "SELECT ';' AS probe")).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1 /* ; */')).toBe(false);
    expect(isSingleReadOnlyConnectionQuery(config, 'SELECT 1; -- probe')).toBe(true);
    expect(supportsConnectionKeepAliveSQL({ type: 'redis' } as any)).toBe(false);
  });

  it('supports Nacos production protection without treating it as a SQL keepalive source', () => {
    const config = { type: 'nacos' } as any;

    expect(supportsConnectionReadOnlyMode(config)).toBe(true);
    expect(supportsConnectionKeepAliveSQL(config)).toBe(false);
  });

  it('supports Elasticsearch production protection without treating it as a SQL keepalive source', () => {
    const config = { type: 'elasticsearch' } as any;

    expect(supportsConnectionReadOnlyMode(config)).toBe(true);
    expect(supportsConnectionKeepAliveSQL(config)).toBe(false);
  });

  it('maps legacy readOnly connections to the full production protection set', () => {
    expect(resolveConnectionProtectionConfig({
      type: 'postgres',
      readOnly: true,
    })).toEqual({
      restrictDataEdit: true,
      restrictStructureEdit: true,
      restrictScriptExecution: true,
      restrictDataImport: true,
    });
  });

  it('keeps partial protection flags isolated from each other', () => {
    const config = {
      type: 'postgres',
      protection: {
        restrictDataEdit: true,
        restrictDataImport: true,
      },
    };

    expect(isConnectionDataEditRestricted(config)).toBe(true);
    expect(isConnectionDataImportRestricted(config)).toBe(true);
    expect(isConnectionStructureEditRestricted(config)).toBe(false);
    expect(isConnectionScriptExecutionRestricted(config)).toBe(false);
  });

  it('only blocks mutating SQL when script execution protection is enabled', () => {
    expect(findConnectionMutatingStatements({
      type: 'postgres',
      protection: {
        restrictScriptExecution: true,
      },
    }, "SELECT * FROM users; UPDATE users SET name = 'next';")).toEqual([
      "UPDATE users SET name = 'next'",
    ]);

    expect(findConnectionMutatingStatements({
      type: 'postgres',
      protection: {
        restrictDataEdit: true,
      },
    }, "UPDATE users SET name = 'next';")).toEqual([]);
  });

  it('detects potentially mutating SQL even when protection is disabled', () => {
    const config = { type: 'postgres' } as any;

    expect(findPotentiallyMutatingConnectionStatements(
      config,
      'SELECT * FROM users;',
    )).toEqual([]);
    expect(findPotentiallyMutatingConnectionStatements(
      config,
      "SELECT * FROM users; UPDATE users SET name = 'next';",
    )).toEqual(["UPDATE users SET name = 'next'"]);
  });

  it('uses the connection dialect when filtering comment-only statements', () => {
    expect(findConnectionMutatingStatements({
      type: 'postgres',
      protection: {
        restrictScriptExecution: true,
      },
    }, 'SELECT * FROM users; /*! MySQL-only comment */')).toEqual([]);

    expect(findConnectionMutatingStatements({
      type: 'mysql',
      protection: {
        restrictScriptExecution: true,
      },
    }, 'SELECT * FROM users;--compact')).toEqual(['--compact']);
  });
});
