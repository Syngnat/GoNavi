import { describe, expect, it } from 'vitest';

import {
  buildDatabaseDefinitionQueries,
  buildStaticDatabaseDefinition,
  extractDatabaseDefinition,
  supportsDatabaseDefinition,
} from './databaseDefinition';

describe('databaseDefinition', () => {
  it('supports database DDL for SQL and schema based dialects only', () => {
    expect(supportsDatabaseDefinition('mysql')).toBe(true);
    expect(supportsDatabaseDefinition('postgres')).toBe(true);
    expect(supportsDatabaseDefinition('timescaledb')).toBe(true);
    expect(supportsDatabaseDefinition('cockroachdb')).toBe(true);
    expect(supportsDatabaseDefinition('kwdb')).toBe(true);
    expect(supportsDatabaseDefinition('sqlserver')).toBe(true);
    expect(supportsDatabaseDefinition('trino')).toBe(true);
    expect(supportsDatabaseDefinition('tdengine')).toBe(true);
    expect(supportsDatabaseDefinition('iotdb')).toBe(true);
    expect(supportsDatabaseDefinition('oracle')).toBe(false);
    expect(supportsDatabaseDefinition('sqlite')).toBe(false);
    expect(supportsDatabaseDefinition('questdb')).toBe(false);
    expect(supportsDatabaseDefinition('influxdb')).toBe(false);
  });

  it('reads MySQL schema metadata first and keeps SHOW CREATE DATABASE as a fallback', () => {
    const mysqlQueries = buildDatabaseDefinitionQueries('mysql', 'sales`archive');
    expect(mysqlQueries[0]).toContain('FROM information_schema.SCHEMATA');
    expect(mysqlQueries[0]).toContain("WHERE SCHEMA_NAME = 'sales`archive'");
    expect(mysqlQueries[1]).toBe('SHOW CREATE DATABASE `sales``archive`');
    expect(buildDatabaseDefinitionQueries('clickhouse', 'analytics')).toEqual([
      'SHOW CREATE DATABASE `analytics`',
    ]);
    expect(buildDatabaseDefinitionQueries('tdengine', 'metrics')).toEqual([
      'SHOW CREATE DATABASE `metrics`',
    ]);
  });

  it('builds catalog queries for PostgreSQL family and SQL Server', () => {
    const postgres = buildDatabaseDefinitionQueries('postgres', "tenant's");
    expect(postgres[0]).toContain('FROM pg_database');
    expect(postgres[0]).toContain("WHERE datname = 'tenant''s'");
    expect(postgres[1]).toContain('pg_encoding_to_char(encoding) AS database_encoding');
    expect(postgres[1]).not.toContain('datcollate');

    const sqlServer = buildDatabaseDefinitionQueries('sqlserver', 'tenant');
    expect(sqlServer[0]).toContain('FROM sys.databases');
    expect(sqlServer[0]).toContain("WHERE name = 'tenant'");
  });

  it('quotes each catalog and schema part for Trino/Presto', () => {
    expect(buildDatabaseDefinitionQueries('trino', 'hive.sales')).toEqual([
      'SHOW CREATE SCHEMA "hive"."sales"',
    ]);
  });

  it('extracts common SHOW CREATE DATABASE column names case-insensitively', () => {
    expect(extractDatabaseDefinition('mysql', [{
      'Create Database': 'CREATE DATABASE `tenant` /*!40100 DEFAULT CHARACTER SET utf8mb4 */',
    }], 'tenant')).toBe(
      'CREATE DATABASE `tenant` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;',
    );
    expect(extractDatabaseDefinition('clickhouse', [{
      statement: 'CREATE DATABASE analytics ENGINE = Atomic',
    }], 'analytics')).toBe('CREATE DATABASE analytics ENGINE = Atomic;');
    expect(extractDatabaseDefinition('tdengine', [{
      'Create Database': 'CREATE DATABASE `metrics` KEEP 3650 DURATION 10 PRECISION ms',
    }], 'metrics')).toBe(
      'CREATE DATABASE `metrics` KEEP 3650 DURATION 10 PRECISION ms;',
    );
  });

  it('renders an explicit MySQL CREATE DATABASE with charset and collation', () => {
    expect(extractDatabaseDefinition('mysql', [{
      database_name: 'front_end_sys_dev',
      database_charset: 'utf8mb4',
      database_collation: 'utf8mb4_0900_ai_ci',
    }], 'front_end_sys_dev')).toBe([
      'CREATE DATABASE `front_end_sys_dev`',
      '  DEFAULT CHARACTER SET utf8mb4',
      '  COLLATE utf8mb4_0900_ai_ci;',
    ].join('\n'));
  });

  it('rebuilds a PostgreSQL CREATE DATABASE from catalog metadata', () => {
    expect(extractDatabaseDefinition('postgres', [{
      database_name: 'tenant',
      database_owner: 'gonavi',
      database_encoding: 'UTF8',
      database_collate: 'en_US.UTF-8',
      database_ctype: 'en_US.UTF-8',
      database_connection_limit: -1,
      database_is_template: false,
    }], 'tenant')).toBe([
      'CREATE DATABASE "tenant"',
      'WITH',
      '  OWNER = "gonavi"',
      "  ENCODING = 'UTF8'",
      "  LC_COLLATE = 'en_US.UTF-8'",
      "  LC_CTYPE = 'en_US.UTF-8'",
      '  TEMPLATE = template0',
      '  CONNECTION LIMIT = -1;',
    ].join('\n'));
  });

  it('builds a simple IoTDB CREATE DATABASE from the database path', () => {
    expect(buildStaticDatabaseDefinition('iotdb', 'root.gonavi_smoke')).toBe(
      'CREATE DATABASE root.gonavi_smoke;',
    );
    expect(buildStaticDatabaseDefinition('iotdb', 'root.bad-name')).toBe('');
  });

  it('rebuilds a SQL Server CREATE DATABASE with collation and containment', () => {
    expect(extractDatabaseDefinition('sqlserver', [{
      database_name: 'tenant',
      database_collation: 'Chinese_PRC_CI_AS',
      database_containment: 'PARTIAL',
    }], 'tenant')).toBe(
      'CREATE DATABASE [tenant] CONTAINMENT = PARTIAL COLLATE Chinese_PRC_CI_AS;',
    );
  });
});
