import { describe, expect, it } from 'vitest';

import { extractQueryResultTableRef } from './queryResultTable';

describe('extractQueryResultTableRef', () => {
  it('preserves Oracle schema-qualified table names for editing', () => {
    expect(extractQueryResultTableRef('SELECT * FROM MYCIMLED.EDC_LOG FETCH FIRST 500 ROWS ONLY', 'oracle', 'ANONYMOUS'))
      .toEqual({
        tableName: 'MYCIMLED.EDC_LOG',
        metadataDbName: 'MYCIMLED',
        metadataTableName: 'EDC_LOG',
        ddlDbName: 'MYCIMLED',
        ddlTableName: 'EDC_LOG',
      });
  });

  it('normalizes unquoted Oracle identifiers to their folded uppercase names', () => {
    expect(extractQueryResultTableRef('select * from mycimled.edc_log fetch first 500 rows only', 'oracle', 'anonymous'))
      .toEqual({
        tableName: 'MYCIMLED.EDC_LOG',
        metadataDbName: 'MYCIMLED',
        metadataTableName: 'EDC_LOG',
        ddlDbName: 'MYCIMLED',
        ddlTableName: 'EDC_LOG',
      });
  });

  it('preserves quoted Oracle identifier case', () => {
    expect(extractQueryResultTableRef('SELECT * FROM "mycimled"."edc_log"', 'oracle', 'ANONYMOUS'))
      .toEqual({
        tableName: 'mycimled.edc_log',
        metadataDbName: 'mycimled',
        metadataTableName: 'edc_log',
        ddlDbName: 'mycimled',
        ddlTableName: 'edc_log',
      });
  });

  it('preserves dots inside a quoted Dameng owner for result editing metadata', () => {
    expect(extractQueryResultTableRef(
      'SELECT * FROM "PEM2.4_V1_1"."COM_APPROVE_INFO"',
      'dameng',
      'PEM2.4_V1_1',
    )).toEqual({
      tableName: 'PEM2.4_V1_1.COM_APPROVE_INFO',
      metadataDbName: 'PEM2.4_V1_1',
      metadataTableName: 'COM_APPROVE_INFO',
      ddlDbName: 'PEM2.4_V1_1',
      ddlTableName: 'COM_APPROVE_INFO',
    });
  });

  it('uses current schema for unqualified Oracle tables', () => {
    expect(extractQueryResultTableRef('SELECT * FROM EDC_LOG', 'oracle', 'MYCIMLED'))
      .toEqual({
        tableName: 'EDC_LOG',
        metadataDbName: 'MYCIMLED',
        metadataTableName: 'EDC_LOG',
        ddlDbName: 'MYCIMLED',
        ddlTableName: 'EDC_LOG',
      });
  });

  it('uses the login user as Oracle default schema when the current db is a service name', () => {
    expect(extractQueryResultTableRef('SELECT * FROM per_cert_info', 'oracle', 'ORCLPDB1', 'dev'))
      .toEqual({
        tableName: 'PER_CERT_INFO',
        metadataDbName: 'DEV',
        metadataTableName: 'PER_CERT_INFO',
        ddlDbName: 'DEV',
        ddlTableName: 'PER_CERT_INFO',
      });
  });

  it('keeps existing simple table behavior for MySQL-style qualified names', () => {
    expect(extractQueryResultTableRef('SELECT * FROM app.users LIMIT 500', 'mysql', 'app'))
      .toEqual({
        tableName: 'users',
        metadataDbName: 'app',
        metadataTableName: 'users',
        ddlDbName: 'app',
        ddlTableName: 'users',
      });
  });

  it('keeps PostgreSQL-like schema-qualified table names while using the current database for metadata lookups', () => {
    expect(extractQueryResultTableRef('SELECT * FROM ldf_server.mes_work_order', 'kingbase', 'ldf_server_dbs_dev'))
      .toEqual({
        tableName: 'ldf_server.mes_work_order',
        metadataDbName: 'ldf_server_dbs_dev',
        metadataTableName: 'ldf_server.mes_work_order',
        ddlDbName: 'ldf_server_dbs_dev',
        ddlTableName: 'ldf_server.mes_work_order',
      });

    expect(extractQueryResultTableRef('SELECT * FROM ops.jobs LIMIT 20', 'postgres', 'app_db'))
      .toEqual({
        tableName: 'ops.jobs',
        metadataDbName: 'app_db',
        metadataTableName: 'ops.jobs',
        ddlDbName: 'app_db',
        ddlTableName: 'ops.jobs',
      });
  });

  it('keeps DuckDB schema-qualified table names for metadata lookups', () => {
    expect(extractQueryResultTableRef('SELECT * FROM main.events LIMIT 500', 'duckdb', 'main'))
      .toEqual({
        tableName: 'main.events',
        metadataDbName: 'main',
        metadataTableName: 'main.events',
        ddlDbName: 'main',
        ddlTableName: 'main.events',
      });
  });

  it('resolves SQL Server database and schema separately for DDL', () => {
    expect(extractQueryResultTableRef('SELECT * FROM sales.dbo.orders', 'sqlserver', 'appdb'))
      .toMatchObject({
        ddlDbName: 'sales',
        ddlTableName: 'dbo.orders',
      });
    expect(extractQueryResultTableRef('SELECT * FROM audit.orders', 'mssql', 'appdb'))
      .toMatchObject({
        ddlDbName: 'appdb',
        ddlTableName: 'audit.orders',
      });
  });

  it('uses the current or explicitly qualified database for SQL Server metadata lookups', () => {
    expect(extractQueryResultTableRef('SELECT * FROM dbo.orders', 'sqlserver', 'appdb'))
      .toMatchObject({
        metadataDbName: 'appdb',
        metadataTableName: 'dbo.orders',
        ddlDbName: 'appdb',
        ddlTableName: 'dbo.orders',
      });
    expect(extractQueryResultTableRef('SELECT * FROM sales.dbo.orders', 'sql-server', 'appdb'))
      .toMatchObject({
        metadataDbName: 'sales',
        metadataTableName: 'dbo.orders',
        ddlDbName: 'sales',
        ddlTableName: 'dbo.orders',
      });
  });

  it('resolves Trino catalog and schema namespace for DDL', () => {
    expect(extractQueryResultTableRef('SELECT * FROM hive.audit.orders', 'trino', 'lakehouse.public'))
      .toMatchObject({
        ddlDbName: 'hive.audit',
        ddlTableName: 'orders',
      });
    expect(extractQueryResultTableRef('SELECT * FROM audit.orders', 'trino', 'lakehouse.public'))
      .toMatchObject({
        ddlDbName: 'lakehouse.audit',
        ddlTableName: 'orders',
      });
    expect(extractQueryResultTableRef('SELECT * FROM orders', 'trino', 'lakehouse.public'))
      .toMatchObject({
        ddlDbName: 'lakehouse.public',
        ddlTableName: 'orders',
      });
  });

  it('preserves DuckDB catalog.schema.table targets for DDL', () => {
    expect(extractQueryResultTableRef('SELECT * FROM analytics.main.events', 'duckdb', 'main'))
      .toMatchObject({
        ddlDbName: 'main',
        ddlTableName: 'analytics.main.events',
      });
  });

  it('preserves IRIS schema-qualified table names in the DDL table parameter', () => {
    expect(extractQueryResultTableRef('SELECT * FROM app.orders', 'iris', 'USER'))
      .toMatchObject({
        ddlDbName: 'USER',
        ddlTableName: 'app.orders',
      });
  });

  it('does not mark join results as editable table refs', () => {
    expect(extractQueryResultTableRef('SELECT * FROM users u JOIN orders o ON u.id = o.user_id', 'oracle', 'APP'))
      .toBeUndefined();
    expect(extractQueryResultTableRef('SELECT * FROM users u, orders o WHERE u.id = o.user_id', 'mysql', 'app'))
      .toBeUndefined();
    expect(extractQueryResultTableRef('SELECT * FROM users u CROSS APPLY get_orders(u.id) o', 'sqlserver', 'app'))
      .toBeUndefined();
  });

  it('does not treat commas in hints or comments as additional source tables', () => {
    expect(extractQueryResultTableRef('SELECT * FROM users WITH (INDEX(ix1, ix2))', 'sqlserver', 'app'))
      .toMatchObject({ ddlDbName: 'app', ddlTableName: 'users' });
    expect(extractQueryResultTableRef('SELECT * FROM users /* owner, hot */ WHERE id = 1', 'mysql', 'app'))
      .toMatchObject({ ddlDbName: 'app', ddlTableName: 'users' });
    expect(extractQueryResultTableRef('SELECT * FROM users /* WHERE */ , orders', 'mysql', 'app'))
      .toBeUndefined();
    expect(extractQueryResultTableRef("SELECT ' FROM fake ' AS marker, id FROM users", 'mysql', 'app'))
      .toMatchObject({ ddlDbName: 'app', ddlTableName: 'users' });
  });

  it('does not mark grouped or distinct results as editable table refs', () => {
    expect(extractQueryResultTableRef('SELECT ID FROM users GROUP BY ID', 'mysql', 'app'))
      .toBeUndefined();
    expect(extractQueryResultTableRef('SELECT DISTINCT ID FROM users', 'mysql', 'app'))
      .toBeUndefined();
  });
});
