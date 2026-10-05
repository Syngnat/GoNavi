import { describe, expect, it } from 'vitest';

import { buildUriFromValues, getConnectionParamsPlaceholder, parseUriToValues } from '../../components/connectionModal/connectionModalUri';
import { CONNECTION_TYPE_GROUPS, getConnectionTypeDefaultPort } from '../connectionTypeCatalog';
import { findPotentiallyMutatingConnectionStatements, supportsConnectionReadOnlyMode } from '../connectionReadOnly';
import { getDataSourceCapabilityContract } from '../dataSourceCapabilities';
import { buildPaginatedSelectSQL, quoteQualifiedIdent } from '../sql';
import { resolveSqlDialect } from '../sqlDialectCore';
import { isReadOnlyZooKeeperCommand } from './commandReadOnly';

const zookeeper = { type: 'zookeeper' } as never;

describe('ZooKeeper registry behavior', () => {
  it('joins the config center group on port 2181 with its own command dialect', () => {
    const group = CONNECTION_TYPE_GROUPS.find((item) => item.labelKey.endsWith('.config_center'));
    expect(group?.items.map((item) => item.key)).toContain('zookeeper');
    expect(getConnectionTypeDefaultPort('zookeeper')).toBe(2181);
    expect(resolveSqlDialect('zookeeper')).toBe('zookeeper');
    expect(getDataSourceCapabilityContract(zookeeper).ui?.forceReadOnlyStructureDesigner).toBe(true);
    expect(getDataSourceCapabilityContract(zookeeper).navigation?.schemaIdentifierCaseSensitive).toBe(true);
    expect(supportsConnectionReadOnlyMode(zookeeper)).toBe(true);
  });

  it('keeps znode paths with dots as one identifier when browsing', () => {
    expect(quoteQualifiedIdent('zookeeper', '/dubbo/com.example.UserService')).toBe('"/dubbo/com.example.UserService"');
    expect(buildPaginatedSelectSQL('zookeeper', 'SELECT * FROM "/dubbo/com.example.UserService"', ' ORDER BY "path" ASC', 50, 100)).toBe(
      'SELECT * FROM "/dubbo/com.example.UserService" ORDER BY "path" ASC LIMIT 50 OFFSET 100',
    );
  });

  it('round-trips multi-server connect strings through the servers parameter', () => {
    const parsed = parseUriToValues('zk://admin:secret@zk1:2181,zk2:2182,zk3/kafka?acl=auth::cdrwa', 'zookeeper');
    expect(parsed).toMatchObject({ host: 'zk1', port: 2181, user: 'admin', password: 'secret', database: 'kafka' });
    const params = new URLSearchParams(parsed?.connectionParams);
    expect(params.get('servers')).toBe('zk2:2182,zk3:2181');
    expect(params.get('acl')).toBe('auth::cdrwa');
    const uri = buildUriFromValues({ type: 'zookeeper', host: 'zk1', port: 2181, database: 'kafka', connectionParams: parsed?.connectionParams });
    expect(uri).toBe('zookeeper://zk1:2181,zk2:2182,zk3:2181/kafka?acl=auth%3A%3Acdrwa');
    // 原生写法（Kafka 等配置里常见的节点串）同样可以粘贴。
    expect(parseUriToValues('10.0.0.1:2181,10.0.0.2:2181/app', 'zookeeper')).toMatchObject({
      host: '10.0.0.1', port: 2181, database: 'app', connectionParams: 'servers=10.0.0.2%3A2181',
    });
    expect(buildUriFromValues({ type: 'zookeeper', host: '127.0.0.1', port: 2181 })).toBe('zookeeper://127.0.0.1:2181');
    expect(getConnectionParamsPlaceholder('zookeeper', 'mysql')).toContain('servers=');
  });

  it('classifies zkCli-style commands like the Go driver', () => {
    for (const statement of ['ls -R /', 'ls2 /app', 'get -s /app', 'stat /app', 'stat', 'getAcl /app', 'sync /app', 'addauth digest u:p', 'srvr', 'mntr', '4lw conf', 'config', 'version', 'SELECT * FROM "/app" LIMIT 10']) {
      expect(isReadOnlyZooKeeperCommand(statement), statement).toBe(true);
      expect(findPotentiallyMutatingConnectionStatements(zookeeper, statement), statement).toEqual([]);
    }
    for (const statement of ['create /app x', 'set /app y', 'delete /app', 'deleteall /app', 'rmr /app', 'setAcl /app world:anyone:r', 'crst', '4lw srst']) {
      expect(isReadOnlyZooKeeperCommand(statement), statement).toBe(false);
      expect(findPotentiallyMutatingConnectionStatements(zookeeper, statement), statement).toEqual([statement]);
    }
  });
});
