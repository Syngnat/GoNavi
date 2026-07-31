import { describe, expect, it } from 'vitest';

import {
  buildUriFromValues,
  getConnectionParamsPlaceholder,
  getUriPlaceholder,
  parseTrinoUriToValues,
  parseUriToValues,
} from './connectionModalUri';

describe('connectionModalUri trino support', () => {
  it('parses catalog and schema from a Trino URI into the database field', () => {
    expect(parseTrinoUriToValues('https://alice@127.0.0.1:8443?catalog=hive&schema=default&source=GoNavi&query_timeout=30s'))
      .toMatchObject({
        host: '127.0.0.1',
        port: 8443,
        user: 'alice',
        database: 'hive.default',
        useSSL: true,
        sslMode: 'required',
        connectionParams: 'source=GoNavi&query_timeout=30s',
      });
  });

  it('routes generic URI parsing through the Trino parser', () => {
    expect(parseUriToValues('http://alice@127.0.0.1:8080?catalog=iceberg&schema=ods', 'trino'))
      .toMatchObject({
        host: '127.0.0.1',
        port: 8080,
        user: 'alice',
        database: 'iceberg.ods',
      });
  });

  it('builds a Trino URI with catalog and schema in query parameters', () => {
    expect(buildUriFromValues({
      type: 'trino',
      host: '127.0.0.1',
      port: 8080,
      user: 'alice',
      database: 'hive.default',
      connectionParams: 'query_timeout=45s',
    })).toBe('http://alice@127.0.0.1:8080?query_timeout=45s&catalog=hive&schema=default&source=GoNavi');
  });

  it('keeps dedicated Trino placeholders concise', () => {
    expect(getUriPlaceholder('trino')).toBe('http://user@127.0.0.1:8080?catalog=hive&schema=default&source=GoNavi');
    expect(getConnectionParamsPlaceholder('trino', 'mysql')).toBe('session_properties=query_max_execution_time:30m&query_timeout=30s');
  });
});

describe('connectionModalUri Milvus support', () => {
  it('parses the REST v2 URI, database path, token, and TLS state', () => {
    expect(parseUriToValues('https://127.0.0.1:19530/default?token=secret&skip_verify=true', 'milvus'))
      .toMatchObject({
        host: '127.0.0.1',
        port: 19530,
        database: 'default',
        useSSL: true,
        sslMode: 'skip-verify',
        connectionParams: 'token=secret&skip_verify=true',
      });
  });

  it('builds an HTTP URI using the database path and token connection parameter', () => {
    expect(buildUriFromValues({
      type: 'milvus',
      host: '127.0.0.1',
      port: 19530,
      database: 'default',
      connectionParams: 'token=secret',
    })).toBe('http://127.0.0.1:19530/default?token=secret');
  });

  it('keeps Milvus URI and connection parameter placeholders aligned with REST v2', () => {
    expect(getUriPlaceholder('milvus')).toBe('http://127.0.0.1:19530/default');
    expect(getConnectionParamsPlaceholder('milvus', 'mysql')).toBe('token=...');
  });
});

describe('connectionModalUri Nacos support', () => {
  it('treats the URI path as contextPath and the namespace query as the scoped namespace', () => {
    expect(
      parseUriToValues(
        'https://alice:secret@nacos.example.test:8848/registry/api?namespaceId=dev-team&custom=value',
        'nacos',
      ),
    ).toMatchObject({
      host: 'nacos.example.test',
      port: 8848,
      user: 'alice',
      password: 'secret',
      useSSL: true,
      sslMode: 'required',
      nacosNamespaceId: 'dev-team',
      connectionParams: 'custom=value&contextPath=%2Fregistry%2Fapi',
    });
    expect(
      parseUriToValues(
        'https://alice:secret@nacos.example.test:8848/registry/api?namespaceId=dev-team&custom=value',
        'nacos',
      ),
    ).not.toHaveProperty('database');
  });

  it('builds a Nacos URI from contextPath and the dedicated namespace field', () => {
    expect(
      buildUriFromValues({
        type: 'nacos',
        host: 'nacos.example.test',
        port: 8848,
        user: 'alice',
        password: 'secret',
        useSSL: true,
        sslMode: 'required',
        nacosNamespaceId: 'public',
        connectionParams: 'contextPath=/registry/api&custom=value',
      }),
    ).toBe(
      'https://alice:secret@nacos.example.test:8848/registry/api?custom=value&namespaceId=public',
    );
  });

  it('falls back to a stored scope when the dedicated URI field is undefined', () => {
    expect(
      buildUriFromValues({
        type: 'nacos',
        host: 'nacos.example.test',
        port: 8848,
        nacosNamespaceId: undefined,
        connectionParams: 'contextPath=/nacos&namespaceId=dev',
      }),
    ).toBe('http://nacos.example.test:8848/nacos?namespaceId=dev');
  });

  it('preserves an explicit root context path through a Nacos URI round trip', () => {
    const uri = buildUriFromValues({
      type: 'nacos',
      host: 'nacos.example.test',
      port: 8848,
      nacosNamespaceId: 'public',
      connectionParams: 'contextPath=/',
    });

    expect(uri).toBe(
      'http://nacos.example.test:8848/?namespaceId=public',
    );
    expect(parseUriToValues(uri, 'nacos')).toMatchObject({
      nacosNamespaceId: 'public',
      connectionParams: 'contextPath=%2F',
    });
  });

  it('uses Nacos-specific URI and advanced parameter placeholders', () => {
    expect(getUriPlaceholder('nacos')).toBe(
      'http://nacos:nacos@127.0.0.1:8848/nacos?namespaceId=dev',
    );
    expect(getConnectionParamsPlaceholder('nacos', 'mysql')).toBe(
      'contextPath=/nacos',
    );
  });
});
