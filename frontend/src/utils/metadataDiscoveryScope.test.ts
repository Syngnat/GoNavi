import { describe, expect, it } from 'vitest';
import type { SavedConnection } from '../types';
import { buildRpcConnectionConfig } from './connectionRpcConfig';
import { buildMetadataDiscoveryScope, buildMetadataSchemaPredicate, scopeMetadataQuery } from './metadataDiscoveryScope';

const conn = (type = 'postgres') => ({ config: { type } }) as SavedConnection;

describe('metadata discovery scope', () => {
  it('keeps unrestricted connections unrestricted', () => {
    expect(buildMetadataDiscoveryScope(conn(), 'app')).toBeUndefined();
    const sql = 'SELECT nspname FROM pg_namespace ORDER BY nspname';
    expect(scopeMetadataQuery(sql, 'nspname')).toBe(sql);
  });

  it('carries the schema scope through the RPC constructor and leaves database visibility to the explorer', () => {
    const connection = {
      ...conn(),
      includeDatabases: ['app'],
      includeDatabasePatterns: ['tenant_*'],
      schemaVisibilityByDatabase: { app: { mode: 'include', schemas: ['public'] } },
    } as SavedConnection;
    const scope = buildMetadataDiscoveryScope(connection, 'app');
    const rpc = buildRpcConnectionConfig(connection.config, { metadataScope: scope });
    expect(JSON.parse(JSON.stringify(rpc)).metadataScope).toEqual({ schemas: { mode: 'include', names: ['public'], caseSensitive: true } });
    expect(buildMetadataDiscoveryScope({ ...conn(), includeDatabases: ['app'] } as SavedConnection, 'app')).toBeUndefined();
    expect(connection.config.database).toBeUndefined();
  });

  it('preserves PostgreSQL case and scopes each database independently', () => {
    const connection = { ...conn(), schemaVisibilityByDatabase: { app: { mode: 'include', schemas: ['Public', 'public'] } } } as SavedConnection;
    const scope = buildMetadataDiscoveryScope(connection, 'app')?.schemas;
    expect(scope?.names).toEqual(['Public', 'public']);
    expect(buildMetadataSchemaPredicate('n.nspname', scope)).toBe("n.nspname IN ('Public', 'public')");
    expect(buildMetadataDiscoveryScope(connection, 'other')).toBeUndefined();
  });

  it('retains exclude mode and escapes identifiers as values', () => {
    const connection = { ...conn(), schemaVisibilityByDatabase: { app: { mode: 'exclude', schemas: ["tenant'o", 'a.b'] } } } as SavedConnection;
    const scope = buildMetadataDiscoveryScope(connection, 'app')?.schemas;
    const sql = scopeMetadataQuery('SELECT nspname FROM pg_namespace WHERE nspname <> \'pg_catalog\' ORDER BY nspname', 'nspname', scope);
    expect(sql).toContain("AND nspname NOT IN ('tenant''o', 'a.b') ORDER BY");
  });

  it('adds WHERE when the catalog has no predicate', () => {
    expect(scopeMetadataQuery('SELECT nspname FROM pg_namespace ORDER BY nspname', 'nspname', { mode: 'include', names: ['public'], caseSensitive: true }))
      .toBe("SELECT nspname FROM pg_namespace WHERE nspname IN ('public') ORDER BY nspname");
  });

  it('keeps Unicode schema names as Unicode literals on SQL Server', () => {
    expect(buildMetadataSchemaPredicate('s.name', { mode: 'include', names: ['业务'], caseSensitive: false }, 'sqlserver'))
      .toBe("LOWER(s.name) IN (N'业务')");
  });

  it('uses explicit PostgreSQL escapes for a backslash in a schema identifier', () => {
    expect(buildMetadataSchemaPredicate('n.nspname', { mode: 'include', names: ["a\\'b"], caseSensitive: true }, 'postgres'))
      .toBe("n.nspname IN (E'a\\\\''b')");
  });
});
