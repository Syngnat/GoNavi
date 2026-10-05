import { describe, expect, it } from 'vitest';

import { buildUriFromValues, getConnectionParamsPlaceholder, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { findPotentiallyMutatingConnectionStatements, supportsConnectionReadOnlyMode } from '../connectionReadOnly';
import { getDataSourceCapabilityContract } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteQualifiedIdent } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { isReadOnlyEtcdCommand } from './commandReadOnly';

const etcd = { type: 'etcd' } as never;

describe('etcd registry behavior', () => {
  it('joins the config center group on port 2379 with its own command dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.config_center'));
    expect(group?.items.map((item) => item.key)).toContain('etcd');
    expect(getConnectionTypeDefaultPort('etcd')).toBe(2379);
    expect(resolveSqlDialect('etcd')).toBe('etcd');
    expect(getDataSourceCapabilityContract(etcd).ui?.forceReadOnlyStructureDesigner).toBe(true);
    expect(getDataSourceCapabilityContract(etcd).navigation?.schemaIdentifierCaseSensitive).toBe(true);
    expect(supportsConnectionReadOnlyMode(etcd)).toBe(true);
  });

  it('keeps key paths with dots as one identifier when browsing', () => {
    expect(quoteQualifiedIdent('etcd', '/config/app.yaml')).toBe('"/config/app.yaml"');
    expect(buildPaginatedSelectSQL('etcd', 'SELECT * FROM "/config/app.yaml"', ' ORDER BY "key" ASC', 100, 200)).toBe(
      'SELECT * FROM "/config/app.yaml" ORDER BY "key" ASC LIMIT 100 OFFSET 200',
    );
    // 其他 SQL 方言照常按点拆分限定名。
    expect(quoteQualifiedIdent('postgres', 'public.orders')).toBe('public.orders');
  });

  it('parses http(s) and etcd:// endpoints', () => {
    expect(parseUriToValues('https://etcd-0.example.com:2379', 'etcd')).toMatchObject({ host: 'etcd-0.example.com', port: 2379, useSSL: true });
    expect(buildUriFromValues({ type: 'etcd', host: '127.0.0.1', port: 2379 }).startsWith('http://127.0.0.1:2379')).toBe(true);
    expect(getConnectionParamsPlaceholder('etcd', 'mysql')).toContain('prefix=/app');
  });

  it('classifies etcdctl-style commands like the Go driver', () => {
    for (const statement of ['get /app --prefix', 'watch /app --prefix --timeout=5', 'lease list', 'member list', 'endpoint status', 'SELECT * FROM "/app" LIMIT 10', 'ls /dir']) {
      expect(isReadOnlyEtcdCommand(statement), statement).toBe(true);
      expect(findPotentiallyMutatingConnectionStatements(etcd, statement), statement).toEqual([]);
    }
    for (const statement of ['put /app/name gonavi', 'del /app --prefix', 'lease grant 60', 'compaction 100', 'set /a 1', 'rm /a --recursive']) {
      expect(isReadOnlyEtcdCommand(statement), statement).toBe(false);
      expect(findPotentiallyMutatingConnectionStatements(etcd, statement), statement).toEqual([statement]);
    }
  });
});
