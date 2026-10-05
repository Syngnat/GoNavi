import { describe, expect, it } from 'vitest';

import { buildUriFromValues, getUriPlaceholder, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { findRegistryUriScheme, getRegistryUriScheme } from './uriScheme';

describe('registry connection URI schemes', () => {
  it('resolves the declared schemes of registry data sources only', () => {
    expect(getRegistryUriScheme('tidb')).toBe('tidb');
    expect(getRegistryUriScheme('crdb')).toBe('cockroachdb');
    expect(getRegistryUriScheme('mysql')).toBeUndefined();
    expect(findRegistryUriScheme('tidb', ' TiDB://root@h:4000/app')).toBe('tidb');
    expect(findRegistryUriScheme('tidb', 'postgres://h/app')).toBeUndefined();
  });

  it('parses and rebuilds TiDB URIs with the tidb scheme through the MySQL parser', () => {
    const parsed = parseUriToValues('tidb://root:secret@127.0.0.1:4000,127.0.0.2:4000/app?timeout=15', 'tidb');
    expect(parsed).toMatchObject({
      host: '127.0.0.1',
      port: 4000,
      user: 'root',
      password: 'secret',
      database: 'app',
      mysqlTopology: 'replica',
      mysqlReplicaHosts: ['127.0.0.2:4000'],
      timeout: 15,
    });
    expect(parseUriToValues('mysql://root@127.0.0.1:4000/app', 'tidb')).toMatchObject({ database: 'app' });

    const built = buildUriFromValues({ type: 'tidb', host: '127.0.0.1', port: 4000, user: 'root', database: 'app', timeout: 30 });
    expect(built).toBe('tidb://root@127.0.0.1:4000/app?timeout=30');
    expect(getUriPlaceholder('tidb')).toContain('tidb://user:pass@127.0.0.1:4000');
  });

  it('round-trips CockroachDB URIs with its own schemes and default port', () => {
    expect(parseUriToValues('crdb://root@127.0.0.1:26257/defaultdb', 'cockroachdb')).toMatchObject({
      host: '127.0.0.1',
      port: 26257,
      user: 'root',
      database: 'defaultdb',
    });
    const built = buildUriFromValues({ type: 'cockroachdb', host: '127.0.0.1', port: 26257, user: 'root', database: 'defaultdb' });
    expect(built.startsWith('cockroachdb://root@127.0.0.1:26257/defaultdb')).toBe(true);
    expect(getUriPlaceholder('cockroachdb')).toContain('cockroachdb://user:pass@127.0.0.1:26257/db_name');
  });
});
