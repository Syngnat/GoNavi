import { describe, expect, it } from 'vitest';

import {
  DATA_SOURCE_CAPABILITY_OPERATIONS,
  getDataSourceCapabilities,
  getDataSourceCapabilityContract,
  getDataSourceOperationCapability,
  shouldShowOceanBaseRowNumberColumn,
} from './dataSourceCapabilities';

describe('dataSourceCapabilities', () => {
  it('treats Oracle table preview totals as manual exact count plus approximate metadata count', () => {
    expect(getDataSourceCapabilities({ type: 'oracle' })).toMatchObject({
      type: 'oracle',
      preferManualTotalCount: true,
      supportsApproximateTableCount: true,
      supportsApproximateTotalPages: false,
    });
  });

  it('keeps DuckDB manual count and approximate total support', () => {
    expect(getDataSourceCapabilities({ type: 'duckdb' })).toMatchObject({
      type: 'duckdb',
      preferManualTotalCount: true,
      supportsApproximateTableCount: true,
      supportsApproximateTotalPages: true,
    });
  });

  it('keeps MySQL on automatic total count mode', () => {
    expect(getDataSourceCapabilities({ type: 'mysql' })).toMatchObject({
      type: 'mysql',
      supportsExplainDiagnosis: true,
      preferManualTotalCount: false,
      supportsApproximateTableCount: false,
      supportsApproximateTotalPages: false,
    });
  });

  it('enables create-database charset options only for MySQL-family dialects', () => {
    expect(getDataSourceCapabilities({ type: 'mysql' }).supportsCreateDatabaseCharset).toBe(true);
    expect(getDataSourceCapabilities({ type: 'goldendb' }).supportsCreateDatabaseCharset).toBe(true);
    expect(getDataSourceCapabilities({ type: 'mariadb' }).supportsCreateDatabaseCharset).toBe(true);
    expect(getDataSourceCapabilities({ type: 'oceanbase', oceanBaseProtocol: 'mysql' }).supportsCreateDatabaseCharset).toBe(true);
    expect(getDataSourceCapabilities({ type: 'diros' }).supportsCreateDatabaseCharset).toBe(true);
    expect(getDataSourceCapabilities({ type: 'postgres' }).supportsCreateDatabaseCharset).toBe(false);
    expect(getDataSourceCapabilities({ type: 'sqlserver' }).supportsCreateDatabaseCharset).toBe(false);
    expect(getDataSourceCapabilities({ type: 'clickhouse' }).supportsCreateDatabaseCharset).toBe(false);
    expect(getDataSourceCapabilities({ type: 'starrocks' }).supportsCreateDatabaseCharset).toBe(false);
  });

  it('uses ClickHouse capabilities for a custom ClickHouse JDBC connection', () => {
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'clickhouse' })).toMatchObject({
      type: 'clickhouse',
      supportsQueryEditor: true,
      supportsExplainDiagnosis: true,
      supportsSqlQueryExport: true,
      supportsCopyTable: false,
      supportsCreateDatabase: true,
      supportsDropDatabase: true,
      forceReadOnlyQueryResult: true,
    });
  });

  it('only enables whole-table copy for backend-supported SQL families', () => {
    [
      { type: 'mysql' },
      { type: 'goldendb' },
      { type: 'mariadb' },
      { type: 'oceanbase', oceanBaseProtocol: 'mysql' as const },
      { type: 'postgresql' },
    ].forEach((config) => {
      expect(getDataSourceCapabilities(config).supportsCopyTable, JSON.stringify(config)).toBe(true);
    });

    [
      { type: 'oceanbase', oceanBaseProtocol: 'oracle' as const },
      { type: 'custom', driver: 'mysql' },
      { type: 'custom', driver: 'greatdb' },
      { type: 'custom', driver: 'pgx' },
      { type: 'custom', driver: 'oceanbase', oceanBaseProtocol: 'mysql' as const },
      { type: 'custom', driver: 'doris' },
      { type: 'starrocks' },
      { type: 'kingbase8' },
      { type: 'highgo' },
      { type: 'vastbase' },
      { type: 'custom', driver: 'open-gauss' },
      { type: 'custom', driver: 'gauss-db' },
      { type: 'sqlite' },
      { type: 'duckdb' },
      { type: 'sqlserver' },
      { type: 'oracle' },
      { type: 'clickhouse' },
      { type: 'mongodb' },
      { type: 'redis' },
    ].forEach((config) => {
      expect(getDataSourceCapabilities(config).supportsCopyTable, JSON.stringify(config)).toBe(false);
    });
  });

  it('blocks whole-table copy when data import or structure editing is protected', () => {
    expect(getDataSourceCapabilities({
      type: 'postgres',
      protection: { restrictDataImport: true },
    }).supportsCopyTable).toBe(false);
    expect(getDataSourceCapabilities({
      type: 'postgres',
      protection: { restrictStructureEdit: true },
    }).supportsCopyTable).toBe(false);
    expect(getDataSourceCapabilities({ type: 'postgres', readOnly: true }).supportsCopyTable).toBe(false);
  });

  it('keeps whole-table copy available when only row editing is protected', () => {
    expect(getDataSourceCapabilities({
      type: 'postgres',
      protection: { restrictDataEdit: true },
    }).supportsCopyTable).toBe(true);
  });

  it('only enables execution-plan diagnosis for backend-supported SQL dialects', () => {
    expect(getDataSourceCapabilities({ type: 'goldendb' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'greatdb' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'postgresql' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'pgx' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'doris' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'mssql' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'kingbase8' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'sqlite3' }).supportsExplainDiagnosis).toBe(true);
    expect(getDataSourceCapabilities({ type: 'mongodb' }).supportsExplainDiagnosis).toBe(false);
    expect(getDataSourceCapabilities({ type: 'redis' }).supportsExplainDiagnosis).toBe(false);
    expect(getDataSourceCapabilities({ type: 'trino' }).supportsExplainDiagnosis).toBe(false);
  });

  it('treats GoldenDB as an editable MySQL-family datasource with database-level DDL actions', () => {
    expect(getDataSourceCapabilities({ type: 'goldendb' })).toMatchObject({
      type: 'goldendb',
      supportsQueryEditor: true,
      supportsSqlQueryExport: true,
      supportsCopyInsert: true,
      supportsCreateDatabase: true,
      supportsRenameDatabase: false,
      supportsDropDatabase: true,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'greatdb' })).toMatchObject({
      type: 'goldendb',
      supportsQueryEditor: true,
      supportsCopyInsert: true,
    });
  });

  it('keeps StarRocks as an independent SQL datasource capability', () => {
    expect(getDataSourceCapabilities({ type: 'starrocks' })).toMatchObject({
      type: 'starrocks',
      supportsQueryEditor: true,
      supportsSqlQueryExport: true,
      supportsCopyInsert: true,
      preferManualTotalCount: false,
    });
  });

  it('treats Trino as an editable SQL datasource without database-level DDL shortcuts', () => {
    expect(getDataSourceCapabilities({ type: 'trino' })).toMatchObject({
      type: 'trino',
      supportsQueryEditor: true,
      supportsSqlQueryExport: true,
      supportsCopyInsert: true,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
    });
  });

  it('keeps InterSystems IRIS as an editable SQL datasource capability', () => {
    expect(getDataSourceCapabilities({ type: 'iris' })).toMatchObject({
      type: 'iris',
      supportsQueryEditor: true,
      supportsSqlQueryExport: true,
      supportsCopyInsert: true,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'intersystemsiris' })).toMatchObject({
      type: 'iris',
      supportsQueryEditor: true,
    });
  });

  it('treats GaussDB as an editable PostgreSQL-family datasource with database-level DDL actions', () => {
    expect(getDataSourceCapabilities({ type: 'gaussdb' })).toMatchObject({
      type: 'gaussdb',
      supportsQueryEditor: true,
      supportsSqlQueryExport: true,
      supportsCopyInsert: true,
      supportsCreateDatabase: true,
      supportsRenameDatabase: true,
      supportsDropDatabase: true,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'gauss-db' })).toMatchObject({
      type: 'gaussdb',
      supportsQueryEditor: true,
      supportsCopyInsert: true,
      supportsRenameDatabase: true,
    });
  });

  it('treats Elasticsearch as a queryable read-only datasource', () => {
    expect(getDataSourceCapabilities({ type: 'elasticsearch' })).toMatchObject({
      type: 'elasticsearch',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'elastic' })).toMatchObject({
      type: 'elasticsearch',
      supportsQueryEditor: true,
      forceReadOnlyQueryResult: false,
    });
  });

  it('treats Chroma as a queryable vector datasource without SQL export actions', () => {
    expect(getDataSourceCapabilities({ type: 'chroma' })).toMatchObject({
      type: 'chroma',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'chromadb' })).toMatchObject({
      type: 'chroma',
      supportsQueryEditor: true,
      supportsCopyInsert: false,
    });
  });

  it('treats Qdrant as a queryable vector datasource without SQL export actions', () => {
    expect(getDataSourceCapabilities({ type: 'qdrant' })).toMatchObject({
      type: 'qdrant',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'qdrantdb' })).toMatchObject({
      type: 'qdrant',
      supportsQueryEditor: true,
      supportsCopyInsert: false,
    });
  });

  it('treats Milvus as a queryable vector datasource without SQL export actions', () => {
    expect(getDataSourceCapabilities({ type: 'milvus' })).toMatchObject({
      type: 'milvus',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'milvus-db' })).toMatchObject({
      type: 'milvus',
      supportsQueryEditor: true,
      supportsCopyInsert: false,
    });
  });

  it('treats Apache IoTDB as a queryable timeseries datasource with IoTDB-specific writes', () => {
    expect(getDataSourceCapabilities({ type: 'iotdb' })).toMatchObject({
      type: 'iotdb',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: true,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'apache-iotdb' })).toMatchObject({
      type: 'iotdb',
      supportsQueryEditor: true,
      supportsCopyInsert: false,
      forceReadOnlyQueryResult: true,
    });
  });

  it('treats RocketMQ as a queryable messaging datasource with manual total count and publish support', () => {
    expect(getDataSourceCapabilities({ type: 'rocketmq' })).toMatchObject({
      type: 'rocketmq',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
      preferManualTotalCount: true,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'rmq' })).toMatchObject({
      type: 'rocketmq',
      supportsQueryEditor: true,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
      preferManualTotalCount: true,
    });
  });

  it('treats MQTT as a queryable messaging datasource with manual total count and publish support', () => {
    expect(getDataSourceCapabilities({ type: 'mqtt' })).toMatchObject({
      type: 'mqtt',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
      preferManualTotalCount: true,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'mqtts' })).toMatchObject({
      type: 'mqtt',
      supportsQueryEditor: true,
      supportsMessagePublish: true,
      preferManualTotalCount: true,
    });
  });

  it('treats Kafka as a queryable read-only messaging datasource', () => {
    expect(getDataSourceCapabilities({ type: 'kafka' })).toMatchObject({
      type: 'kafka',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'apache-kafka' })).toMatchObject({
      type: 'kafka',
      supportsQueryEditor: true,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
    });
  });

  it('forces supported SQL connections marked read-only into query-only mode', () => {
    expect(getDataSourceCapabilities({ type: 'postgres', readOnly: true })).toMatchObject({
      type: 'postgres',
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      supportsMessagePublish: false,
      forceReadOnlyQueryResult: true,
      forceReadOnlyStructureDesigner: true,
    });
  });

  it('allows script execution while still disabling result edits when only data-edit protection is enabled', () => {
    expect(getDataSourceCapabilities({
      type: 'postgres',
      protection: {
        restrictDataEdit: true,
      },
    })).toMatchObject({
      type: 'postgres',
      supportsCreateDatabase: true,
      supportsRenameDatabase: true,
      supportsDropDatabase: true,
      forceReadOnlyQueryResult: true,
      forceReadOnlyStructureDesigner: false,
    });
  });

  it('keeps query results editable while disabling DDL shortcuts when only structure protection is enabled', () => {
    expect(getDataSourceCapabilities({
      type: 'postgres',
      protection: {
        restrictStructureEdit: true,
      },
    })).toMatchObject({
      type: 'postgres',
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
      forceReadOnlyStructureDesigner: true,
    });
  });

  it('ignores readOnly for datasource types that do not support connection-level production guard', () => {
    expect(getDataSourceCapabilities({ type: 'redis', readOnly: true })).toMatchObject({
      type: 'redis',
      supportsQueryEditor: false,
      supportsCreateDatabase: false,
      supportsDropDatabase: false,
      forceReadOnlyQueryResult: false,
      forceReadOnlyStructureDesigner: true,
    });
  });

  it('excludes dedicated-workbench datasources without a query workflow from the query editor', () => {
    expect(getDataSourceCapabilities({ type: 'nacos' }).supportsQueryEditor).toBe(false);
    expect(getDataSourceCapabilities({ type: 'jvm' }).supportsQueryEditor).toBe(false);
    expect(getDataSourceCapabilities({ type: 'redis' }).supportsQueryEditor).toBe(false);
    // 自定义连接驱动指向这些类型时同样排除，避免绕过白名单
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'nacos' }).supportsQueryEditor).toBe(false);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'jvm' }).supportsQueryEditor).toBe(false);
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'redis' }).supportsQueryEditor).toBe(false);
  });

  it('keeps the query editor available for all currently queryable datasource families', () => {
    [
      { type: 'mysql' },
      { type: 'postgres' },
      { type: 'mongodb' },
      { type: 'clickhouse' },
      { type: 'sphinx' },
      { type: 'duckdb' },
      { type: 'sqlite' },
      { type: 'dameng' },
      { type: 'trino' },
      { type: 'tdengine' },
      { type: 'iotdb' },
      { type: 'rocketmq' },
      { type: 'mqtt' },
      { type: 'kafka' },
      { type: 'rabbitmq' },
      { type: 'elasticsearch' },
      { type: 'chroma' },
      { type: 'qdrant' },
      { type: 'milvus' },
      { type: 'custom', driver: 'clickhouse' },
      // 未识别驱动的通用自定义连接仍保留查询入口
      { type: 'custom', driver: 'some-jdbc-driver' },
    ].forEach((config) => {
      expect(getDataSourceCapabilities(config).supportsQueryEditor, JSON.stringify(config)).toBe(true);
    });
  });

  it('treats RabbitMQ as a queryable messaging datasource with publish support', () => {
    expect(getDataSourceCapabilities({ type: 'rabbitmq' })).toMatchObject({
      type: 'rabbitmq',
      supportsQueryEditor: true,
      supportsSqlQueryExport: false,
      supportsCopyInsert: false,
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
    });
    expect(getDataSourceCapabilities({ type: 'custom', driver: 'rabbit-mq' })).toMatchObject({
      type: 'rabbitmq',
      supportsQueryEditor: true,
      supportsMessagePublish: true,
      forceReadOnlyQueryResult: true,
    });
  });

  it('treats OceanBase Oracle protocol as Oracle capabilities', () => {
    expect(getDataSourceCapabilities({
      type: 'oceanbase',
      oceanBaseProtocol: 'oracle',
    })).toMatchObject({
      type: 'oracle',
      preferManualTotalCount: true,
      supportsApproximateTableCount: true,
    });
  });

  it('shows row numbers for OceanBase datasources regardless of protocol normalization', () => {
    expect(shouldShowOceanBaseRowNumberColumn({ type: 'oceanbase' })).toBe(true);
    expect(shouldShowOceanBaseRowNumberColumn({ type: 'oceanbase', oceanBaseProtocol: 'oracle' })).toBe(true);
    expect(shouldShowOceanBaseRowNumberColumn({ type: 'custom', driver: 'oceanbase', oceanBaseProtocol: 'oracle' })).toBe(true);
    expect(shouldShowOceanBaseRowNumberColumn({ type: 'oracle' })).toBe(false);
    expect(shouldShowOceanBaseRowNumberColumn({ type: 'mysql' })).toBe(false);
  });

  it('treats custom OceanBase Oracle driver as Oracle capabilities', () => {
    expect(getDataSourceCapabilities({
      type: 'custom',
      driver: 'oceanbase',
      oceanBaseProtocol: 'oracle',
    })).toMatchObject({
      type: 'oracle',
      preferManualTotalCount: true,
      supportsApproximateTableCount: true,
    });
  });

  it('hides database-level DDL actions for Dameng and Oracle-like datasources', () => {
    expect(getDataSourceCapabilities({ type: 'dameng' })).toMatchObject({
      type: 'dameng',
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
    });
    expect(getDataSourceCapabilities({ type: 'oracle' })).toMatchObject({
      type: 'oracle',
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
    });
    expect(getDataSourceCapabilities({
      type: 'oceanbase',
      oceanBaseProtocol: 'oracle',
    })).toMatchObject({
      type: 'oracle',
      supportsCreateDatabase: false,
      supportsRenameDatabase: false,
      supportsDropDatabase: false,
    });
  });

  it('exposes complete, guided capability contracts to every frontend entry point', () => {
    const redis = getDataSourceCapabilityContract({ type: 'redis' });
    expect(Object.keys(redis).filter((key) => key !== 'type' && key !== 'ui').sort())
      .toEqual([...DATA_SOURCE_CAPABILITY_OPERATIONS].sort());
    expect(redis.query).toMatchObject({
      supported: false,
      reason: 'dedicated_workbench',
      alternative: 'dedicated-workbench',
      messageKey: 'query_editor.message.unsupported_source',
    });
    expect(getDataSourceOperationCapability({ type: 'redis' }, 'query')).toEqual(redis.query);
    expect(getDataSourceCapabilities({ type: 'redis' }).supportsQueryEditor).toBe(redis.query.supported);
  });

  it('keeps undeclared regular types fail-closed while preserving custom runtime probing', () => {
    expect(getDataSourceCapabilityContract({ type: 'future-driver' }).query).toMatchObject({
      supported: false,
      reason: 'capability_not_declared',
      alternative: 'configure-custom-driver',
    });
    expect(getDataSourceCapabilityContract({ type: 'custom', driver: 'future-driver' }).query).toMatchObject({
      supported: true,
      runtimeProbe: true,
    });
  });
});
