import { describe, expect, it } from 'vitest';

import { connection } from '../../wailsjs/go/models';
import { buildRpcConnectionConfig } from './connectionRpcConfig';
import { describeUnsupportedOceanBaseProtocol } from './oceanBaseProtocol';

describe('buildRpcConnectionConfig', () => {
  it('preserves the saved connection id while normalizing numeric fields', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-1',
      type: 'postgres',
      host: 'db.local',
      port: '5432' as unknown as number,
      user: 'postgres',
      keepAliveEnabled: true,
      keepAliveIntervalMinutes: 15,
      keepAliveSQL: 'SELECT 1',
      useSSH: true,
      ssh: {
        host: 'bastion.local',
        port: '2222' as unknown as number,
        user: 'ops',
      },
      useProxy: true,
      proxy: {
        type: 'http',
        host: '127.0.0.1',
        port: '8080' as unknown as number,
      },
    } as any, {
      id: 'conn-2',
      timeout: '120' as unknown as number,
      redisDB: '6' as unknown as number,
      database: 'app',
    });

    expect(result.id).toBe('conn-1');
    expect(result.port).toBe(5432);
    expect(result.ssh?.port).toBe(2222);
    expect(result.proxy?.port).toBe(8080);
    expect(result.timeout).toBe(120);
    expect(result.queryTimeout).toBeUndefined();
    expect(result.redisDB).toBe(6);
    expect(result.database).toBe('app');
    expect(result.keepAliveEnabled).toBe(true);
    expect(result.keepAliveIntervalMinutes).toBe(15);
    expect(result.keepAliveSQL).toBe('SELECT 1');
  });

  it('preserves a per-request query timeout override separately from connection timeout', () => {
    const result = buildRpcConnectionConfig({
      type: 'mysql',
      host: 'db.local',
      port: 3306,
      user: 'root',
      timeout: 30,
    } as any, {
      timeout: 5,
      queryTimeout: 5,
    });

    expect(result.timeout).toBe(5);
    expect(result.queryTimeout).toBe(5);
  });

  it('preserves ClickHouse protocol override for RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-clickhouse',
      type: 'clickhouse',
      host: 'clickhouse.local',
      port: 8125,
      user: 'default',
      clickHouseProtocol: 'http',
    } as any);

    expect(result.clickHouseProtocol).toBe('http');
  });

  it('injects OceanBase protocol override into RPC connection params', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-oceanbase-oracle',
      type: 'oceanbase',
      host: 'ob.local',
      port: 2881,
      user: 'sys@oracle001',
      database: 'ORCL',
      oceanBaseProtocol: 'oracle',
    } as any);

    expect(result.connectionParams).toBe('protocol=oracle');
    expect((result as any).oceanBaseProtocol).toBeUndefined();
  });

  it('keeps OceanBase URI protocol when no form override exists', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-oceanbase-uri',
      type: 'oceanbase',
      host: 'ob.local',
      port: 2881,
      user: 'sys@oracle001',
      database: 'ORCL',
      uri: 'oceanbase://sys%40oracle001:pass@ob.local:2881/ORCL?protocol=oracle',
    } as any);

    expect(result.connectionParams).toBe('protocol=oracle');
  });

  it('lets OceanBase form protocol override legacy connection param aliases', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-oceanbase-mysql',
      type: 'oceanbase',
      host: 'ob.local',
      port: 2881,
      user: 'root@test',
      database: 'app',
      oceanBaseProtocol: 'mysql',
      connectionParams: 'tenantMode=oracle&connectTimeout=10',
    } as any);

    expect(result.connectionParams).toBe('connectTimeout=10&protocol=mysql');
  });

  it('keeps OceanBase protocol query key ahead of compatibility aliases', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-oceanbase-conflict',
      type: 'oceanbase',
      host: 'ob.local',
      port: 2881,
      user: 'root@test',
      database: 'app',
      connectionParams: 'protocol=mysql&tenantMode=oracle',
    } as any);

    expect(result.connectionParams).toBe('protocol=mysql');
  });

  it('rejects unsupported OceanBase native protocol instead of falling back to MySQL', () => {
    expect(() => buildRpcConnectionConfig({
      id: 'conn-oceanbase-native',
      type: 'oceanbase',
      host: 'ob.local',
      port: 2881,
      user: 'root@test',
      database: 'app',
      connectionParams: 'protocol=native',
    } as any)).toThrow('OceanBase only supports MySQL/Oracle tenant protocols; "native" is not supported. Switch to MySQL or Oracle.');
  });

  it('rejects unsupported OceanBase protocol even when form protocol is explicit MySQL', () => {
    expect(() => buildRpcConnectionConfig({
      id: 'conn-oceanbase-native-masked',
      type: 'oceanbase',
      host: 'ob.local',
      port: 2881,
      user: 'root@test',
      database: 'app',
      oceanBaseProtocol: 'mysql',
      connectionParams: 'protocol=native',
    } as any)).toThrow('OceanBase only supports MySQL/Oracle tenant protocols; "native" is not supported. Switch to MySQL or Oracle.');
  });

  it('localizes unsupported OceanBase protocol wrappers while preserving the raw protocol value', () => {
    expect(describeUnsupportedOceanBaseProtocol('native', (key, params) => (
      `${key}:${params?.value}`
    ))).toBe('connection.oceanbase.error.unsupported_protocol:native');
  });

  it('preserves extra connection params for RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-mysql',
      type: 'mysql',
      host: 'db.local',
      port: 3306,
      user: 'root',
      connectionParams: 'characterEncoding=utf8&useSSL=false',
    } as any);

    expect(result.connectionParams).toBe('characterEncoding=utf8&useSSL=false');
  });

  it('preserves SSL certificate path fields for RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-postgres-ssl',
      type: 'postgres',
      host: 'db.local',
      port: 5432,
      user: 'postgres',
      useSSL: true,
      sslMode: 'required',
      sslCAPath: 'C:/certs/ca.pem',
      sslCertPath: 'C:/certs/client-cert.pem',
      sslKeyPath: 'C:/certs/client-key.pem',
    } as any);

    expect(result.useSSL).toBe(true);
    expect(result.sslMode).toBe('required');
    expect(result.sslCAPath).toBe('C:/certs/ca.pem');
    expect(result.sslCertPath).toBe('C:/certs/client-cert.pem');
    expect(result.sslKeyPath).toBe('C:/certs/client-key.pem');
  });

  it('preserves the connection-level readOnly guard flag for RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-prod',
      type: 'postgres',
      host: 'db.local',
      port: 5432,
      user: 'postgres',
      readOnly: true,
    } as any);

    expect(result.readOnly).toBe(true);
    expect(result.protection).toEqual({
      restrictDataEdit: true,
      restrictStructureEdit: true,
      restrictScriptExecution: true,
      restrictDataImport: true,
    });
  });

  it('preserves partial connection protection for RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-prod-partial',
      type: 'postgres',
      protection: {
        restrictDataEdit: true,
        restrictDataImport: true,
      },
    } as any);

    expect(result.readOnly).toBe(false);
    expect(result.protection).toEqual({
      restrictDataEdit: true,
      restrictStructureEdit: false,
      restrictScriptExecution: false,
      restrictDataImport: true,
    });
  });

  it('preserves Nacos legacy readOnly for backend mutation guards', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-nacos-readonly',
      type: 'nacos',
      host: 'nacos.local',
      port: 8848,
      readOnly: true,
    } as any);

    expect(result.readOnly).toBe(true);
  });

  it('preserves explicit Nacos protection flags for backend mutation guards', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-nacos-protected',
      type: 'nacos',
      host: 'nacos.local',
      port: 8848,
      protection: {
        restrictDataEdit: true,
        restrictStructureEdit: true,
        restrictDataImport: true,
      },
    } as any);

    expect(result.readOnly).toBe(false);
    expect(result.protection).toEqual({
      restrictDataEdit: true,
      restrictStructureEdit: true,
      restrictScriptExecution: false,
      restrictDataImport: true,
    });
  });

  it('ignores the legacy readOnly flag for unsupported connection types', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-redis-readonly',
      type: 'redis',
      readOnly: true,
    } as any);

    expect(result.readOnly).toBe(false);
    expect(result.protection).toEqual({
      restrictDataEdit: false,
      restrictStructureEdit: false,
      restrictScriptExecution: false,
      restrictDataImport: false,
    });
  });

  it('fills default nested config blocks needed by RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-redis',
      type: 'redis',
      host: '127.0.0.1',
      port: 6379,
      user: '',
    } as any, {
      useSSH: true,
      useHttpTunnel: true,
      redisDB: '4' as unknown as number,
    });

    expect(result.id).toBe('conn-redis');
    expect(result.redisDB).toBe(4);
    expect(result.ssh).toEqual({
      host: '',
      port: 22,
      user: '',
      password: '',
      keyPath: '',
      knownHostsPath: '',
      hostKeyFingerprint: '',
    });
    expect(result.httpTunnel).toEqual({
      host: '',
      port: 8080,
      user: '',
      password: '',
    });
  });

  it('preserves Redis cluster and Sentinel topology fields for RPC calls', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-redis-sentinel',
      type: 'redis',
      host: 'sentinel-a.local',
      port: '26379' as unknown as number,
      hosts: ['sentinel-b.local:26379', 'sentinel-c.local:26379'],
      topology: 'sentinel',
      user: 'default',
      password: 'redis-secret',
      redisSentinelMaster: 'mymaster',
      redisSentinelUser: 'sentinel-user',
      redisSentinelPassword: 'sentinel-secret',
      redisDB: '3' as unknown as number,
    } as any);

    expect(result.topology).toBe('sentinel');
    expect(result.hosts).toEqual(['sentinel-b.local:26379', 'sentinel-c.local:26379']);
    expect(result.redisSentinelMaster).toBe('mymaster');
    expect(result.redisSentinelUser).toBe('sentinel-user');
    expect(result.redisSentinelPassword).toBe('sentinel-secret');
    expect(result.redisDB).toBe(3);
  });

  it('returns a Wails connection model instance for RPC compatibility', () => {
    const result = buildRpcConnectionConfig({
      id: 'conn-model',
      type: 'mysql',
      host: '127.0.0.1',
      port: '3306' as unknown as number,
      user: 'root',
      useSSH: true,
      ssh: {
        host: 'jump.local',
        port: '2222' as unknown as number,
        user: 'ops',
        knownHostsPath: '/tmp/known_hosts',
        hostKeyFingerprint: 'SHA256:pin',
      },
      useProxy: true,
      proxy: {
        type: 'http',
        host: '127.0.0.1',
        port: '8080' as unknown as number,
      },
      useHttpTunnel: true,
      httpTunnel: {
        host: '127.0.0.1',
        port: '9000' as unknown as number,
      },
    } as any);

    expect(result).toBeInstanceOf(connection.ConnectionConfig);
    expect(result.ssh).toBeInstanceOf(connection.SSHConfig);
    expect(result.ssh?.knownHostsPath).toBe('/tmp/known_hosts');
    expect(result.ssh?.hostKeyFingerprint).toBe('SHA256:pin');
    expect(result.proxy).toBeInstanceOf(connection.ProxyConfig);
    expect(result.httpTunnel).toBeInstanceOf(connection.HTTPTunnelConfig);
    expect(typeof (result as any).convertValues).toBe('function');
  });
});
