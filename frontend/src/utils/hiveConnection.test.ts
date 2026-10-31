import { describe, expect, it } from 'vitest';
import {
  buildHiveUri, getHiveDefaultPort, hiveAuth, normalizeHiveConnectionParams,
  parseHiveUri, readHiveParams, updateHiveParam,
} from './hiveConnection';
import { buildUriFromValues, parseUriToValues } from '../components/connectionModal/connectionModalUri';
import { buildSavedConnectionInput, createEmptyConnectionSecretClearState } from '../components/connectionModal/connectionModalSavedInput';
import { buildConnectionConfig } from '../components/connectionModal/connectionModalConfig';

describe('Hive connection parameters and JDBC URLs', () => {
  it('accepts JDBC semicolon properties, decodes credentials and normalizes auth aliases', () => {
    const values = parseUriToValues('jdbc:hive2://warehouse:10000/analytics;user=alice;password=p%3B%26%2B%25;auth=LDAP;session.hive.exec.dynamic.partition=true', 'hive');
    expect(values).toMatchObject({ host: 'warehouse', port: 10000, database: 'analytics', user: 'alice', password: 'p;&+%' });
    const params = readHiveParams(values?.connectionParams);
    expect(params.get('authMode')).toBe('LDAP');
    expect(params.get('session.hive.exec.dynamic.partition')).toBe('true');
    expect(params.has('auth')).toBe(false);
    expect(params.has('password')).toBe(false);
    expect(params.has('user')).toBe(false);
  });

  it.each([
    ['hive', 'binary', 10000], ['hive', 'http', 10001], ['spark', 'binary', 10000], ['spark', 'http', 10001], ['impala', 'binary', 21050], ['impala', 'http', 28000],
  ] as const)('uses the %s/%s default port', (family, transport, port) => {
    expect(getHiveDefaultPort(family, transport)).toBe(port);
    const values = parseHiveUri('jdbc:hive2://warehouse/default;hiveFamily=' + family + ';transportMode=' + transport);
    expect(values?.port).toBe(port);
  });

  it('supports HTTP endpoint paths and database parameters independently', () => {
    const values = parseHiveUri('https://alice:secret@warehouse/gateway/hs2?database=analytics&authMode=LDAP');
    expect(values).toMatchObject({ port: 443, database: 'analytics', user: 'alice', password: 'secret', useSSL: true });
    expect(readHiveParams(values?.connectionParams).get('httpPath')).toBe('gateway/hs2');
    expect(readHiveParams(values?.connectionParams).get('transportMode')).toBe('http');
    expect(parseHiveUri('http://warehouse/cliservice')?.port).toBe(80);
  });

  it('roundtrips IPv6, TLS, Kerberos and escaped JDBC properties without adding config fields', () => {
    const source = { type: 'hive', host: '2001:db8::8', port: 10001, database: 'sales data', user: 'analyst@EXAMPLE.COM', password: 'p;?#+&', useSSL: true, sslMode: 'skip-verify' as const,
      connectionParams: 'hiveFamily=spark&transportMode=http&authMode=KERBEROS&principal=HTTP%2F_HOST%40EXAMPLE.COM&krb5Config=C%3A%5Cconf%5Ckrb5.ini&session.hive.exec.mode.local.auto=true' };
    const uri = buildUriFromValues(source);
    expect(uri).toBe(buildHiveUri(source));
    expect(uri).toContain('jdbc:hive2://[2001:db8::8]:10001/');
    expect(parseHiveUri(uri)).toMatchObject({ host: source.host, port: source.port, database: source.database, user: source.user, password: source.password, useSSL: true, sslMode: 'skip-verify' });
    const params = readHiveParams(parseHiveUri(uri)?.connectionParams);
    expect(params.get('principal')).toBe('HTTP/_HOST@EXAMPLE.COM');
    expect(params.get('krb5Config')).toBe('C:\\conf\\krb5.ini');
    expect(params.has('password')).toBe(false);
  });

  it.each(['jdbc:hive2://', 'jdbc:hive2://one,two/default', 'jdbc:hive2://host:70000/default', 'jdbc:hive2://host/default;bad',
    'jdbc:hive2://host/%GG', 'jdbc:hive2://host/default;authMode=UNKNOWN', 'jdbc:hive2://host/default;transportMode=udp',
    'jdbc:hive2://host/default;saslQop=auth-conf', 'jdbc:hive2://host/default#variables', 'https://host/path#fragment'])('rejects unsafe or unsupported URL %s', uri => {
    expect(parseHiveUri(uri)).toBeNull();
  });

  it('does not silently downgrade invalid manual authentication/transport options', () => {
    for (const input of ['authMode=UNKNOWN', 'authMode=KERBEROS&saslQop=auth-conf', 'transportMode=udp', 'hiveFamily=unknown']) {
      expect(() => normalizeHiveConnectionParams(input)).toThrow();
      expect(() => buildHiveUri({ connectionParams: input })).toThrow();
    }
  });

  it('uses family/transport defaults when saving form settings without a port', async () => {
    const config = await buildConnectionConfig({ values: { type: 'hive', host: 'warehouse', port: 0, user: '', connectionParams: 'hiveFamily=impala&transportMode=http' }, forPersist: true, translate: key => key });
    expect(config.port).toBe(28000);
    expect(config.uri).toContain('warehouse:28000');
  });

  it('honors do-not-save-password for Hive without removing the test-session credential', async () => {
    const values = { type: 'hive', host: 'warehouse', port: 10000, user: 'alice', password: 'private-secret', savePassword: false, database: 'default', connectionParams: 'authMode=LDAP' };
    const transient = await buildConnectionConfig({ values, forPersist: false, translate: key => key });
    expect(transient.password).toBe('private-secret');
    const persisted = await buildConnectionConfig({ values, forPersist: true, translate: key => key });
    expect(persisted.password).toBe('');
    expect(persisted.savePassword).toBe(false);
    expect(persisted.uri).not.toContain('private-secret');
    const saved = buildSavedConnectionInput({ config: persisted, values, initialValues: { id: 'hive', name: 'Hive', config: persisted, hasPrimaryPassword: true }, clearSecrets: createEmptyConnectionSecretClearState() });
    expect(saved.config.password).toBe('');
    expect(saved.clearPrimaryPassword).toBe(true);
  });

  it('preserves unrelated parameters and canonicalizes authMode before secret-store persistence', async () => {
    const input = updateHiveParam('session.custom=a%26b&auth=NOSASL', 'httpPath', 'gateway/hs2');
    const canonical = normalizeHiveConnectionParams(input);
    expect(readHiveParams(canonical).get('session.custom')).toBe('a&b');
    expect(readHiveParams(canonical).get('authMode')).toBe('NOSASL');
    expect(readHiveParams(canonical).has('auth')).toBe(false);
    expect(hiveAuth(readHiveParams('principal=hive%2F_HOST%40EXAMPLE.COM'))).toBe('KERBEROS');
    const config = await buildConnectionConfig({ values: { type: 'hive', host: 'warehouse', port: 10000, user: '', password: '', database: 'default', connectionParams: canonical, timeout: 30, useSSL: false, uri: 'jdbc:hive2://old/default;auth=NONE' }, forPersist: true, translate: key => key });
    expect(config.uri).toContain('warehouse:10000');
    expect(config.uri).toContain('authMode=NOSASL');
    expect(readHiveParams(config.connectionParams).has('auth')).toBe(false);
    expect(Object.keys(config).some(key => key.startsWith('hive'))).toBe(false);
  });
});
