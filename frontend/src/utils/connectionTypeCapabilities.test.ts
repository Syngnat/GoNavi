import { describe, expect, it } from 'vitest';

import {
  isFileDatabaseType,
  isMySQLCompatibleType,
  isPostgresCompatibleSSLType,
  singleHostUriSchemesByType,
  supportsConnectionParamsForType,
  supportsSSLCAPathForType,
  supportsSSLClientCertificateForType,
  supportsSSLForType,
} from './connectionTypeCapabilities';

describe('connectionTypeCapabilities', () => {
  it('keeps single-host URI scheme aliases for URI parsing', () => {
    expect(singleHostUriSchemesByType.postgres).toEqual(['postgresql', 'postgres']);
    expect(singleHostUriSchemesByType.opengauss).toContain('jdbc:opengauss');
    expect(singleHostUriSchemesByType.gaussdb).toEqual(['gaussdb', 'postgresql', 'postgres']);
    expect(singleHostUriSchemesByType.cache).toEqual(['cache', 'intersystems-cache', 'intersystemscache']);
    expect(singleHostUriSchemesByType.trino).toEqual(['trino', 'http', 'https']);
    expect(singleHostUriSchemesByType.dameng).toEqual(['dameng', 'dm']);
    expect(singleHostUriSchemesByType.elasticsearch).toEqual(['http', 'https']);
    expect(singleHostUriSchemesByType.chroma).toEqual(['http', 'https', 'chroma']);
    expect(singleHostUriSchemesByType.qdrant).toEqual(['http', 'https', 'qdrant']);
    expect(singleHostUriSchemesByType.milvus).toEqual(['http', 'https', 'milvus']);
    expect(singleHostUriSchemesByType.iotdb).toEqual(['iotdb']);
    expect(singleHostUriSchemesByType.redis).toEqual(['redis']);
  });

  it('detects SSL-capable connection types with case-insensitive normalization', () => {
    expect(supportsSSLForType('redis')).toBe(true);
    expect(supportsSSLForType('MongoDB')).toBe(true);
    expect(supportsSSLForType('elasticsearch')).toBe(true);
    expect(supportsSSLForType('trino')).toBe(true);
    expect(supportsSSLForType('gaussdb')).toBe(true);
    expect(supportsSSLForType('greatdb')).toBe(true);
    expect(supportsSSLForType('chroma')).toBe(true);
    expect(supportsSSLForType('qdrant')).toBe(true);
    expect(supportsSSLForType('milvus')).toBe(true);
    expect(supportsSSLForType('kafka')).toBe(true);
    expect(supportsSSLForType('tdengine')).toBe(true);
    expect(supportsSSLForType('iotdb')).toBe(false);
    expect(supportsSSLForType('dameng')).toBe(true);
    expect(supportsSSLForType('sqlite')).toBe(false);
  });

  it('keeps CA path and client certificate support distinct', () => {
    expect(supportsSSLCAPathForType('dameng')).toBe(false);
    expect(supportsSSLClientCertificateForType('dameng')).toBe(true);
    expect(supportsSSLCAPathForType('gaussdb')).toBe(true);
    expect(supportsSSLClientCertificateForType('gaussdb')).toBe(true);
    expect(supportsSSLCAPathForType('sqlserver')).toBe(true);
    expect(supportsSSLCAPathForType('trino')).toBe(true);
    expect(supportsSSLClientCertificateForType('sqlserver')).toBe(false);
    expect(supportsSSLClientCertificateForType('trino')).toBe(true);
    expect(supportsSSLCAPathForType('redis')).toBe(true);
    expect(supportsSSLClientCertificateForType('redis')).toBe(true);
    expect(supportsSSLCAPathForType('chroma')).toBe(true);
    expect(supportsSSLClientCertificateForType('chroma')).toBe(false);
    expect(supportsSSLCAPathForType('qdrant')).toBe(true);
    expect(supportsSSLClientCertificateForType('qdrant')).toBe(false);
    expect(supportsSSLCAPathForType('milvus')).toBe(true);
    expect(supportsSSLClientCertificateForType('milvus')).toBe(false);
    expect(supportsSSLCAPathForType('kafka')).toBe(true);
    expect(supportsSSLClientCertificateForType('kafka')).toBe(true);
  });

  it('detects postgres-compatible SSL parameter dialects', () => {
    expect(isPostgresCompatibleSSLType('postgres')).toBe(true);
    expect(isPostgresCompatibleSSLType('kingbase')).toBe(true);
    expect(isPostgresCompatibleSSLType('gaussdb')).toBe(true);
    expect(isPostgresCompatibleSSLType('HighGo')).toBe(true);
    expect(isPostgresCompatibleSSLType('mysql')).toBe(false);
  });

  it('keeps file and MySQL-compatible database detection explicit', () => {
    expect(isFileDatabaseType('sqlite')).toBe(true);
    expect(isFileDatabaseType('duckdb')).toBe(true);
    expect(isFileDatabaseType('DuckDB')).toBe(false);
    expect(isMySQLCompatibleType('mysql')).toBe(true);
    expect(isMySQLCompatibleType('goldendb')).toBe(true);
    expect(isMySQLCompatibleType('oceanbase')).toBe(true);
    expect(isMySQLCompatibleType('diros')).toBe(true);
    expect(isMySQLCompatibleType('postgres')).toBe(false);
  });

  it('keeps advanced connection params enabled only for supported database types', () => {
    expect(supportsConnectionParamsForType('mysql')).toBe(true);
    expect(supportsConnectionParamsForType('gdb')).toBe(true);
    expect(supportsConnectionParamsForType('postgres')).toBe(true);
    expect(supportsConnectionParamsForType('gaussdb')).toBe(true);
    expect(supportsConnectionParamsForType('cache')).toBe(true);
    expect(supportsConnectionParamsForType('trino')).toBe(true);
    expect(supportsConnectionParamsForType('oracle')).toBe(true);
    expect(supportsConnectionParamsForType('mongodb')).toBe(true);
    expect(supportsConnectionParamsForType('dameng')).toBe(true);
    expect(supportsConnectionParamsForType('tdengine')).toBe(true);
    expect(supportsConnectionParamsForType('iotdb')).toBe(true);
    expect(supportsConnectionParamsForType('elasticsearch')).toBe(true);
    expect(supportsConnectionParamsForType('chroma')).toBe(true);
    expect(supportsConnectionParamsForType('qdrant')).toBe(true);
    expect(supportsConnectionParamsForType('milvus')).toBe(true);
    expect(supportsConnectionParamsForType('kafka')).toBe(true);
    expect(supportsConnectionParamsForType('redis')).toBe(false);
    expect(supportsConnectionParamsForType('sqlite')).toBe(false);
    expect(supportsConnectionParamsForType('jvm')).toBe(false);
  });
});
