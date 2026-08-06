import { describe, expect, it } from 'vitest';

import {
  buildUriFromValues,
  extractOracleSIDParam,
  getConnectionParamsPlaceholder,
  getUriPlaceholder,
  parseTrinoUriToValues,
  parseUriToValues,
  resolveOracleConnectionTarget,
  withOracleSIDParam,
  withoutOracleSIDFromURI,
  withoutOracleSIDParam,
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

describe('connectionModalUri Oracle SID support', () => {
  it('resolves SID using the same URI then connection-params precedence as the backend', () => {
    expect(resolveOracleConnectionTarget('SID=FROM_URI')).toEqual({
      mode: 'sid',
      sid: 'FROM_URI',
    });
    expect(
      resolveOracleConnectionTarget(
        'SID=FROM_URI',
        'DBA_PRIVILEGE=SYSDBA',
      ),
    ).toEqual({ mode: 'sid', sid: 'FROM_URI' });
    expect(
      resolveOracleConnectionTarget('SID=FROM_URI', 'sid=FROM_PARAMS'),
    ).toEqual({ mode: 'sid', sid: 'FROM_PARAMS' });
    expect(resolveOracleConnectionTarget('SID=FROM_URI', 'SID=')).toEqual({
      mode: 'service',
      sid: '',
    });
  });

  it('parses SID-only Oracle URIs and lets SID override a legacy path', () => {
    expect(
      parseUriToValues(
        'oracle://system:secret@db.example.test:1521?SID=ORCL',
        'oracle',
      ),
    ).toMatchObject({
      host: 'db.example.test',
      port: 1521,
      database: 'ORCL',
      oracleMode: 'sid',
      connectionParams: 'SID=ORCL',
    });
    expect(
      parseUriToValues(
        'oracle://system:secret@db.example.test:1521/OLD_SERVICE?SID=ORCL',
        'oracle',
      ),
    ).toMatchObject({ database: 'ORCL', oracleMode: 'sid' });
    expect(
      parseUriToValues(
        'oracle://system:secret@db.example.test:1521/ORCLPDB1',
        'oracle',
      ),
    ).toMatchObject({ database: 'ORCLPDB1', oracleMode: 'service' });
    expect(
      parseUriToValues('oracle://system:secret@db.example.test:1521', 'oracle'),
    ).toBeNull();
  });

  it('generates Oracle URIs according to the selected connection mode', () => {
    const sidUri = new URL(
      buildUriFromValues({
        type: 'oracle',
        host: 'db.example.test',
        port: 1521,
        user: 'system',
        password: 'secret',
        database: 'ORCL',
        oracleMode: 'sid',
        connectionParams: 'DBA_PRIVILEGE=SYSDBA&sid=OLD',
        useSSL: false,
      }),
    );
    expect(sidUri.pathname).toBe('');
    expect(sidUri.searchParams.get('SID')).toBe('ORCL');
    expect(sidUri.searchParams.get('DBA_PRIVILEGE')).toBe('SYSDBA');

    const serviceUri = new URL(
      buildUriFromValues({
        type: 'oracle',
        host: 'db.example.test',
        port: 1521,
        user: 'system',
        password: 'secret',
        database: 'ORCLPDB1',
        oracleMode: 'service',
        connectionParams: 'SID=ORCL&DBA_PRIVILEGE=SYSDBA',
        useSSL: false,
      }),
    );
    expect(serviceUri.pathname).toBe('/ORCLPDB1');
    expect(serviceUri.searchParams.has('SID')).toBe(false);
    expect(serviceUri.searchParams.get('DBA_PRIVILEGE')).toBe('SYSDBA');
  });

  it('keeps SID mode through an Oracle URI parse and generate round trip', () => {
    const parsed = parseUriToValues(
      'oracle://system:secret@db.example.test:1521?SID=ORCL&DBA_PRIVILEGE=SYSDBA',
      'oracle',
    );
    expect(parsed).not.toBeNull();

    const rebuilt = buildUriFromValues({ type: 'oracle', ...parsed });
    const reparsed = parseUriToValues(rebuilt, 'oracle');
    expect(reparsed).toMatchObject({
      database: 'ORCL',
      oracleMode: 'sid',
    });
    expect(new URL(rebuilt).pathname).toBe('');
  });

  it('extracts SID case-insensitively from connection params text', () => {
    expect(extractOracleSIDParam('')).toBe('');
    expect(extractOracleSIDParam('DBA_PRIVILEGE=SYSDBA')).toBe('');
    expect(extractOracleSIDParam('SID=ORCL')).toBe('ORCL');
    expect(extractOracleSIDParam('sid=orcl&SERVICE_NAME=svc')).toBe('orcl');
    expect(extractOracleSIDParam('PREFETCH_ROWS=50&SID=ORCLPDB')).toBe('ORCLPDB');
    expect(extractOracleSIDParam('?SID=ORCL')).toBe('ORCL');
    expect(extractOracleSIDParam(undefined)).toBe('');
  });

  it('withOracleSIDParam sets a new SID while preserving other params', () => {
    expect(withOracleSIDParam('', 'ORCL')).toBe('SID=ORCL');
    expect(withOracleSIDParam('DBA_PRIVILEGE=SYSDBA', 'ORCL')).toBe(
      'DBA_PRIVILEGE=SYSDBA&SID=ORCL',
    );
    expect(withOracleSIDParam('SID=OLD', 'ORCL')).toBe('SID=ORCL');
    expect(withOracleSIDParam('SID=OLD&sid=OTHER', 'ORCL')).toBe('SID=ORCL');
    expect(withOracleSIDParam('sid=old&TRACE FILE=/tmp/x', 'ORCL')).toBe(
      'SID=ORCL&TRACE+FILE=%2Ftmp%2Fx',
    );
    expect(withOracleSIDParam('SID=OLD', '')).toBe('');
  });

  it('withoutOracleSIDParam removes SID while preserving other params', () => {
    expect(withoutOracleSIDParam('')).toBe('');
    expect(withoutOracleSIDParam('SID=ORCL')).toBe('');
    expect(withoutOracleSIDParam('sid=orcl&DBA_PRIVILEGE=SYSDBA')).toBe(
      'DBA_PRIVILEGE=SYSDBA',
    );
    expect(withoutOracleSIDParam('DBA_PRIVILEGE=SYSDBA')).toBe(
      'DBA_PRIVILEGE=SYSDBA',
    );
  });

  it('withoutOracleSIDFromURI strips SID from a connection URI query', () => {
    expect(withoutOracleSIDFromURI('')).toBe('');
    expect(withoutOracleSIDFromURI('oracle://u:p@h:1521/ORCL')).toBe(
      'oracle://u:p@h:1521/ORCL',
    );
    expect(withoutOracleSIDFromURI('oracle://u:p@h:1521/?SID=ORCL')).toBe(
      'oracle://u:p@h:1521/',
    );
    expect(
      withoutOracleSIDFromURI('oracle://u:p@h:1521/?sid=orcl&DBA_PRIVILEGE=SYSDBA'),
    ).toBe('oracle://u:p@h:1521/?DBA_PRIVILEGE=SYSDBA');
    expect(
      withoutOracleSIDFromURI('oracle://u:p@h:1521/?DBA_PRIVILEGE=SYSDBA&SID=ORCL&TRACE=1'),
    ).toBe('oracle://u:p@h:1521/?DBA_PRIVILEGE=SYSDBA&TRACE=1');
    expect(
      withoutOracleSIDFromURI('oracle://u:p@h:1521/?SID=ORCL#frag'),
    ).toBe('oracle://u:p@h:1521/#frag');
    expect(
      withoutOracleSIDFromURI(
        'oracle://u:p@h:1521/ORCLPDB1?S%49D=ORCL&TRACE=1',
      ),
    ).toBe('oracle://u:p@h:1521/ORCLPDB1?TRACE=1');
  });
});
